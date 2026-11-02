// Runs a stem separation on the graphics chip (WebGPU) inside a hidden
// window, using the Chromium that is built into Electron. This is about
// 3-4x faster than the processor on most computers.
//
// - The window is never shown and loads only the app's own files, served
//   over a private "syncwave-gpu://" address (no internet, no web pages).
// - stems.js decides when to use it and falls back to the processor if
//   anything goes wrong.
'use strict';

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const SCHEME = 'syncwave-gpu';
// Must run before the app is ready (this module is loaded at startup).
protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// ONNX Runtime Web. Two builds of its graphics engine:
//   webgpu - ort.webgpu bundle, the newer native WebGPU engine (default)
//   jsep   - ort.min.mjs default bundle, the older JavaScript WebGPU engine
// SYNCWAVE_GPU_ENGINE=jsep picks the older one (for testing; a packaged app
// only contains the default one).
const ORT_DIR = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const BUNDLES = {
    webgpu: { mjs: 'ort.webgpu.min.mjs', wasm: 'ort-wasm-simd-threaded.asyncify' },
    jsep: { mjs: 'ort.min.mjs', wasm: 'ort-wasm-simd-threaded.jsep' },
};
const BUNDLE = BUNDLES[process.env.SYNCWAVE_GPU_ENGINE] ? process.env.SYNCWAVE_GPU_ENGINE : 'webgpu';
const FILES = {
    '/runner.html': [path.join(__dirname, 'gpu', 'runner.html'), 'text/html; charset=utf-8'],
    '/ort/ort.mjs': [path.join(ORT_DIR, BUNDLES[BUNDLE].mjs), 'text/javascript'],
    [`/ort/${BUNDLES[BUNDLE].wasm}.mjs`]: [path.join(ORT_DIR, `${BUNDLES[BUNDLE].wasm}.mjs`), 'text/javascript'],
    [`/ort/${BUNDLES[BUNDLE].wasm}.wasm`]: [path.join(ORT_DIR, `${BUNDLES[BUNDLE].wasm}.wasm`), 'application/wasm'],
};
// These headers let the page use several processor threads for the small
// parts of the model that do not run on the graphics chip.
const HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
};

let protocolReady = false;
function ensureProtocol() {
    if (protocolReady) return;
    protocolReady = true;
    protocol.handle(SCHEME, async (request) => {
        const url = new URL(request.url);
        const entry = url.host === 'app' ? FILES[url.pathname] : null;
        if (!entry) return new Response('Not found', { status: 404 });
        try {
            const body = await fs.promises.readFile(entry[0]);
            return new Response(body, { headers: { 'Content-Type': entry[1], ...HEADERS } });
        } catch {
            return new Response('Not found', { status: 404 });
        }
    });
}

// Is the graphics engine shipped with this build? (all files present)
function isAvailable() {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
    if (process.env.SYNCWAVE_NO_GPU) return false;
    return Object.values(FILES).every(([f]) => fs.existsSync(f));
}

/**
 * Run one separation in the hidden window.
 * job: { mode, modelPath, input, outDir, ffmpegPath, check }
 * hooks: { onProgress(percent, message), onCheck(chunk, out) -> Promise<{ ok, error? }> }
 * Returns { promise, cancel }. The promise resolves to
 *   { success, stems, duration } | { error } | { cancelled }.
 */
function run(job, hooks) {
    ensureProtocol();
    let win = null;
    let settled = false;
    let cancelled = false;
    let watchdog = null;
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });

    // No progress for 5 minutes (a stuck graphics driver) counts as a failure.
    const limit = Number(process.env.SYNCWAVE_GPU_TIMEOUT_MS) || 300000;
    const kick = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => finish({ error: 'The graphics chip stopped responding.' }), limit);
    };

    const onMessage = async (e, msg) => {
        if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
        if (msg.type === 'progress') { kick(); hooks.onProgress(msg.percent, msg.message); }
        else if (msg.type === 'log') console.log(`[gpu] ${msg.message}`);
        else if (msg.type === 'check') {
            clearTimeout(watchdog); // the processor check can take a while
            let r;
            try { r = await hooks.onCheck(msg.chunk, msg.out); } catch (err) { r = { ok: false, error: err.message }; }
            if (settled) return;
            if (!r.ok) { finish({ error: r.error || 'The graphics chip gave a different result.' }); return; }
            kick();
            win.webContents.send('gpu-check-result', { ok: true });
        } else if (msg.type === 'done') finish({ success: true, stems: msg.result.stems, duration: msg.result.duration });
        else if (msg.type === 'error') finish({ error: msg.error, soft: !!msg.soft });
    };
    const onChildGone = (e, details) => {
        if (details && details.type === 'GPU') finish({ error: `The graphics process stopped (${details.reason}).` });
    };

    function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        ipcMain.removeListener('gpu-runner', onMessage);
        app.removeListener('child-process-gone', onChildGone);
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        resolveFn(cancelled ? { cancelled: true } : result);
    }

    ipcMain.on('gpu-runner', onMessage);
    app.on('child-process-gone', onChildGone);

    win = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'gpu', 'runner-preload.js'),
            contextIsolation: false, // the page hands ONNX Runtime Web to the preload
            nodeIntegration: false,
            sandbox: false,          // the preload reads the model and runs FFmpeg
            backgroundThrottling: false,
            spellcheck: false,
        },
    });
    win.webContents.on('render-process-gone', (e, details) => finish({ error: `The graphics engine stopped (${details.reason}).` }));
    win.webContents.on('did-fail-load', (e, code, desc) => finish({ error: `The graphics engine did not load (${desc}).` }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('gpu-job', job);
    });
    kick();
    win.loadURL(`${SCHEME}://app/runner.html`).catch((err) => finish({ error: `The graphics engine did not load (${err.message}).` }));

    return {
        promise,
        cancel: () => { cancelled = true; finish({ cancelled: true }); },
    };
}

// Changes when the graphics engine changes, so its one-time check runs again.
const ENGINE_ID = `ort-web-1.23.2-${BUNDLE}`;

module.exports = { run, isAvailable, ENGINE_ID };
