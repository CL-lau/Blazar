import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv } from 'node:util';

if (process.platform !== 'darwin') throw new Error('Set up the local Router on macOS.');
const { values } = parseArgs({ options: {
  'config-dir': { type: 'string', default: join(homedir(), '.config', 'blazar') },
  'launch-agents-dir': { type: 'string', default: join(homedir(), 'Library', 'LaunchAgents') },
  start: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
} });
const configDirectory = values['config-dir'];
const launchAgentsDirectory = values['launch-agents-dir'];
if (!isAbsolute(configDirectory) || !isAbsolute(launchAgentsDirectory)) {
  throw new Error('Use absolute configuration and LaunchAgents paths.');
}
function routerPort(value) {
  const port = Number(value ?? 4199);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BLAZAR_PORT');
  return port;
}

mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
const directoryInfo = lstatSync(configDirectory);
if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o077) !== 0) {
  throw new Error('The Router configuration directory must be private and owned by this user.');
}
const config = join(configDirectory, 'router.env');
try {
  writeFileSync(config, 'BLAZAR_ROUTER_TOKEN=' + randomBytes(32).toString('hex') + '\nBLAZAR_PORT=' + routerPort(process.env.BLAZAR_PORT) + '\n',
    { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const configInfo = lstatSync(config);
if (!configInfo.isFile() || configInfo.uid !== process.getuid() || (configInfo.mode & 0o077) !== 0) {
  throw new Error('The Router environment file must be private and owned by this user.');
}

const environment = parseEnv(readFileSync(config, 'utf8'));
const port = routerPort(environment.BLAZAR_PORT);
const token = environment.BLAZAR_ROUTER_TOKEN;
if (!token || token.length < 32) throw new Error('The Router environment file needs a valid administrator token.');

const label = 'com.blazar.router';
mkdirSync(launchAgentsDirectory, { recursive: true, mode: 0o700 });
const plist = join(launchAgentsDirectory, label + '.plist');
const generator = fileURLToPath(new URL('./launch-agent.mjs', import.meta.url));
if (!existsSync(plist)) {
  execFileSync(process.execPath, [generator, 'router', config, plist], { stdio: 'inherit' });
}
const plistInfo = lstatSync(plist);
if (!plistInfo.isFile() || plistInfo.uid !== process.getuid() || (plistInfo.mode & 0o022) !== 0) {
  throw new Error('The Router LaunchAgent must be an owned, non-writable-by-others file.');
}
const args = JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], { encoding: 'utf8' }));
if (!Array.isArray(args) || !args.includes('--env-file=' + realpathSync(config))) {
  throw new Error('The existing Router LaunchAgent points to a different configuration.');
}
console.log('Router configuration ' + config);
console.log('Router LaunchAgent ' + plist);
if (values.start) {
  const domain = 'gui/' + process.getuid();
  try {
    execFileSync('/bin/launchctl', ['print', domain + '/' + label], { stdio: 'ignore' });
  } catch {
    execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
  }
}

if (values.start || values.check) {
  const deadline = AbortSignal.timeout(10_000);
  const base = 'http://127.0.0.1:' + port;
  const log = join(configDirectory, 'logs', label + '.err');
  try {
    for (;;) {
      const signal = () => AbortSignal.any([deadline, AbortSignal.timeout(800)]);
      const health = await fetch(base + '/v1/health', { redirect: 'error', signal: signal() })
        .then(async result => {
          if (result.ok) return result.json();
          await result.body?.cancel();
          return null;
        }).catch(() => null);
      if (health?.service === 'blazar-router' && health.status === 'ready') {
        const response = await fetch(base + '/v1/state', {
          headers: { Authorization: 'Bearer ' + token },
          redirect: 'error', signal: signal(),
        }).catch(() => undefined);
        await response?.body?.cancel();
        if (response?.status === 200 && response.headers.get('content-type')?.startsWith('application/json')) {
          console.log('Router ready at ' + base);
          break;
        }
        if (response?.status === 401 || response?.status === 403) {
          throw new Error('The service on the configured port rejected this Router token.');
        }
      }
      await delay(200, undefined, { signal: deadline });
    }
  } catch (error) {
    if (!deadline.aborted) throw error;
    throw new Error('Router did not become ready at ' + base + '. Check ' + log + '.');
  }
}
