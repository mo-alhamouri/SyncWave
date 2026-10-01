// Makes downloaded MP4s play everywhere on macOS (Finder, Quick Look,
// QuickTime) as fast as possible.
//
// v1.2.9: SyncWave used to re-encode every video with the CPU (libx264),
// which on an Intel Mac could take longer than the video itself. Now:
//   1. yt-dlp is asked for YouTube's H.264 + AAC streams, which are already
//      Mac-compatible, so they're just packed into an MP4 (seconds).
//   2. Only if the file still isn't H.264/AAC do we convert it, using the
//      Mac's hardware encoder (VideoToolbox) when available, otherwise a fast
//      libx264 preset.
const { spawn, execFile } = require('child_process');
const fs = require('fs');

let hwEncoder = null; // cached: 'h264_videotoolbox' | false
let activeProc = null;

function probe(ffprobePath, file) {
    return new Promise((resolve) => {
        execFile(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height:format=duration', '-of', 'json', file],
            { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const j = JSON.parse(stdout);
                    const v = (j.streams || []).find((s) => s.codec_type === 'video');
                    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
                    resolve({
                        video: v ? v.codec_name : null,
                        height: v ? v.height : 0,
                        audio: a ? a.codec_name : null,
                        duration: parseFloat((j.format || {}).duration) || 0,
                    });
                } catch (e) { resolve(null); }
            });
    });
}

// Check once whether this Mac's FFmpeg can use the hardware H.264 encoder.
function detectHardwareEncoder(ffmpegPath) {
    if (hwEncoder !== null) return Promise.resolve(hwEncoder);
    if (process.platform !== 'darwin') { hwEncoder = false; return Promise.resolve(false); }
    return new Promise((resolve) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2',
            '-c:v', 'h264_videotoolbox', '-b:v', '1M', '-f', 'null', '-']);
        const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 15000);
        p.on('error', () => { clearTimeout(timer); hwEncoder = false; resolve(false); });
        p.on('close', (code) => { clearTimeout(timer); hwEncoder = code === 0 ? 'h264_videotoolbox' : false; console.log('[convert] hardware encoder:', hwEncoder || 'not available'); resolve(hwEncoder); });
    });
}

function runFfmpeg(ffmpegPath, args, duration, onProgress) {
    return new Promise((resolve) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args]);
        activeProc = p;
        let err = '';
        p.stdout.on('data', (d) => {
            const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
            if (m && duration && onProgress) {
                const us = parseInt(m[m.length - 1].split('=')[1], 10);
                onProgress(Math.min(99, Math.round((us / 1e6 / duration) * 100)));
            }
        });
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', (e) => { activeProc = null; resolve({ ok: false, err: e.message }); });
        p.on('close', (code) => { activeProc = null; resolve({ ok: code === 0, err }); });
    });
}

// Takes the merged download (.mkv or .mp4) and produces a Mac-compatible
// .mp4 next to it. Returns { output, method }; the input file is removed.
async function ensureMacCompatible(file, { ffmpegPath, ffprobePath, onProgress = () => {} }) {
    const info = await probe(ffprobePath, file);
    if (!info) throw new Error('Could not read the downloaded video.');
    const videoOk = !info.video || info.video === 'h264';
    const audioOk = !info.audio || info.audio === 'aac';
    const isMp4 = /\.mp4$/i.test(file);
    const target = file.replace(/\.(mkv|mp4|webm)$/i, '') + '.mp4';
    if (videoOk && audioOk && isMp4) return { output: file, method: 'none' };

    const out = target.replace(/\.mp4$/i, '.converting.mp4');
    const audioArgs = audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
    const base = ['-y', '-i', file, '-map', '0:v:0?', '-map', '0:a:0?'];
    const tail = [...audioArgs, '-movflags', '+faststart', out];

    const attempts = [];
    if (videoOk && audioOk) {
        attempts.push({ method: 'repack', args: [...base, '-c:v', 'copy', ...tail] });
    } else if (videoOk) {
        attempts.push({ method: 'audio-only', args: [...base, '-c:v', 'copy', ...tail] });
    } else {
        const h = info.height || 1080;
        const bitrate = h >= 1080 ? '8M' : h >= 720 ? '5M' : '3M';
        const hw = await detectHardwareEncoder(ffmpegPath);
        if (hw) attempts.push({ method: 'hardware', args: [...base, '-c:v', hw, '-b:v', bitrate, '-maxrate', bitrate, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', ...tail] });
        attempts.push({ method: 'software', args: [...base, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', ...tail] });
    }

    for (const a of attempts) {
        console.log(`[convert] ${a.method}: ${info.video}/${info.audio} -> h264/aac`);
        const r = await runFfmpeg(ffmpegPath, a.args, info.duration, onProgress);
        if (r.ok && fs.existsSync(out)) {
            if (file !== target) { try { fs.unlinkSync(file); } catch (e) {} }
            fs.renameSync(out, target);
            return { output: target, method: a.method };
        }
        try { fs.unlinkSync(out); } catch (e) {}
        if (r.err === 'stopped') break;
        console.warn(`[convert] ${a.method} failed:`, String(r.err).slice(-300));
    }
    throw new Error('Could not convert the video to a Mac-compatible format.');
}

function stop() {
    if (activeProc) { try { activeProc.kill('SIGKILL'); } catch (e) {} activeProc = null; }
}

module.exports = { ensureMacCompatible, stop, probe };
