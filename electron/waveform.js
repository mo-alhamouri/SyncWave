// Reads a media file's real loudness over time for the Clip Trimmer, so the
// waveform shows loud parts, quiet parts and silence (like mp3cut.net).
//
// FFmpeg decodes the audio to mono 16-bit PCM at a low sample rate (plenty
// for a picture) and we keep the peak and RMS level of each slice.
const { spawn } = require('child_process');

const SAMPLE_RATE = 4000;

function getWaveform(ffmpegPath, file, buckets = 1200) {
    return new Promise((resolve) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']);
        const chunks = [];
        let total = 0;
        p.stdout.on('data', (d) => { chunks.push(d); total += d.length; });
        p.on('error', (e) => resolve({ error: e.message }));
        p.on('close', () => {
            const buf = Buffer.concat(chunks, total);
            const samples = Math.floor(buf.length / 2);
            if (!samples) return resolve({ error: 'This file has no audio track.' });
            const n = Math.min(buckets, samples);
            const per = samples / n;
            const peaks = new Array(n);
            const rms = new Array(n);
            for (let i = 0; i < n; i++) {
                const start = Math.floor(i * per);
                const end = Math.max(start + 1, Math.floor((i + 1) * per));
                let peak = 0, sum = 0;
                for (let s = start; s < end; s++) {
                    const v = Math.abs(buf.readInt16LE(s * 2)) / 32768;
                    if (v > peak) peak = v;
                    sum += v * v;
                }
                peaks[i] = peak;
                rms[i] = Math.sqrt(sum / (end - start));
            }
            // Normalise so quiet recordings still use the full height.
            const max = Math.max(...peaks, 1e-6);
            resolve({
                peaks: peaks.map((v) => +(v / max).toFixed(4)),
                rms: rms.map((v) => +(v / max).toFixed(4)),
                duration: samples / SAMPLE_RATE,
            });
        });
    });
}

module.exports = { getWaveform };
