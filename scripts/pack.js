// scripts/pack.js — build dist/Veliance.app on this Mac.
// Reuses an already-downloaded Electron zip when possible (avoids the flaky postinstall download),
// then ad-hoc signs the bundle (required on Apple Silicon) and strips quarantine.
const { packager } = require('@electron/packager');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const arch = args.find(a => !a.startsWith('--')) || process.arch;  // arm64 | x64
const makeDmg = args.includes('--dmg');                     // build dist/Veliance-<version>-<arch>.dmg instead of installing
const version = require('electron/package.json').version;   // e.g. 33.4.11
const zipName = `electron-v${version}-darwin-${arch}.zip`;
const zipDir = path.join(os.homedir(), '.veliance-electron');
fs.mkdirSync(zipDir, { recursive: true });

// 1. find a local copy of the Electron zip so nothing has to be downloaded
const target = path.join(zipDir, zipName);
if (!fs.existsSync(target)) {
  const candidates = [
    path.join(os.tmpdir(), 'electron.zip'),
    '/tmp/electron.zip',
    ...(() => { try {
      const c = path.join(os.homedir(), 'Library', 'Caches', 'electron');
      return fs.readdirSync(c).flatMap(d => { const f = path.join(c, d, zipName); return fs.existsSync(f) ? [f] : []; });
    } catch { return []; } })()
  ];
  const found = candidates.find(f => { try { return fs.statSync(f).size > 50e6; } catch { return false; } });
  if (found) { fs.copyFileSync(found, target); console.log('using cached Electron zip:', found); }
  else console.log('no local Electron zip found — packager will download it');
}

(async () => {
  const [out] = await packager({
    dir: '.',
    name: 'Veliance',
    platform: 'darwin',
    arch,
    out: 'dist',
    overwrite: true,
    prune: true,
    appBundleId: 'com.veliance.overlay',
    appCategoryType: 'public.app-category.productivity',
    icon: 'assets/icon.icns',
    extendInfo: 'build/Info.extend.plist',
    electronZipDir: fs.existsSync(target) ? zipDir : undefined,
    ignore: [/^\/dist/, /^\/scripts\/pack/, /^\/smoke/, /^\/build\/entitlements/, /^\/\.git/]
  });
  const app = path.join(out, 'Veliance.app');
  if (process.platform === 'darwin') {
    execSync(`xattr -cr "${app}"`, { stdio: 'inherit' });
    execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
    execSync(`codesign --verify --deep --strict "${app}"`, { stdio: 'inherit' });
    console.log('ad-hoc signed ✓');
  }
  if (makeDmg) {
    // stage the app next to an /Applications shortcut so the DMG opens as "drag Veliance → Applications"
    const appVersion = require('../package.json').version;
    const dmg = path.join('dist', `Veliance-${appVersion}-${arch}.dmg`);
    const stage = path.join('dist', `dmg-${arch}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.cpSync(app, path.join(stage, 'Veliance.app'), { recursive: true, verbatimSymlinks: true });
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    fs.rmSync(dmg, { force: true });
    execSync(`hdiutil create -volname Veliance -srcfolder "${stage}" -ov -format UDZO "${dmg}"`, { stdio: 'inherit' });
    // drop the loose .app copies so they don't show up as extra apps in Spotlight/Launchpad
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    console.log(`\n→ ${dmg}`);
    return;
  }
  // Install straight into /Applications and drop the build copy — a second Veliance.app left in dist/
  // gets indexed by Spotlight/Launchpad and shows up as a duplicate app.
  const dst = '/Applications/Veliance.app';
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(app, dst, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(path.join('dist', 'Veliance.app'), { recursive: true, force: true });
  console.log('\n→ installed /Applications/Veliance.app');
})().catch(e => { console.error(e); process.exit(1); });
