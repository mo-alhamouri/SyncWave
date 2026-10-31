// Runs one stem separation in its own process (Electron utilityProcess), so
// the heavy number crunching never freezes the app window. The main process
// sends one job, gets progress messages back, and kills this process when
// the job is done or the user cancels.
'use strict';

const engine = require('./stems-engine');

const port = process.parentPort;

port.once('message', async (e) => {
    const job = e.data;
    try {
        const ort = require('onnxruntime-node');
        const result = await engine.separate({
            ort,
            mode: job.mode,
            modelPath: job.modelPath,
            input: job.input,
            outDir: job.outDir,
            ffmpegPath: job.ffmpegPath,
            onProgress: (percent, message) => port.postMessage({ type: 'progress', percent, message }),
        });
        port.postMessage({ type: 'done', result });
    } catch (err) {
        port.postMessage({ type: 'error', error: (err && err.message) || String(err) });
    }
});
