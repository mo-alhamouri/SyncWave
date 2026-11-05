// Web Vocal Remover: runs one separation in a background thread so the page
// stays responsive. Uses the graphics chip (WebGPU) when the browser has
// one, otherwise the processor (WebAssembly).
//
// in:  { base, mode, engine: 'gpu' | 'cpu', left, right }  (Float32Array, 44.1 kHz)
// out: { type: 'progress', percent, message }
//      { type: 'done', stems: { name: [left, right] }, engine }
//      { type: 'error', error, retryOnCpu }
import { separate, MODELS, snrDb } from './engine.js';
import { loadModel, getManifest } from './models.js';

const LABEL = { fast: 'Fast', best: 'Best quality' };
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (percent, message) => post({ type: 'progress', percent, message });

// A result this far off (sum of the stems vs. the original) means the
// graphics chip computed garbage; a real separation is ~10-25 dB.
const MIN_SUM_SNR_DB = 6;

class RetryOnCpu extends Error {}

async function loadOrt(base, engine) {
    const ort = await import(/* @vite-ignore */ new URL(`vendor/ort/${engine === 'gpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`, base).href);
    ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    if (engine === 'gpu') ort.env.webgpu.powerPreference = 'high-performance';
    return ort;
}

self.onmessage = async ({ data }) => {
    const { base, mode, engine } = data;
    try {
        const cfg = MODELS[mode];
        if (!cfg) throw new Error('Unknown separation mode.');
        const manifest = await getManifest(base);
        const sizeMB = Math.round(manifest.models[mode].size / 1e6);
        progress(0, 'Getting the AI model ready...');
        const bytes = await loadModel(base, mode, (pct) => progress(pct, `Downloading the ${LABEL[mode]} AI model (one time, ${sizeMB} MB)... ${pct}%`));

        progress(1, 'Loading the AI model...');
        let ort, session;
        try {
            if (engine === 'gpu') {
                if (!navigator.gpu || !(await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))) throw new Error('No graphics chip available.');
            }
            ort = await loadOrt(base, engine);
            session = await ort.InferenceSession.create(bytes, {
                executionProviders: [engine === 'gpu' ? 'webgpu' : 'wasm'],
                graphOptimizationLevel: 'all',
            });
        } catch (e) {
            if (engine === 'gpu') throw new RetryOnCpu(e.message);
            throw e;
        }

        const where = engine === 'gpu' ? ' on the graphics chip' : '';
        const stems = await separate({
            ort, session, mode,
            audio: [data.left, data.right],
            onFirstChunk: engine === 'gpu' ? (chunk, out) => {
                const sum = [new Float32Array(chunk[0].length), new Float32Array(chunk[0].length)];
                for (const st of out) for (let c = 0; c < 2; c++) { const a = st[c], d = sum[c]; for (let i = 0; i < d.length; i++) d[i] += a[i]; }
                const snr = snrDb(chunk, sum);
                if (!(snr >= MIN_SUM_SNR_DB)) throw new RetryOnCpu(`graphics chip result check failed (${snr.toFixed(1)} dB)`);
            } : null,
            onChunk: (k, n) => progress(2 + Math.round((k / n) * 97), `Separating the instruments${where}... (part ${k} of ${n})`),
        });
        try { await session.release(); } catch { /* freed with the worker */ }

        const transfer = [];
        for (const chans of Object.values(stems)) for (const ch of chans) transfer.push(ch.buffer);
        post({ type: 'done', stems, engine }, transfer);
    } catch (e) {
        post({ type: 'error', error: (e && e.message) || String(e), retryOnCpu: e instanceof RetryOnCpu });
    }
};
