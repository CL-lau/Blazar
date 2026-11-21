import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Build the macOS bundle on macOS.');

const desktop = fileURLToPath(new URL('../', import.meta.url));
const tauri = fileURLToPath(new URL('../../../node_modules/.bin/tauri', import.meta.url));
const manifest = join(desktop, 'src-tauri', 'Cargo.toml');
const config = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const metadata = JSON.parse(execFileSync('cargo', [
  'metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest,
], { cwd: desktop, encoding: 'utf8' }));
const cargoPackage = metadata.packages.find(item => item.name === 'blazar-desktop');
if (!cargoPackage || cargoPackage.version !== config.version) {
  throw new Error('Cargo and Tauri application versions must match.');
}
const arch = { arm64: 'aarch64', x64: 'x64' }[process.arch];
if (!arch) throw new Error('Unsupported macOS architecture.');

execFileSync(tauri, ['build', '--bundles', 'app'], { cwd: desktop, stdio: 'inherit' });
const bundle = join(metadata.target_directory, 'release', 'bundle');
const dmgDirectory = join(bundle, 'dmg');
mkdirSync(dmgDirectory, { recursive: true });
const staging = mkdtempSync(join(dmgDirectory, '.staging-'));
const contents = join(staging, 'contents');
const name = `Blazar_${config.version}_${arch}.dmg`;
const temporaryDmg = join(staging, name);
const destination = join(dmgDirectory, name);
try {
  mkdirSync(contents);
  symlinkSync('/Applications', join(contents, 'Applications'), 'dir');
  const app = join(contents, 'Blazar.app');
  execFileSync('ditto', [join(bundle, 'macos', 'Blazar.app'), app], { stdio: 'inherit' });
  if (!process.env.APPLE_SIGNING_IDENTITY && !config.bundle?.macOS?.signingIdentity) {
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' });
    } catch {
      execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
    }
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  execFileSync('hdiutil', ['create', '-quiet', '-volname', 'Blazar', '-srcfolder', contents, '-format', 'UDZO', temporaryDmg],
    { stdio: 'inherit' });
  execFileSync('hdiutil', ['verify', temporaryDmg], { stdio: 'inherit' });
  renameSync(temporaryDmg, destination);
  console.log(destination);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
