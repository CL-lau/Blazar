import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
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

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeStaging = mkdtempSync(join(desktop, 'src-tauri', '.router-bundle-'));
try {
  const runtime = join(runtimeStaging, 'router-runtime');
  mkdirSync(runtime);
  copyFileSync(process.execPath, join(runtime, 'node'));
  chmodSync(join(runtime, 'node'), 0o755);
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(join(root, file), join(runtime, file));
  }
  for (const directory of ['services', 'packages', 'deploy/macos']) {
    cpSync(join(root, directory), join(runtime, directory), {
      recursive: true,
      filter: path => !path.endsWith('.test.ts'),
    });
  }
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: runtime, stdio: 'inherit',
  });
  const resourcePath = join(runtimeStaging.split('/').at(-1), 'router-runtime');
  rmSync(join(metadata.target_directory, 'release', 'router-runtime'), { recursive: true, force: true });
  execFileSync(tauri, ['build', '--bundles', 'app', '--config', JSON.stringify({
    bundle: { resources: { [resourcePath]: 'router-runtime' } },
  })], { cwd: desktop, stdio: 'inherit' });
} finally {
  rmSync(runtimeStaging, { recursive: true, force: true });
}
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
