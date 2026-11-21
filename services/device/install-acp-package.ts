import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { registryWorkerManifest } from '../../packages/workers/acp-registry.ts';
import { locateWorkerExecutable } from '../../packages/workers/registry.ts';

type Manifest = Awaited<ReturnType<typeof registryWorkerManifest>>;
const exec = promisify(execFile);

export async function installAcpPackage(manifest: Manifest, directory: string) {
  if (manifest.registry.distribution !== 'npx' || !isAbsolute(directory)) {
    throw new Error('Package installation requires an npm distribution and an absolute directory');
  }
  const packageSpec = manifest.args[1];
  const separator = packageSpec.lastIndexOf('@');
  const name = packageSpec.slice(0, separator);
  const version = packageSpec.slice(separator + 1);
  const npm = await locateWorkerExecutable('npm');
  await mkdir(directory, { mode: 0o700 });
  const root = await realpath(directory);
  try {
    await exec(npm, ['install', '--prefix', root, '--no-audit', '--no-fund', '--save-exact', '--', packageSpec],
      { cwd: root, timeout: 180_000, maxBuffer: 256_000, windowsHide: true });
  } catch {
    throw new Error('The pinned ACP package could not be installed. Inspect the installation directory.');
  }
  const installed = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (installed.name !== name || installed.version !== version) throw new Error('The installed ACP package identity does not match');
  const defaultName = name.split('/').at(-1)!;
  const binNames = typeof installed.bin === 'string' ? [defaultName] : Object.keys(installed.bin ?? {});
  const bin = binNames.includes(defaultName) ? defaultName : binNames.length === 1 ? binNames[0] : undefined;
  if (!bin || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(bin)) throw new Error('The installed package has no unambiguous executable');
  const executable = await locateWorkerExecutable(join(root, 'node_modules', '.bin', bin));
  const target = relative(root, await realpath(executable));
  if (!target || isAbsolute(target) || target === '..' || target.startsWith('..' + sep)) {
    throw new Error('The installed executable resolves outside its installation directory');
  }
  return { ...manifest, executable, args: manifest.args.slice(2) };
}
