// electron-builder afterPack hook (macOS only).
//
// SyncWave is not signed with a paid Apple Developer ID. Without any
// signature, macOS reports downloaded builds as "damaged" (especially on
// Apple Silicon) and offers no way to open them. An ad-hoc signature gives
// the bundle a valid, consistent seal so macOS instead shows the normal
// "Open Anyway" option in System Settings > Privacy & Security (and the
// install.sh one-liner / in-app updater can run it without any prompt).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function isMachO(file) {
    try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        const magic = buf.readUInt32BE(0);
        return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
    } catch (e) { return false; }
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full, out);
        else if (isMachO(full)) out.push(full);
    }
    return out;
}

exports.default = async function adhocSign(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

    // Helper binaries shipped as resources (ffmpeg, ffprobe) first...
    const resources = path.join(appPath, 'Contents', 'Resources');
    for (const bin of walk(resources)) {
        console.log(`  • ad-hoc signing ${path.relative(appPath, bin)}`);
        execFileSync('codesign', ['--force', '--sign', '-', bin], { stdio: 'inherit' });
    }
    // ...then the frameworks, helpers and the app bundle itself.
    console.log(`  • ad-hoc signing ${appPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
    } catch (e) {
        console.warn('  • codesign verification reported a problem (continuing):', e.message);
    }
};
