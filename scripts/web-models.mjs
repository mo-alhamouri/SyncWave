// Prepares the AI models for SyncWave Online (the website version of the
// Vocal Remover): takes each model the desktop app uses (same file, same
// SHA-256, listed in electron/stems.js), splits it into parts under 50 MB
// (GitHub Pages / git limit is 100 MB per file) and writes manifest.json.
//
// Usage: node scripts/web-models.mjs <outDir>
// Model files are taken from, in order: $MODELS_DIR, the desktop app's own
// download folder on this Mac, .web-cache/, or downloaded from the
// models-v1 GitHub release into .web-cache/.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.resolve(process.argv[2] || 'Marketing Website/app/models');
const PART = 45 * 1024 * 1024;

// Read the model list from the desktop app so both always match.
const src = fs.readFileSync(path.join(ROOT, 'electron', 'stems.js'), 'utf8');
const base = /MODEL_BASE = '([^']+)'/.exec(src)[1];
const models = {};
for (const mode of ['fast', 'best']) {
    const m = new RegExp(`${mode}: \\{[\\s\\S]*?file: '([^']+)', size: (\\d+),[\\s\\S]*?sha256: '([0-9a-f]{64})'`).exec(src);
    if (!m) throw new Error(`Model "${mode}" not found in electron/stems.js`);
    models[mode] = { file: m[1], size: Number(m[2]), sha256: m[3] };
}

const sha256 = (file) => new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

async function locate(m) {
    const cacheDir = path.join(ROOT, '.web-cache');
    const candidates = [
        process.env.MODELS_DIR && path.join(process.env.MODELS_DIR, m.file),
        path.join(os.homedir(), 'Library/Application Support/syncwave-desktop/models', m.file),
        path.join(os.homedir(), 'AppData/Roaming/syncwave-desktop/models', m.file),
        path.join(cacheDir, m.file),
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).size === m.size) return c;
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    const dest = path.join(cacheDir, m.file);
    console.log(`Downloading ${m.file} (${Math.round(m.size / 1e6)} MB)...`);
    const res = await fetch(base + m.file);
    if (!res.ok) throw new Error(`Download of ${m.file} failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.part'));
    fs.renameSync(dest + '.part', dest);
    return dest;
}

fs.rmSync(outDir, { recursive: true, force: true });
const manifest = { version: 1, models: {} };
for (const [mode, m] of Object.entries(models)) {
    const file = await locate(m);
    const hash = await sha256(file);
    if (hash !== m.sha256) throw new Error(`${file}: SHA-256 mismatch (${hash})`);
    const dir = path.join(outDir, mode);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(file, 'r');
    const parts = [];
    const buf = Buffer.alloc(PART);
    for (let i = 0, off = 0; off < m.size; i++, off += PART) {
        const n = fs.readSync(fd, buf, 0, Math.min(PART, m.size - off), off);
        const name = `${m.file}.${String(i).padStart(3, '0')}`;
        fs.writeFileSync(path.join(dir, name), buf.subarray(0, n));
        parts.push(`models/${mode}/${name}`);
    }
    fs.closeSync(fd);
    manifest.models[mode] = { file: m.file, size: m.size, sha256: m.sha256, parts };
    console.log(`${mode}: ${m.file} -> ${parts.length} parts`);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
