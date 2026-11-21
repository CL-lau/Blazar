import { isAbsolute } from 'node:path';
import { locateWorkerExecutable } from './registry.ts';

const registryUrl = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const maxIndexBytes = 2_000_000;

type Distribution = 'npx' | 'uvx' | 'binary';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export async function readAcpRegistry(transport = fetch) {
  const response = await transport(registryUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('The ACP Registry index is unavailable');
  }
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxIndexBytes) throw new Error('The ACP Registry index is too large');
      chunks.push(value);
    }
  } finally {
    await stream.cancel();
  }
  const index = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (typeof index?.version !== 'string' || !/^1\.\d+\.\d+$/.test(index.version) ||
      !Array.isArray(index.agents) || index.agents.length > 1000) {
    throw new Error('Unsupported ACP Registry index');
  }
  return index.agents.flatMap(value => {
    const entry = object(value);
    const distribution = object(entry?.distribution);
    if (typeof entry?.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() || /[\x00-\x1f\x7f]/.test(entry.name) ||
        typeof entry.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(entry.version) ||
        entry.name.length + entry.version.length > 127 || !distribution) return [];
    return [{ id: entry.id, name: entry.name, version: entry.version, distribution }];
  });
}

type Entry = Awaited<ReturnType<typeof readAcpRegistry>>[number];

export async function registryWorkerManifest(entry: Entry, kind: Distribution, binaryPath?: string) {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch as 'arm64' | 'x64'];
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const selected = kind === 'binary'
    ? object(object(entry.distribution.binary)?.[platform + '-' + arch]) : object(entry.distribution[kind]);
  if (!selected) throw new Error('This ACP distribution is unavailable for the selected platform');
  const args = selected.args ?? [];
  if (!Array.isArray(args) || args.length > 30 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0'))) {
    throw new Error('Invalid ACP Registry launch arguments');
  }
  const env = Object.keys(object(selected.env) ?? {});
  if (env.length > 32 || env.some(key => !/^[A-Z_][A-Z0-9_]*$/.test(key) || /^(BLAZAR_|NODE_OPTIONS$|DYLD_|LD_)/.test(key))) {
    throw new Error('Invalid ACP Registry environment variables');
  }
  let executable: string;
  let commandArgs = args;
  if (kind === 'binary') {
    if (!binaryPath || !isAbsolute(binaryPath)) throw new Error('Provide the absolute path to the installed registry binary');
    executable = await locateWorkerExecutable(binaryPath);
  } else {
    if (binaryPath) throw new Error('Use a binary path only with the binary distribution');
    const spec = selected.package;
    const pattern = kind === 'npx'
      ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/
      : /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:==|@)[0-9][a-zA-Z0-9.+-]*$/;
    if (typeof spec !== 'string' || !pattern.test(spec)) throw new Error('The ACP Registry package must use an exact version');
    executable = await locateWorkerExecutable(kind);
    commandArgs = kind === 'npx' ? ['--yes', spec, ...args] : [spec, ...args];
  }
  return { version: 1, protocol: 'acp', label: entry.name + ' ' + entry.version, executable, args: commandArgs, env,
    ...(kind !== 'binary' && { startupTimeoutSeconds: 60 }),
    registry: { id: entry.id, version: entry.version, distribution: kind } };
}
