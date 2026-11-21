import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

if (process.platform !== 'darwin') throw new Error('Set up the local Router on macOS.');
const { values } = parseArgs({ options: {
  'config-dir': { type: 'string', default: join(homedir(), '.config', 'blazar') },
  'launch-agents-dir': { type: 'string', default: join(homedir(), 'Library', 'LaunchAgents') },
  start: { type: 'boolean', default: false },
} });
const configDirectory = values['config-dir'];
const launchAgentsDirectory = values['launch-agents-dir'];
if (!isAbsolute(configDirectory) || !isAbsolute(launchAgentsDirectory)) {
  throw new Error('Use absolute configuration and LaunchAgents paths.');
}
const port = Number(process.env.BLAZAR_PORT ?? 4199);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BLAZAR_PORT');

mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
const directoryInfo = lstatSync(configDirectory);
if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o077) !== 0) {
  throw new Error('The Router configuration directory must be private and owned by this user.');
}
const config = join(configDirectory, 'router.env');
try {
  writeFileSync(config, 'BLAZAR_ROUTER_TOKEN=' + randomBytes(32).toString('hex') + '\nBLAZAR_PORT=' + port + '\n',
    { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const configInfo = lstatSync(config);
if (!configInfo.isFile() || configInfo.uid !== process.getuid() || (configInfo.mode & 0o077) !== 0) {
  throw new Error('The Router environment file must be private and owned by this user.');
}

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
if (values.start) {
  const domain = 'gui/' + process.getuid();
  try {
    execFileSync('/bin/launchctl', ['print', domain + '/' + label], { stdio: 'ignore' });
  } catch {
    execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
  }
}
console.log('Router configuration ' + config);
console.log('Router LaunchAgent ' + plist);
