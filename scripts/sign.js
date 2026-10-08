// scripts/sign.js — after packaging on macOS: ad-hoc sign (required on Apple Silicon), strip quarantine, copy to dist/Veliance.app
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const arch = process.argv[2] || 'arm64';
const src = path.join('dist', `Veliance-darwin-${arch}`, 'Veliance.app');
const dst = path.join('dist', 'Veliance.app');
if (!fs.existsSync(src)) { console.error('nothing to sign at', src); process.exit(1); }

if (process.platform === 'darwin') {
  try {
    execSync(`xattr -cr "${src}"`, { stdio: 'inherit' });
    execSync(`codesign --force --deep --sign - "${src}"`, { stdio: 'inherit' });
    execSync(`codesign --verify --deep --strict "${src}"`, { stdio: 'inherit' });
    console.log('ad-hoc signed ✓');
  } catch (e) { console.warn('signing failed:', e.message); }
} else {
  console.log('not macOS — skipping codesign (run `npm run sign` on the Mac after unzipping)');
}
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
console.log('→', dst);
