import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveWorker } from '../../packages/workers/registry.ts';
import { acpStartupSignal, probeAcp } from '../../packages/workers/acp.ts';

const presets = new Set(['codex-cli', 'claude-cli', 'pi', 'deepseek', 'omp']);
const configRoot = join(homedir(), '.config/blazar');
const launchAgents = join(homedir(), 'Library/LaunchAgents');
const domain = 'gui/' + process.getuid();
const generator = fileURLToPath(new URL('./launch-agent.mjs', import.meta.url));

function envValue(value) {
  const delimiter = ['"', "'", '`'].find(quote => !value.includes(quote));
  if (!delimiter || /[\0\r\n]/.test(value)) throw new Error('Unsupported character in local Agent path');
  return delimiter + value + delimiter;
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('The Agent configuration directory must be private and owned by this user.');
  }
}

async function install(input) {
  const { name, workspace, folder, mode, executable, protocol, args } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 128 ||
      typeof workspace !== 'string' || !workspace.trim() || workspace.length > 128 ||
      typeof folder !== 'string' || !isAbsolute(folder) ||
      typeof executable !== 'string' || !isAbsolute(executable) ||
      (!presets.has(mode) && mode !== 'custom')) throw new Error('Invalid Agent configuration.');
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a workspace folder.');
  try {
    execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
  } catch {
    throw new Error('Choose a Git repository with an initial commit.');
  }
  const gitRoot = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trimEnd();
  if (gitRoot !== root) throw new Error('Choose the Git repository root.');
  await privateDirectory(configRoot);
  const authPath = join(configRoot, 'router.env');
  const auth = await lstat(authPath);
  if (!auth.isFile() || auth.uid !== process.getuid() || (auth.mode & 0o077)) {
    throw new Error('The Router configuration must be private and owned by this user.');
  }
  const env = parseEnv(await readFile(authPath, 'utf8'));
  const port = Number(process.env.BLAZAR_PORT ?? env.BLAZAR_PORT ?? 4199);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !env.BLAZAR_ROUTER_TOKEN) {
    throw new Error('Set up the local Router before adding an Agent.');
  }
  const base = 'http://127.0.0.1:' + port;
  async function router(path, method, body) {
    const response = await fetch(base + '/v1/admin/devices' + path, {
      method, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(4_000),
      headers: { Authorization: 'Bearer ' + env.BLAZAR_ROUTER_TOKEN, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Router could not ' + (method === 'POST' ? 'register' : 'read or update') + ' the Agent.');
    return response.status === 204 ? undefined : response.json();
  }

  const directory = join(configRoot, 'agents');
  await privateDirectory(directory);
  await mkdir(launchAgents, { mode: 0o700, recursive: true });
  const label = 'com.blazar.agent-' + randomUUID();
  const location = join(directory, label);
  await privateDirectory(location);
  const manifest = join(location, 'manifest.json');
  const config = join(location, 'device.env');
  const plist = join(launchAgents, label + '.plist');
  let device;
  let started = false;
  try {
    if (mode === 'custom') {
      await writeFile(manifest, JSON.stringify({ version: 1, protocol, args, label: name.trim(), executable }),
        { flag: 'wx', mode: 0o600 });
    }
    const worker = await resolveWorker(mode, manifest, executable);
    if (worker.protocol === 'acp' || worker.protocol === undefined) {
      try {
        await probeAcp(worker, root, acpStartupSignal(worker));
      } catch {
        throw new Error('The Agent did not complete the ACP handshake. Check its executable and arguments.');
      }
    }

    device = await router('', 'POST', { name: name.trim(), workspace: workspace.trim() });
    const settings = {
      PATH: [...new Set([dirname(process.execPath), dirname(executable), '/opt/homebrew/bin',
        '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter),
      BLAZAR_DEVICE_TOKEN: device.token,
      BLAZAR_ROUTER_URL: base,
      BLAZAR_WORKSPACE_PATH: root,
      BLAZAR_DEVICE_WORKER: mode,
      BLAZAR_WORKER_EXECUTABLE: executable,
      ...(mode === 'custom' && { BLAZAR_WORKER_MANIFEST: manifest }),
      BLAZAR_WORKER_GIT_WORKTREE: '1',
      BLAZAR_WORKER_GIT_PATCH: '1',
      BLAZAR_WORKER_GIT_APPLY_INPUTS: '1',
      BLAZAR_CODEX_WORKTREE_WRITE: '1',
    };
    await writeFile(config, Object.entries(settings).map(([key, value]) => key + '=' + envValue(value)).join('\n') + '\n',
      { flag: 'wx', mode: 0o600 });
    execFileSync(process.execPath, [generator, 'device', config, plist], { stdio: 'ignore' });
    execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
    started = true;
    const deadline = Date.now() + 15_000;
    do {
      const { devices } = await router('', 'GET');
      if (devices.some(candidate => candidate.id === device.id && candidate.online && candidate.workerProtocol)) {
        return { id: device.id };
      }
      await delay(250);
    } while (Date.now() < deadline);
    throw new Error('The Agent did not come online. Check that the executable can run from a macOS background service.');
  } catch (error) {
    if (started) {
      try { execFileSync('/bin/launchctl', ['bootout', domain + '/' + label], { stdio: 'ignore' }); }
      catch { /* The service may already have stopped. */ }
    }
    if (device) await router('/' + device.id, 'DELETE').catch(() => {});
    await rm(plist, { force: true });
    await rm(location, { recursive: true, force: true });
    throw error;
  }
}

try {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 80_000) throw new Error('Agent configuration is too large.');
  }
  console.log(JSON.stringify(await install(JSON.parse(body))));
} catch (error) {
  console.error('Error: ' + (error instanceof Error ? error.message : 'Unable to set up Agent.'));
  process.exitCode = 1;
}
