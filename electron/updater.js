// SyncWave in-app updater.
//
// macOS: Electron's built-in updater (Squirrel.Mac) refuses to install
// updates for apps that are not signed with a paid Apple Developer ID, which
// is why "Update" never really worked before. On macOS we therefore update
// ourselves: read the latest GitHub release, download the zip for this Mac's
// CPU (Intel x64 or Apple Silicon arm64), unpack it, and swap the app bundle
// after SyncWave quits. Files downloaded this way are not quarantined, so
// Gatekeeper does not block the new version.
//
// Windows: electron-updater works with unsigned NSIS installers, so we use it.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const net = require('./net');

const REPO = 'mo-alhamouri/SyncWave';
const isMac = process.platform === 'darwin';

let send = () => {};
let latest = null;          // { version, notes, url, assets }
let downloadedApp = null;   // path to the unpacked SyncWave.app (macOS)
let downloading = null;     // in-flight download promise
let winUpdater = null;

function log(...a) { console.log('[updater]', ...a); }

async function fetchLatest() {
    const rel = await net.getJson(`https://api.github.com/repos/${REPO}/releases/latest`, { timeout: 15000 });
    latest = {
        version: String(rel.tag_name || '').replace(/^v/, ''),
        notes: rel.body || '',
        url: rel.html_url || `https://github.com/${REPO}/releases/latest`,
        assets: rel.assets || [],
    };
    return latest;
}

function getWinUpdater() {
    if (winUpdater) return winUpdater;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', (p) => send('update-progress', { percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => send('update-downloaded', { version: info.version }));
    autoUpdater.on('error', (e) => send('update-error', { error: e.message }));
    winUpdater = autoUpdater;
    return winUpdater;
}

async function check() {
    try {
        const rel = await fetchLatest();
        const current = app.getVersion();
        const available = net.compareVersions(rel.version, current) > 0;
        log(`current ${current}, latest ${rel.version}, available=${available}`);
        return { available, version: rel.version, current, notes: rel.notes, url: rel.url };
    } catch (e) {
        return { error: e.message };
    }
}

function macAssetFor(version) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const name = `SyncWave-${version}-${arch}.zip`;
    return latest.assets.find((a) => a.name === name);
}

async function downloadMac() {
    const asset = macAssetFor(latest.version);
    if (!asset) throw new Error(`No macOS ${process.arch} build found in release v${latest.version}`);
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, asset.name);
    await net.download(asset.browser_download_url, zip, (percent) => send('update-progress', { percent }));
    const out = path.join(dir, 'unpacked');
    fs.mkdirSync(out, { recursive: true });
    await new Promise((resolve, reject) => execFile('ditto', ['-x', '-k', zip, out], (err) => err ? reject(err) : resolve()));
    const appName = fs.readdirSync(out).find((f) => f.endsWith('.app'));
    if (!appName) throw new Error('Update package did not contain an app.');
    try { fs.unlinkSync(zip); } catch (e) {}
    downloadedApp = path.join(out, appName);
    return downloadedApp;
}

async function download() {
    if (downloading) return downloading;
    downloading = (async () => {
        if (!latest) await fetchLatest();
        if (!app.isPackaged) throw new Error('Updates can only be installed from the packaged app.');
        if (isMac) {
            await downloadMac();
            send('update-downloaded', { version: latest.version });
        } else if (process.platform === 'win32') {
            const u = getWinUpdater();
            await u.checkForUpdates();
            await u.downloadUpdate(); // emits update-downloaded
        } else {
            shell.openExternal(latest.url);
            throw new Error('Opened the download page in your browser.');
        }
        return { ok: true, version: latest.version };
    })();
    try { return await downloading; } catch (e) {
        send('update-error', { error: e.message });
        return { error: e.message };
    } finally { downloading = null; }
}

function currentBundlePath() {
    // .../SyncWave.app/Contents/MacOS/SyncWave -> .../SyncWave.app
    return path.resolve(app.getPath('exe'), '../../..');
}

function install() {
    if (!isMac) {
        if (winUpdater) { winUpdater.quitAndInstall(); return { ok: true }; }
        return { error: 'No update has been downloaded yet.' };
    }
    if (!downloadedApp || !fs.existsSync(downloadedApp)) return { error: 'No update has been downloaded yet.' };

    let target = currentBundlePath();
    // Running from the DMG or a randomized "App Translocation" path: install to /Applications.
    if (!target.endsWith('.app') || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/')) {
        target = '/Applications/SyncWave.app';
    }
    const script = path.join(app.getPath('userData'), 'updates', 'install.sh');
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(script, [
        '#!/bin/bash',
        `PID=${process.pid}`,
        `NEW=${q(downloadedApp)}`,
        `TARGET=${q(target)}`,
        'for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done',
        'rm -rf "$TARGET.old"',
        '[ -d "$TARGET" ] && mv "$TARGET" "$TARGET.old"',
        'if ditto "$NEW" "$TARGET"; then',
        '  xattr -cr "$TARGET" 2>/dev/null',
        '  rm -rf "$TARGET.old"',
        'else',
        '  [ -d "$TARGET.old" ] && mv "$TARGET.old" "$TARGET"',
        'fi',
        'open "$TARGET"',
        '',
    ].join('\n'), { mode: 0o755 });

    let writable = true;
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); if (fs.existsSync(target)) fs.accessSync(target, fs.constants.W_OK); } catch (e) { writable = false; }

    const child = writable
        ? spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' })
        : spawn('/usr/bin/osascript', ['-e', `do shell script "/bin/bash " & quoted form of ${JSON.stringify(script)} with administrator privileges`], { detached: true, stdio: 'ignore' });
    child.unref();
    log('Installing update to', target, writable ? '' : '(admin prompt)');
    setTimeout(() => app.quit(), 300);
    return { ok: true };
}

// Called once at launch: quietly check, and if there is a newer version,
// download it in the background and offer "Restart & Update".
function init(sender) {
    send = sender;
    if (!app.isPackaged) return;
    setTimeout(async () => {
        const r = await check();
        if (r.available) {
            send('update-available', { version: r.version });
            download();
        }
    }, 5000);
}

module.exports = { init, check, download, install };
