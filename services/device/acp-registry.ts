import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { installAcpPackage } from './install-acp-package.ts';
import { readAcpRegistry, registryListing, registryWorkerManifest } from '../../packages/workers/acp-registry.ts';

async function manifestFor(id: string, distribution: 'npx' | 'uvx' | 'binary', binaryPath?: string) {
  const matches = (await readAcpRegistry()).filter(entry => entry.id === id);
  if (matches.length !== 1) throw new Error('The ACP Registry agent ID is unavailable or ambiguous');
  return registryWorkerManifest(matches[0], distribution, binaryPath);
}

async function saveManifest(destination: string, manifest: Awaited<ReturnType<typeof manifestFor>>) {
  const content = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(content) > 16_384) throw new Error('The generated Worker manifest is too large');
  await writeFile(destination, content, { mode: 0o600, flag: 'wx' });
  console.log(destination);
}

const [action, id, distribution, destination, binaryPath, ...extra] = process.argv.slice(2);
if (action === 'list' && id === undefined) {
  const entries = await readAcpRegistry();
  console.log(JSON.stringify(registryListing(entries), null, 2));
} else if (action === 'import' && id && (distribution === 'npx' || distribution === 'uvx' || distribution === 'binary') &&
           destination && isAbsolute(destination) && !extra.length) {
  await saveManifest(destination, await manifestFor(id, distribution, binaryPath));
} else if (action === 'install' && id && distribution && isAbsolute(distribution) && !binaryPath && !extra.length) {
  const directory = distribution;
  const selected = await manifestFor(id, 'npx');
  if (destination && destination !== selected.registry.version) throw new Error('The selected registry version has changed');
  const manifest = await installAcpPackage(selected, directory);
  await saveManifest(join(directory, 'worker.json'), manifest);
} else {
  console.error('Usage: device:acp-registry -- list | import ID npx|uvx|binary /absolute/worker.json [/absolute/binary] | install ID /absolute/new-directory [expected-version]');
  process.exitCode = 2;
}
