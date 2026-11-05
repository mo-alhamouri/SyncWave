// Browser stand-in for the desktop app's window.electron API, so the web
// version can reuse the app's Vocal Remover screen (StemSplitter.jsx).
// Files stay in this browser tab: nothing is uploaded anywhere.
import { isModelCached, getManifest } from './models.js';
import { encodeMp3, saveBlob } from './ffmpeg.js';

const SAMPLE_RATE = 44100;
const MAX_SECONDS = 20 * 60; // longer songs need more memory than a browser tab has

// Folder the web app is published in (models/ and vendor/ live there).
export const BASE = new URL('./', document.baseURI).href;

// --- Files the user picked: "path" is just an id for the File ---
const files = new Map();
let nextId = 1;
export function registerFile(file) {
    const id = `file:${nextId++}`;
    files.set(id, file);
    return id;
}
export const getFile = (id) => files.get(id);

export function pickFile(accept) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        const done = (f) => { input.remove(); resolve(f ? { path: registerFile(f), name: f.name } : null); };
        input.addEventListener('change', () => done(input.files && input.files[0]));
        input.addEventListener('cancel', () => done(null));
        input.click();
    });
}

// --- Audio helpers ---
/** Decode any audio/video file the browser can read to [left, right] at 44.1 kHz. */
export async function decodeFile(file) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate: SAMPLE_RATE });
    try {
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        const left = buf.getChannelData(0);
        const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
        return { left: new Float32Array(left), right: new Float32Array(right), duration: buf.duration };
    } catch {
        throw new Error('Your browser could not read this file. Try an MP3, WAV or M4A, or use the desktop app (it reads more formats).');
    } finally {
        ctx.close().catch(() => {});
    }
}

/** Peaks and RMS per bucket, 0..1 (like the desktop app's waveform). */
export function waveform(chans, buckets = 1200, normalize = true) {
    const n = chans[0].length, per = Math.max(1, Math.floor(n / buckets));
    const count = Math.min(buckets, Math.ceil(n / per));
    const peaks = new Array(count), rms = new Array(count);
    for (let b = 0; b < count; b++) {
        let pk = 0, sq = 0, k = 0;
        for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) {
            const v = chans.length > 1 ? (chans[0][i] + chans[1][i]) / 2 : chans[0][i];
            const a = Math.abs(v);
            if (a > pk) pk = a;
            sq += v * v; k++;
        }
        peaks[b] = pk; rms[b] = Math.sqrt(sq / Math.max(1, k));
    }
    if (normalize) {
        const max = Math.max(1e-6, ...peaks);
        for (let b = 0; b < count; b++) { peaks[b] /= max; rms[b] /= max; }
    }
    return { peaks, rms, duration: n / SAMPLE_RATE };
}

// 32-bit float WAV, so the page can play a stem exactly as computed.
function wavBytes(chans) {
    const n = chans[0].length, dataBytes = n * 2 * 4;
    const buf = new ArrayBuffer(44 + dataBytes), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true);
    v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 8, true); v.setUint16(32, 8, true); v.setUint16(34, 32, true);
    str(36, 'data'); v.setUint32(40, dataBytes, true);
    const out = new Float32Array(buf, 44, n * 2);
    for (let i = 0; i < n; i++) { out[2 * i] = chans[0][i]; out[2 * i + 1] = chans[1][i]; }
    return new Uint8Array(buf);
}

// --- Graphics chip support ---
let gpuPromise = null;
export function hasGpu() {
    if (!gpuPromise) {
        gpuPromise = (async () => {
            try { return !!(navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })); } catch { return false; }
        })();
    }
    return gpuPromise;
}

// --- Vocal Remover ---
const stems = new Map(); // 'stem:<name>' -> [left, right]
const progressListeners = new Set();
const emit = (p) => progressListeners.forEach((fn) => fn(p));
let job = null;

function runWorker(msg) {
    return new Promise((resolve) => {
        const worker = new Worker(new URL('./separate.worker.js', import.meta.url), { type: 'module' });
        const finish = (r) => { worker.terminate(); if (job && job.worker === worker) job.worker = null; resolve(r); };
        job.worker = worker;
        job.finish = finish;
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') emit({ percent: data.percent, message: data.message });
            else if (data.type === 'done') finish({ stems: data.stems, engine: data.engine });
            else if (data.type === 'error') finish({ error: data.error, retryOnCpu: data.retryOnCpu });
        };
        worker.onerror = (e) => finish({ error: e.message || 'The separation stopped unexpectedly. Your browser may be low on memory.', retryOnCpu: msg.engine === 'gpu' });
        // Copies, so the decoded song can be reused if the graphics chip fails.
        worker.postMessage({ ...msg, left: msg.left.slice(), right: msg.right.slice() });
    });
}

async function separateStems(path, mode) {
    if (job) return { error: 'A separation is already running.' };
    const file = files.get(path);
    if (!file) return { error: 'That file could not be found. Please choose it again.' };
    const thisJob = { cancelled: false, worker: null, finish: null };
    job = thisJob;
    try {
        emit({ percent: 0, message: 'Reading the song...' });
        const audio = await decodeFile(file);
        if (audio.duration > MAX_SECONDS) return { error: 'This song is longer than 20 minutes. Please use the desktop app for long files.' };
        if (thisJob.cancelled) return { cancelled: true };

        const gpu = await hasGpu();
        let r = await runWorker({ base: BASE, mode, engine: gpu ? 'gpu' : 'cpu', left: audio.left, right: audio.right });
        if (thisJob.cancelled) return { cancelled: true };
        if (r.error && r.retryOnCpu) {
            console.warn('[SyncWave] Graphics chip failed:', r.error);
            if (mode === 'best') return { error: 'Best quality could not use your graphics chip in this browser. Try Fast, or the desktop app.' };
            emit({ percent: 0, message: 'Switching to the processor...' });
            r = await runWorker({ base: BASE, mode, engine: 'cpu', left: audio.left, right: audio.right });
            if (thisJob.cancelled) return { cancelled: true };
        }
        if (r.error) return { error: r.error };

        stems.clear();
        const paths = {};
        for (const [name, chans] of Object.entries(r.stems)) { stems.set(`stem:${name}`, chans); paths[name] = `stem:${name}`; }
        return { success: true, stems: paths, duration: audio.duration, mode, engine: r.engine };
    } catch (e) {
        return thisJob.cancelled ? { cancelled: true } : { error: e.message || String(e) };
    } finally {
        if (job === thisJob) job = null;
    }
}

function cancelStems() {
    if (!job) return;
    job.cancelled = true;
    if (job.finish) job.finish({ cancelled: true });
}

async function getStemModels() {
    const gpu = await hasGpu();
    let manifest = null;
    try { manifest = await getManifest(BASE); } catch { /* shown when separating */ }
    const info = async (mode, label, extra) => ({
        label,
        sizeMB: manifest ? Math.round(manifest.models[mode].size / 1e6) : (mode === 'fast' ? 115 : 353),
        ready: await isModelCached(BASE, mode),
        ...extra,
    });
    return {
        fast: await info('fast', 'Fast', gpu ? {} : { time: 'About 4–8 minutes per song in this browser' }),
        best: await info('best', 'Best quality', gpu ? {} : {
            disabled: true,
            note: 'Needs a browser that can use your graphics chip (Chrome, Edge or Safari), or the desktop app.',
        }),
    };
}

async function exportStems(paths, baseName, label) {
    const list = paths.map((p) => stems.get(p));
    if (!list.length || list.some((s) => !s)) return { error: 'Those tracks are no longer available. Separate the song again.' };
    try {
        let mix = list[0];
        if (list.length > 1) {
            const n = list[0][0].length;
            mix = [new Float32Array(n), new Float32Array(n)];
            for (const s of list) for (let c = 0; c < 2; c++) { const a = s[c], d = mix[c]; for (let i = 0; i < n; i++) d[i] += a[i]; }
        }
        const blob = await encodeMp3(BASE, mix, SAMPLE_RATE);
        const clean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Song';
        const name = `${clean(baseName)} (${clean(label)}).mp3`;
        saveBlob(blob, name);
        return { success: true, name };
    } catch (e) {
        return { error: `Saving failed: ${e.message || e}` };
    }
}

/** Install window.electron for the reused desktop components. */
export function installPlatform() {
    window.electron = {
        isWeb: true,
        selectFile: () => pickFile('audio/*,video/*,.mp3,.wav,.m4a,.flac,.ogg,.opus,.aac,.mp4,.mov,.m4v,.mkv,.webm'),
        getPathForFile: (f) => registerFile(f),
        getStemModels,
        separateStems,
        cancelStems,
        onStemsProgress: (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); },
        readStemFile: async (p) => {
            const s = stems.get(p);
            if (!s) throw new Error('Not a stem.');
            return wavBytes(s);
        },
        getWaveform: async (p, opts) => {
            const s = stems.get(p);
            if (!s) return { error: 'Not a stem.' };
            return waveform(s, 1200, !(opts && opts.raw));
        },
        exportStems,
    };
}
