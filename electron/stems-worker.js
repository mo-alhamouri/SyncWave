// Runs stem separation work on the processor in its own process (Electron
// utilityProcess), so the heavy number crunching never freezes the app
// window. The main process sends one job, gets progress messages back, and
// kills this process when the job is done or the user cancels.
//
// Jobs:
//   { type: 'separate', mode, modelPath, input, outDir, ffmpegPath } - a whole song
//   { type: 'chunk', mode, modelPath, chunk } - one chunk, used once per model to
//     check that the graphics chip gives the same result as the processor
'use strict';

const engine = require('./stems-engine');

const port = process.parentPort;

port.once('message', async (e) => {
    const job = e.data;
    try {
        const ort = require('onnxruntime-node');
        if (job.type === 'chunk') {
            const session = await engine.createCpuSession(ort, job.modelPath);
            const out = await engine.runChunk(ort, session, job.mode, job.chunk);
            port.postMessage({ type: 'chunk-done', out: out.map((st) => st.map((ch) => ch.slice())) });
            return;
        }
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
