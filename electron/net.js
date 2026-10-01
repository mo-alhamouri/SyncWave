// Small HTTPS helpers shared by the media engine and the app updater.
// Uses only Node built-ins so nothing extra has to be bundled.
const https = require('https');
const fs = require('fs');

const USER_AGENT = 'SyncWave-Desktop';

function get(url, { timeout = 30000, headers = {} } = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, timeout }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirects > 10) return reject(new Error('Too many redirects'));
                const next = new URL(res.headers.location, url).toString();
                return resolve(get(next, { timeout, headers }, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            resolve(res);
        });
        req.on('timeout', () => req.destroy(new Error(`Request timed out: ${url}`)));
        req.on('error', reject);
    });
}

async function getJson(url, opts = {}) {
    const res = await get(url, { ...opts, headers: { Accept: 'application/vnd.github+json', ...(opts.headers || {}) } });
    return new Promise((resolve, reject) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        res.on('error', reject);
    });
}

// Downloads to "<dest>.part" first and renames on success, so a dropped
// connection never leaves a half-written binary behind.
async function download(url, dest, onProgress) {
    const tmp = `${dest}.part`;
    const res = await get(url, { timeout: 60000 });
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let received = 0;
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress && total) onProgress(Math.round((received / total) * 100));
        });
        res.on('error', (e) => { file.destroy(); reject(e); });
        file.on('error', reject);
        file.on('finish', resolve);
        res.pipe(file);
    });
    if (total && received !== total) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        throw new Error(`Incomplete download (${received}/${total} bytes)`);
    }
    fs.renameSync(tmp, dest);
}

// Simple semver-ish comparison: "1.2.10" > "1.2.9". Returns 1, 0 or -1.
function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

module.exports = { get, getJson, download, compareVersions };
