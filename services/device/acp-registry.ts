import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readAcpRegistry, registryWorkerManifest } from '../../packages/workers/acp-registry.ts';

const [action, id, distribution, destination, binaryPath, ...extra] = process.argv.slice(2);
if (action === 'list' && id === undefined) {
  const entries = await readAcpRegistry();
  console.log(JSON.stringify(entries.map(({ id, name, version, distribution }) => ({
    id, name, version, distributions: Object.keys(distribution),
  })), null, 2));
} else if (action === 'import' && id && (distribution === 'npx' || distribution === 'uvx' || distribution === 'binary') &&
           destination && isAbsolute(destination) && !extra.length) {
  const matches = (await readAcpRegistry()).filter(entry => entry.id === id);
  if (matches.length !== 1) throw new Error('The ACP Registry agent ID is unavailable or ambiguous');
  const manifest = await registryWorkerManifest(matches[0], distribution, binaryPath);
  const content = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(content) > 16_384) throw new Error('The generated Worker manifest is too large');
  await writeFile(destination, content, { mode: 0o600, flag: 'wx' });
  console.log(destination);
} else {
  console.error('Usage: device:acp-registry -- list | import ID npx|uvx|binary /absolute/worker.json [/absolute/binary]');
  process.exitCode = 2;
}
