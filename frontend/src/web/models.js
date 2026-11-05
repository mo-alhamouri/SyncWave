// AI model files for the web Vocal Remover.
//
// The website publishes each model split into parts under 100 MB
// (models/<mode>/<file>.000, .001, ...) with a manifest that lists the parts,
// the total size and the SHA-256 (see scripts/build-web.sh). Parts are kept
// in the browser's Cache Storage, so a model downloads only once per browser.
// Works in the page and in workers.

const CACHE = 'syncwave-models-v1';
const VERIFIED = 'verified/'; // cache key prefix: a model that passed its SHA-256 check

let manifestPromise = null;
export function getManifest(base) {
    if (!manifestPromise) {
        manifestPromise = fetch(new URL('models/manifest.json', base), { cache: 'no-cache' })
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .catch((e) => { manifestPromise = null; throw new Error(`Could not read the AI model list (${e.message}).`); });
    }
    return manifestPromise;
}

const partUrls = (base, m) => m.parts.map((p) => new URL(p, base).href);
const verifiedUrl = (base, m) => new URL(VERIFIED + m.sha256, base).href;

/** Is this model fully downloaded and checked in this browser? */
export async function isModelCached(base, mode) {
    try {
        if (!('caches' in self)) return false;
        const m = (await getManifest(base)).models[mode];
        const cache = await caches.open(CACHE);
        return !!(await cache.match(verifiedUrl(base, m)));
    } catch {
        return false;
    }
}

// Delete parts of models this version of the site no longer uses.
async function removeOldParts(cache, manifest, base) {
    const keep = new Set(Object.values(manifest.models).flatMap((m) => [...partUrls(base, m), verifiedUrl(base, m)]));
    for (const req of await cache.keys()) {
        if (!keep.has(req.url)) await cache.delete(req);
    }
}

async function sha256Hex(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get a model's bytes, downloading what is missing.
 * onProgress(percent) is called while downloading (not when it is cached).
 */
export async function loadModel(base, mode, onProgress) {
    const manifest = await getManifest(base);
    const m = manifest.models[mode];
    if (!m) throw new Error(`Unknown model: ${mode}`);
    const cache = 'caches' in self ? await caches.open(CACHE) : null;
    if (cache) await removeOldParts(cache, manifest, base).catch(() => {});

    const urls = partUrls(base, m);
    const bytes = new Uint8Array(m.size);
    let offset = 0, done = 0, lastPct = -1;
    const report = () => {
        const pct = Math.floor((done / m.size) * 100);
        if (pct !== lastPct) { lastPct = pct; if (onProgress) onProgress(pct); }
    };
    for (const url of urls) {
        let res = cache ? await cache.match(url) : null;
        const cached = !!res;
        if (!res) {
            res = await fetch(url);
            if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}). Check your connection and try again.`);
        }
        // Read the part (streamed, so progress updates while downloading).
        const start = offset;
        const reader = res.body.getReader();
        for (;;) {
            const { done: end, value } = await reader.read();
            if (end) break;
            if (offset + value.length > bytes.length) throw new Error('The AI model download is damaged. Please try again.');
            bytes.set(value, offset);
            offset += value.length;
            if (!cached) { done += value.length; report(); }
        }
        if (cache && !cached) {
            try { await cache.put(url, new Response(bytes.slice(start, offset))); } catch { /* storage full: still works this time */ }
        }
    }
    if (offset !== m.size) throw new Error('The AI model download is incomplete. Please try again.');

    if (!cache || !(await cache.match(verifiedUrl(base, m)))) {
        const hash = await sha256Hex(bytes);
        if (hash !== m.sha256) {
            if (cache) for (const url of urls) await cache.delete(url);
            throw new Error('The downloaded AI model is damaged. Please try again.');
        }
        if (cache) { try { await cache.put(verifiedUrl(base, m), new Response('ok')); } catch { /* not critical */ } }
    }
    return bytes;
}
