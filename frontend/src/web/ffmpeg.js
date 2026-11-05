// FFmpeg in the browser (ffmpeg.wasm), loaded the first time it is needed.
// Used to trim clips (same commands as the desktop app) and to save
// stems as MP3 (320 kbps). The core files are published with the site under
// vendor/ffmpeg/ (see scripts/build-web.sh).
import { FFmpeg } from '@ffmpeg/ffmpeg';

let loading = null;
let busy = Promise.resolve(); // one FFmpeg job at a time

function getFFmpeg(base) {
    if (!loading) {
        loading = (async () => {
            const ff = new FFmpeg();
            await ff.load({
                coreURL: new URL('vendor/ffmpeg/ffmpeg-core.js', base).href,
                wasmURL: new URL('vendor/ffmpeg/ffmpeg-core.wasm', base).href,
            });
            return ff;
        })().catch((e) => { loading = null; throw new Error(`Could not load the audio/video engine (${e.message || e}).`); });
    }
    return loading;
}

function queue(job) {
    const run = busy.then(job, job);
    busy = run.catch(() => {});
    return run;
}

/** Encode [left, right] Float32Arrays (44.1 kHz) to an MP3 320 kbps Blob. */
export function encodeMp3(base, chans, sampleRate = 44100) {
    return queue(async () => {
        const ff = await getFFmpeg(base);
        const n = chans[0].length;
        const inter = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { inter[2 * i] = chans[0][i]; inter[2 * i + 1] = chans[1][i]; }
        await ff.writeFile('in.f32', new Uint8Array(inter.buffer));
        try {
            const code = await ff.exec(['-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', 'in.f32', '-c:a', 'libmp3lame', '-b:a', '320k', 'out.mp3']);
            if (code !== 0) throw new Error(`MP3 encoding failed (error ${code}).`);
            const data = await ff.readFile('out.mp3');
            return new Blob([data], { type: 'audio/mpeg' });
        } finally {
            await ff.deleteFile('in.f32').catch(() => {});
            await ff.deleteFile('out.mp3').catch(() => {});
        }
    });
}

/**
 * Trim a File between start and end (seconds), like the desktop app:
 * MP3 in -> MP3 out (no re-encoding); anything else -> MP4 (video copied,
 * audio as AAC). Returns { blob, name }.
 */
export function trimFile(base, file, start, end) {
    return queue(async () => {
        const ff = await getFFmpeg(base);
        const ext = /\.mp3$/i.test(file.name) ? 'mp3' : 'mp4';
        const out = `out.${ext}`;
        // Mount the file instead of copying it into memory (handles big videos).
        await ff.createDir('/in').catch(() => {});
        await ff.mount('WORKERFS', { files: [file] }, '/in');
        try {
            const args = ['-y', '-ss', String(start), '-to', String(end), '-i', `/in/${file.name}`];
            if (ext === 'mp4') args.push('-c:v', 'copy', '-c:a', 'aac');
            else args.push('-c', 'copy');
            args.push(out);
            const code = await ff.exec(args);
            if (code !== 0) throw new Error(`Trimming failed (error ${code}). This file may not be supported in the browser; the desktop app handles more formats.`);
            const data = await ff.readFile(out);
            const baseName = file.name.replace(/\.[^.]+$/, '');
            return { blob: new Blob([data], { type: ext === 'mp3' ? 'audio/mpeg' : 'video/mp4' }), name: `${baseName} Trimmed.${ext}` };
        } finally {
            await ff.unmount('/in').catch(() => {});
            await ff.deleteFile(out).catch(() => {});
        }
    });
}

/** Save a Blob to the user's Downloads folder. */
export function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
