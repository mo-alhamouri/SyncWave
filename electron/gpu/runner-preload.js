// Preload of the hidden graphics-chip window (see ../gpu.js).
// The page loads ONNX Runtime Web and calls window.__syncwaveOrt(ort); this
// script then runs the same separation engine as the processor path, but
// with a WebGPU session. Reading/writing audio still goes through FFmpeg.
'use strict';

const { ipcRenderer } = require('electron');
const fs = require('fs');
const engine = require('../stems-engine');

let ort = null;
let job = null;
let started = false;
let checkResolve = null;

const send = (msg) => ipcRenderer.send('gpu-runner', msg);
const copyOut = (out) => out.map((st) => st.map((ch) => ch.slice()));

window.__syncwaveOrt = (o, err) => {
    if (err) { send({ type: 'error', error: `Could not load the graphics engine: ${err.message || err}` }); return; }
    ort = o;
    start();
};
ipcRenderer.once('gpu-job', (e, j) => { job = j; start(); });
ipcRenderer.on('gpu-check-result', (e, r) => { if (checkResolve) { const f = checkResolve; checkResolve = null; f(r); } });

async function start() {
    if (!ort || !job || started) return;
    started = true;
    try {
        if (!navigator.gpu) throw new Error('WebGPU is not available on this computer.');
        // macOS can take a moment to power up the graphics chip, so a first
        // request may come back empty: try a few times before giving up.
        let adapter = null;
        for (let i = 0; i < 5 && !adapter; i++) {
            if (i) await new Promise((r) => setTimeout(r, 1000 * i));
            adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        }
        if (!adapter) { send({ type: 'error', error: 'No usable graphics chip was found.', soft: true }); return; }
        const describe = (info) => (info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown' : 'unknown');
        send({ type: 'log', message: `High-performance adapter: ${describe(adapter.info)}` });

        ort.env.wasm.wasmPaths = 'syncwave-gpu://app/ort/';
        ort.env.wasm.numThreads = self.crossOriginIsolated
            ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
        ort.env.webgpu.powerPreference = 'high-performance';

        const result = await engine.separate({
            ort,
            mode: job.mode,
            input: job.input,
            outDir: job.outDir,
            ffmpegPath: job.ffmpegPath,
            where: ' on the graphics chip',
            createSession: async () => {
                const buf = fs.readFileSync(job.modelPath);
                const t0 = Date.now();
                const session = await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), {
                    executionProviders: ['webgpu'], graphOptimizationLevel: 'all',
                });
                const dev = ort.env.webgpu && ort.env.webgpu.device;
                send({ type: 'log', message: `Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s. ONNX Runtime is using: ${describe(dev && dev.adapterInfo)}. Threads: ${ort.env.wasm.numThreads}` });
                return session;
            },
            onFirstChunk: job.check ? async (chunk, out) => {
                const r = await new Promise((resolve) => {
                    checkResolve = resolve;
                    send({ type: 'check', chunk: chunk.map((c) => c.slice()), out: copyOut(out) });
                });
                if (!r || !r.ok) throw new Error((r && r.error) || 'The graphics chip check failed.');
            } : null,
            onProgress: (percent, message) => send({ type: 'progress', percent, message }),
        });
        send({ type: 'done', result });
    } catch (err) {
        send({ type: 'error', error: (err && err.message) || String(err) });
    }
}
