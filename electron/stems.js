// Vocal Remover / Stem Splitter: main-process side.
//
// - Downloads each AI model the first time it is used, from the SyncWave
//   "models-v1" GitHub release, and checks its SHA-256 before using it.
// - Runs each separation on the graphics chip when it can (gpu.js, about
//   3-4x faster), otherwise in a separate process on the processor
//   (stems-worker.js), and relays progress to the window. The first time a
//   model runs on the graphics chip, its first chunk is compared with the
//   processor's result; if they differ, or anything fails, SyncWave switches
//   to the processor and remembers that for this model.
// - Serves the finished stems to the window and saves single stems or a
//   custom mix to the Downloads folder as MP3 320 kbps.
'use strict';

const { app, ipcMain, utilityProcess } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('./net');
const gpu = require('./gpu');
const { decodeAudio, encodeMp3, snrDb } = require('./stems-engine');

const GPU_MIN_SNR_DB = 30; // the graphics chip measured ~84 dB; garbage is ~0 dB

const MODEL_BASE = 'https://github.com/mo-alhamouri/SyncWave/releases/download/models-v1/';
const MODELS = {
    fast: {
        label: 'Fast', file: 'htdemucs_6s.onnx', size: 114560331,
        sha256: 'bb4eee07e48847fdc0d93190f74b5a4b52525ccbfb2a3024261c3a9c6f6b9077',
    },
    best: {
        // Same weights as bs_roformer_sw_6stem_fp16.onnx (v1.3.0) with the attention
        // Einsums rewritten as MatMul: identical output, ~15% faster on CPU.
        label: 'Best quality', file: 'bs_roformer_sw_6stem_fp16_mm.onnx', size: 352781094,
        sha256: 'b0df0d59c4767d3a6e2252f7025bd1a30e2a49d590c97e04dd4b5908957270b9',
    },
};

let ctx = null;        // { send, waitForEngine, getFfmpegPath, getDownloadsDir }
let modelsDir = '';
let stemsRoot = '';
let job = null;        // the running separation
const downloading = {}; // mode -> Promise (one download per model at a time)

const mb = (bytes) => Math.round(bytes / 1e6);
const inside = (root, p) => {
    const r = path.resolve(p);
    return r === root || r.startsWith(root + path.sep);
};

function modelPath(mode) { return path.join(modelsDir, MODELS[mode].file); }

function isModelReady(mode) {
    const p = modelPath(mode);
    try { return fs.statSync(p).size === MODELS[mode].size && fs.existsSync(`${p}.verified`); } catch { return false; }
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

async function ensureModel(mode, onProgress) {
    if (isModelReady(mode)) return modelPath(mode);
    if (!downloading[mode]) {
        downloading[mode] = (async () => {
            const m = MODELS[mode], dest = modelPath(mode);
            fs.mkdirSync(modelsDir, { recursive: true });
            try { fs.unlinkSync(`${dest}.verified`); } catch { /* not there */ }
            await net.download(MODEL_BASE + m.file, dest, (pct) => onProgress && onProgress(pct));
            onProgress && onProgress(100, 'Checking the download...');
            const hash = await sha256(dest);
            if (hash !== m.sha256) {
                try { fs.unlinkSync(dest); } catch { /* already gone */ }
                throw new Error('The downloaded AI model is damaged. Please try again.');
            }
            fs.writeFileSync(`${dest}.verified`, hash);
            return dest;
        })().finally(() => { delete downloading[mode]; });
    }
    return downloading[mode];
}

// Delete model files the current version no longer uses (e.g. the v1.3.0
// Best quality model), so an update never leaves 350 MB behind.
function removeOldModels() {
    const keep = new Set(Object.values(MODELS).flatMap((m) => [m.file, `${m.file}.verified`]));
    let entries = [];
    try { entries = fs.readdirSync(modelsDir); } catch { return; }
    for (const f of entries) {
        if (!keep.has(f)) { try { fs.rmSync(path.join(modelsDir, f), { force: true }); } catch { /* in use or gone */ } }
    }
}

function clearOldStems() {
    try { fs.rmSync(stemsRoot, { recursive: true, force: true }); } catch { /* nothing to clear */ }
}

// --- Graphics chip state, remembered per app version and model ---
// { "1.4.0:<engine>:best": "ok" | "failed", ...:reason, ...:failedAt }
// - "ok": passed the one-time check.
// - "failed": a real problem (wrong result, crash...). The processor is used,
//   and the graphics chip is tried again after GPU_RETRY_DAYS or an update.
// - A graphics chip that is briefly unavailable (e.g. macOS still switching
//   to it) is not remembered as failed until it happens GPU_MAX_MISSES times in a row.
const GPU_RETRY_DAYS = 7;
const GPU_MAX_MISSES = 3;
function gpuStateFile() { return path.join(app.getPath('userData'), 'gpu-check.json'); }
function readGpuState() {
    try { return JSON.parse(fs.readFileSync(gpuStateFile(), 'utf8')) || {}; } catch { return {}; }
}
function gpuKey(mode) { return `${app.getVersion()}:${gpu.ENGINE_ID}:${mode}`; }
function writeGpuState(state) {
    try { fs.writeFileSync(gpuStateFile(), JSON.stringify(state, null, 2)); } catch { /* not critical */ }
}
function setGpuState(mode, value, reason) {
    const state = readGpuState(), k = gpuKey(mode);
    state[k] = value;
    if (reason) state[`${k}:reason`] = String(reason).slice(0, 300);
    if (value === 'failed') state[`${k}:failedAt`] = new Date().toISOString();
    else delete state[`${k}:failedAt`];
    delete state[`${k}:misses`];
    writeGpuState(state);
}
// A brief "no graphics chip" counts as a miss; only repeated misses mark it failed.
function recordGpuMiss(mode, reason) {
    const state = readGpuState(), k = gpuKey(mode);
    const misses = (Number(state[`${k}:misses`]) || 0) + 1;
    if (misses >= GPU_MAX_MISSES) { setGpuState(mode, 'failed', reason); return; }
    state[`${k}:misses`] = misses;
    state[`${k}:reason`] = String(reason).slice(0, 300);
    writeGpuState(state);
}
function gpuBlocked(mode) {
    if (process.env.SYNCWAVE_GPU_RETRY) return false;
    const state = readGpuState(), k = gpuKey(mode);
    if (state[k] !== 'failed') return false;
    const at = Date.parse(state[`${k}:failedAt`] || '');
    return Number.isFinite(at) && Date.now() - at < GPU_RETRY_DAYS * 864e5;
}

// Run one job on the processor in a utilityProcess. onMessage(msg, finish) handles
// the worker's messages; resolves with whatever finish() is called with.
function runWorker(thisJob, message, onMessage) {
    return new Promise((resolve) => {
        const child = utilityProcess.fork(path.join(__dirname, 'stems-worker.js'), [], { serviceName: 'SyncWave Stem Splitter' });
        thisJob.children.add(child);
        let settled = false;
        const finish = (r) => {
            if (settled) return;
            settled = true;
            thisJob.children.delete(child);
            try { child.kill(); } catch { /* exited */ }
            resolve(r);
        };
        child.on('message', (msg) => {
            if (msg.type === 'error') finish({ error: msg.error });
            else onMessage(msg, finish);
        });
        child.on('exit', (code) => finish(thisJob.cancelled ? { cancelled: true } : { error: `The separation stopped unexpectedly (code ${code}). Your computer may be low on memory.` }));
        child.postMessage(message);
    });
}

function runOnProcessor(thisJob, base, send) {
    return runWorker(thisJob, { type: 'separate', ...base }, (msg, finish) => {
        if (msg.type === 'progress') send('stems-progress', { percent: msg.percent, message: msg.message });
        else if (msg.type === 'done') finish({ success: true, stems: msg.result.stems, duration: msg.result.duration });
    });
}

// One-time check: the same first chunk on the processor must match the graphics chip.
async function checkAgainstProcessor(thisJob, base, chunk, out, send) {
    send('stems-progress', { percent: 3, message: 'Checking the graphics chip (one time only)...' });
    const r = await runWorker(thisJob, { type: 'chunk', mode: base.mode, modelPath: base.modelPath, chunk }, (msg, finish) => {
        if (msg.type === 'chunk-done') finish({ out: msg.out });
    });
    if (!r.out) return { ok: false, error: r.cancelled ? 'Cancelled' : r.error };
    const snr = snrDb(r.out, out);
    if (!(snr >= GPU_MIN_SNR_DB)) return { ok: false, error: `The graphics chip result differs from the processor (${snr.toFixed(1)} dB).` };
    return { ok: true, snr };
}

async function runOnGraphicsChip(thisJob, base, send) {
    const needsCheck = readGpuState()[gpuKey(base.mode)] !== 'ok';
    let checked = null;
    const runner = gpu.run({ ...base, check: needsCheck }, {
        onProgress: (percent, message) => send('stems-progress', { percent, message }),
        onCheck: async (chunk, out) => {
            const r = await checkAgainstProcessor(thisJob, base, chunk, out, send);
            if (r.ok) checked = r.snr;
            return r;
        },
    });
    thisJob.gpu = runner;
    const result = await runner.promise;
    thisJob.gpu = null;
    if (result.success && checked !== null) setGpuState(base.mode, 'ok', `${checked.toFixed(1)} dB`);
    else if (result.success) { // clear any earlier brief misses
        const state = readGpuState(), k = gpuKey(base.mode);
        if (state[`${k}:misses`]) { delete state[`${k}:misses`]; writeGpuState(state); }
    }
    return result;
}

async function separate(filePath, mode) {
    if (!MODELS[mode]) return { error: 'Unknown separation mode.' };
    if (job) return { error: 'A separation is already running.' };
    if (!filePath || !fs.existsSync(filePath)) return { error: 'That file could not be found.' };
    // Progress goes to the window, and is logged with timings (shown in the
    // terminal when running from source) to compare graphics chip vs processor.
    const t0 = Date.now();
    let lastPart = t0;
    const send = (channel, p) => {
        if (channel === 'stems-progress' && p && p.message && !/Downloading/.test(p.message)) {
            const now = Date.now();
            const part = /\(part \d+ of \d+\)/.test(p.message) ? ` (+${((now - lastPart) / 1000).toFixed(1)} s)` : '';
            if (part) lastPart = now;
            console.log(`[stems] ${((now - t0) / 1000).toFixed(1)} s: ${p.message}${part}`);
        }
        ctx.send(channel, p);
    };
    const thisJob = { cancelled: false, children: new Set(), gpu: null };
    job = thisJob;
    try {
        await ctx.waitForEngine();
        const m = MODELS[mode];
        let model;
        try {
            model = await ensureModel(mode, (pct, msg) => send('stems-progress', {
                percent: pct,
                message: msg || `Downloading the ${m.label} AI model (one time, ${mb(m.size)} MB)... ${pct}%`,
            }));
        } catch (e) {
            return thisJob.cancelled ? { cancelled: true } : { error: `Could not download the AI model: ${e.message}` };
        }
        if (thisJob.cancelled) return { cancelled: true };

        clearOldStems(); // keep only the current song's stems on disk
        const outDir = path.join(stemsRoot, `job-${Date.now()}`);
        const base = { mode, modelPath: model, input: filePath, outDir, ffmpegPath: ctx.getFfmpegPath() };

        // SYNCWAVE_GPU_RETRY=1 tries the graphics chip again even after a failure (testing).
        if (gpu.isAvailable() && !gpuBlocked(mode)) {
            const r = await runOnGraphicsChip(thisJob, base, send);
            if (r.success) { console.log(`[stems] ${mode} finished on the graphics chip in ${((Date.now() - t0) / 1000).toFixed(0)} s`); return { ...r, mode, engine: 'gpu' }; }
            if (r.cancelled || thisJob.cancelled) return { cancelled: true };
            console.warn('[stems] Graphics chip failed, using the processor:', r.error);
            if (r.soft) recordGpuMiss(mode, r.error);
            else setGpuState(mode, 'failed', r.error);
            try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* nothing written */ }
            send('stems-progress', { percent: 0, message: 'Switching to the processor...' });
        }

        const why = readGpuState()[`${gpuKey(mode)}:reason`];
        console.log(`[stems] ${mode} running on the processor${gpu.isAvailable() && why ? `. Graphics chip failed earlier: ${why}` : ''}`);
        const r = await runOnProcessor(thisJob, base, send);
        if (r.success) console.log(`[stems] ${mode} finished on the processor in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        return r.success ? { ...r, mode, engine: 'cpu' } : r;
    } finally {
        if (job === thisJob) job = null;
    }
}

function cancel() {
    if (!job) return;
    job.cancelled = true;
    if (job.gpu) job.gpu.cancel();
    for (const child of job.children) { try { child.kill(); } catch { /* already gone */ } }
}

function uniquePath(dir, base, ext) {
    let p = path.join(dir, `${base}${ext}`);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
    return p;
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Song';

async function exportStems(paths, baseName, label) {
    if (!Array.isArray(paths) || !paths.length) return { error: 'Choose at least one track to save.' };
    if (!paths.every((p) => inside(stemsRoot, p) && fs.existsSync(p))) return { error: 'Those tracks are no longer available. Separate the song again.' };
    const dest = uniquePath(ctx.getDownloadsDir(), `${safeName(baseName)} (${safeName(label)})`, '.mp3');
    try {
        if (paths.length === 1) {
            fs.copyFileSync(paths[0], dest); // already MP3 320 kbps
        } else {
            // Decode, add together and encode once: an exact mix of the stems.
            const ffmpeg = ctx.getFfmpegPath();
            let mix = null;
            for (const p of paths) {
                const chans = await decodeAudio(ffmpeg, p);
                if (!mix) mix = chans;
                else for (let c = 0; c < 2; c++) { const a = mix[c], b = chans[c], n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) a[i] += b[i]; }
            }
            await encodeMp3(ffmpeg, mix, dest);
        }
        return { success: true, name: path.basename(dest), path: dest };
    } catch (e) {
        try { fs.unlinkSync(dest); } catch { /* nothing written */ }
        return { error: `Saving failed: ${e.message}` };
    }
}

function init(options) {
    ctx = options;
    modelsDir = path.join(app.getPath('userData'), 'models');
    stemsRoot = path.join(app.getPath('userData'), 'stems');
    clearOldStems(); // stems from a previous session
    removeOldModels();

    ipcMain.handle('stems-models', () => Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { label: m.label, sizeMB: mb(m.size), ready: isModelReady(k) }])));
    ipcMain.handle('stems-separate', (e, filePath, mode) => separate(filePath, mode));
    ipcMain.on('stems-cancel', () => cancel());
    ipcMain.handle('stems-read', async (e, p) => {
        if (!inside(stemsRoot, p)) throw new Error('Not a stem file.');
        return fs.promises.readFile(p);
    });
    ipcMain.handle('stems-export', (e, paths, baseName, label) => exportStems(paths, baseName, label));
    app.on('before-quit', () => cancel());
}

module.exports = { init, cancel, MODELS };
