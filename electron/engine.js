// SyncWave media engine: keeps yt-dlp, a JavaScript runtime (Deno) and
// FFmpeg/FFprobe present, working and up to date.
//
// Why this exists (v1.2.8): YouTube regularly changes how it serves video.
// SyncWave used to download yt-dlp once and never update it, so when YouTube
// started rejecting the old default player client every download failed with
// "HTTP Error 403: Forbidden". The engine now updates yt-dlp on launch, can
// jump to the nightly channel when a download is blocked, and ships a modern
// JS runtime, which yt-dlp needs to solve YouTube's player challenges.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const net = require('./net');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const state = {
    binDir: '',
    ytDlpPath: '',
    denoPath: '',
    ffmpegPath: '',
    ffprobePath: '',
    ytDlpVersion: '',
    jsRuntime: null, // e.g. "deno:/path/to/deno" or "node"
};

function run(cmd, args, { timeout = 60000, env } = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout, env: env || process.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
}

function makeExecutable(p) {
    if (isWin) return;
    try { fs.chmodSync(p, 0o755); } catch (e) {}
    // Files we download ourselves are not quarantined, but clear it anyway in
    // case a binary was copied out of a quarantined bundle.
    if (isMac) { try { require('child_process').execFileSync('xattr', ['-d', 'com.apple.quarantine', p], { stdio: 'ignore' }); } catch (e) {} }
}

// ---------------- yt-dlp ----------------

function ytDlpAssetName() {
    if (isMac) return 'yt-dlp_macos'; // universal binary: Intel + Apple Silicon
    if (isWin) return process.arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
    return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

async function getYtDlpVersion() {
    if (!fs.existsSync(state.ytDlpPath)) return '';
    const r = await run(state.ytDlpPath, ['--version'], { timeout: 60000 });
    return r.ok ? r.stdout.trim() : '';
}

// channel: 'stable' (yt-dlp/yt-dlp) or 'nightly' (yt-dlp/yt-dlp-nightly-builds)
async function updateYtDlp(channel = 'stable', status = () => {}) {
    const repo = channel === 'nightly' ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
    const latest = String(await net.latestTag(repo)).trim();
    if (!latest) throw new Error('Could not read latest yt-dlp version');

    const current = state.ytDlpVersion || await getYtDlpVersion();
    if (current && net.compareVersions(current, latest) >= 0) {
        console.log(`[engine] yt-dlp ${current} is up to date (${channel} latest: ${latest})`);
        return { updated: false, version: current };
    }

    status(current ? `Updating Media Engine (${current} → ${latest})...` : 'Downloading Media Engine...');
    const asset = ytDlpAssetName();
    const url = `https://github.com/${repo}/releases/download/${latest}/${asset}`;
    console.log(`[engine] Downloading yt-dlp ${latest} from ${url}`);
    await net.download(url, state.ytDlpPath);
    makeExecutable(state.ytDlpPath);
    state.ytDlpVersion = await getYtDlpVersion();
    console.log(`[engine] yt-dlp now at ${state.ytDlpVersion}`);
    return { updated: true, version: state.ytDlpVersion };
}

// ---------------- Deno (JS runtime for YouTube challenges) ----------------

function denoAssetName() {
    const arm = process.arch === 'arm64';
    if (isMac) return arm ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip';
    if (isWin) return 'deno-x86_64-pc-windows-msvc.zip';
    return arm ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip';
}

async function extractZip(zipPath, destDir) {
    if (isMac) return run('ditto', ['-x', '-k', zipPath, destDir], { timeout: 120000 });
    if (isWin) {
        return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`], { timeout: 120000 });
    }
    return run('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120000 });
}

async function denoWorks() {
    if (!fs.existsSync(state.denoPath)) return false;
    const r = await run(state.denoPath, ['--version'], { timeout: 30000 });
    return r.ok && /deno\s+\d/.test(r.stdout);
}

async function ensureDeno(status = () => {}) {
    if (await denoWorks()) return true;
    status('Installing JavaScript Runtime (one-time)...');
    const zip = path.join(state.binDir, 'deno.zip');
    await net.download(`https://github.com/denoland/deno/releases/latest/download/${denoAssetName()}`, zip);
    const r = await extractZip(zip, state.binDir);
    try { fs.unlinkSync(zip); } catch (e) {}
    if (!r.ok) throw new Error('Could not extract Deno: ' + r.stderr);
    makeExecutable(state.denoPath);
    return denoWorks();
}

async function systemNodeIsModern() {
    // yt-dlp requires Node >= 22 when Node is used as the JS runtime.
    const r = await run(isWin ? 'node.exe' : 'node', ['--version'], { timeout: 10000 });
    const m = r.ok && r.stdout.trim().match(/^v(\d+)/);
    return !!m && parseInt(m[1], 10) >= 22;
}

async function resolveJsRuntime(status) {
    try {
        if (await ensureDeno(status)) { state.jsRuntime = `deno:${state.denoPath}`; return; }
    } catch (e) { console.error('[engine] Deno setup failed:', e.message); }
    if (await systemNodeIsModern()) { state.jsRuntime = 'node'; return; }
    state.jsRuntime = null;
    console.warn('[engine] No JS runtime available; some YouTube formats may be missing.');
}

// ---------------- FFmpeg / FFprobe ----------------

function verifyBinary(p) {
    if (!p || !fs.existsSync(p)) return Promise.resolve(false);
    return new Promise((r) => {
        const proc = spawn(p, ['-version']);
        proc.on('error', () => r(false));
        proc.on('close', (code) => r(code === 0));
    });
}

function findAll(base, target, out = []) {
    if (!fs.existsSync(base)) return out;
    for (const entry of fs.readdirSync(base)) {
        const full = path.join(base, entry);
        const st = fs.statSync(full);
        if (st.isDirectory()) findAll(full, target, out);
        else if (entry === target) out.push(full);
    }
    return out;
}

// Pick the bundled binary built for this CPU (e.g. ".../darwin-x64/ffmpeg").
async function pickBundled(base, target) {
    const tag = `${process.platform}-${process.arch}`;
    const candidates = findAll(base, target).sort((a, b) => (b.includes(tag) ? 1 : 0) - (a.includes(tag) ? 1 : 0));
    for (const c of candidates) { if (await verifyBinary(c)) return c; }
    return null;
}

async function ensureFfmpeg({ isPackaged, resourcesPath }, status) {
    if (await verifyBinary(state.ffmpegPath) && await verifyBinary(state.ffprobePath)) return;
    status('Preparing Video Processors...');
    const ffName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const fpName = isWin ? 'ffprobe.exe' : 'ffprobe';

    if (isPackaged) {
        const unpacked = path.join(resourcesPath, 'app.asar.unpacked');
        const bFf = await pickBundled(unpacked, ffName);
        const bFp = await pickBundled(unpacked, fpName);
        if (bFf && bFp) {
            fs.copyFileSync(bFf, state.ffmpegPath);
            fs.copyFileSync(bFp, state.ffprobePath);
            makeExecutable(state.ffmpegPath);
            makeExecutable(state.ffprobePath);
            return;
        }
    } else {
        try {
            const a = require('@ffmpeg-installer/ffmpeg').path;
            const b = require('@ffprobe-installer/ffprobe').path;
            if (await verifyBinary(a) && await verifyBinary(b)) { state.ffmpegPath = a; state.ffprobePath = b; return; }
        } catch (e) {}
    }
    throw new Error(`Video processors (FFmpeg) for ${process.platform}-${process.arch} were not found in this build.`);
}

// ---------------- Public API ----------------

async function init({ userDataPath, isPackaged, resourcesPath, status = () => {} }) {
    state.binDir = path.join(userDataPath, 'bin_v1');
    fs.mkdirSync(state.binDir, { recursive: true });
    state.ytDlpPath = path.join(state.binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp');
    state.denoPath = path.join(state.binDir, isWin ? 'deno.exe' : 'deno');
    state.ffmpegPath = path.join(state.binDir, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    state.ffprobePath = path.join(state.binDir, isWin ? 'ffprobe.exe' : 'ffprobe');

    // Make bundled tools discoverable by yt-dlp.
    process.env.PATH = `${state.binDir}${path.delimiter}${process.env.PATH || ''}`;

    // 1. yt-dlp: install if missing, otherwise update to the latest stable.
    status('Checking Media Engine...');
    state.ytDlpVersion = await getYtDlpVersion();
    try {
        await updateYtDlp('stable', status);
    } catch (e) {
        console.error('[engine] yt-dlp update check failed:', e.message);
        if (!state.ytDlpVersion) {
            // Last resort: GitHub "latest" redirect without the API.
            const ext = ytDlpAssetName();
            await net.download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ext}`, state.ytDlpPath);
            makeExecutable(state.ytDlpPath);
            state.ytDlpVersion = await getYtDlpVersion();
        }
    }
    if (!state.ytDlpVersion) throw new Error('Media engine (yt-dlp) could not be started.');

    // 2. FFmpeg / FFprobe
    await ensureFfmpeg({ isPackaged, resourcesPath }, status);

    // 3. JS runtime
    await resolveJsRuntime(status);

    console.log('[engine] Ready', { ytDlp: state.ytDlpVersion, jsRuntime: state.jsRuntime, ffmpeg: state.ffmpegPath });
    return state;
}

// Arguments every yt-dlp call should get.
function baseArgs() {
    const args = ['--no-update'];
    if (state.jsRuntime) args.push('--js-runtimes', state.jsRuntime);
    if (state.ffmpegPath) args.push('--ffmpeg-location', path.dirname(state.ffmpegPath));
    return args;
}

// Errors that a newer yt-dlp (or a different YouTube client) usually fixes.
const RECOVERABLE = /HTTP Error 403|Forbidden|Requested format is not available|nsig|n challenge|signature|Only images are available|PO Token|Unable to extract|player response/i;

function isRecoverable(message) { return RECOVERABLE.test(String(message || '')); }

// Turn yt-dlp's raw stderr into one readable sentence for the UI.
function cleanError(raw) {
    const text = String(raw || '').replace(/;?\s*please report this issue on[^\n]*/gi, '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const err = lines.filter((l) => l.startsWith('ERROR:')).pop();
    if (err) return err.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, '').trim();
    const other = lines.filter((l) => !/^WARNING:|^Error code:|^Stderr:/i.test(l)).pop();
    return other || 'Download failed.';
}

module.exports = { init, state, baseArgs, updateYtDlp, isRecoverable, cleanError, getYtDlpVersion };
