import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [role, envPath, output, ...extra] = process.argv.slice(2);
if (process.platform !== 'darwin' || (role !== 'router' && role !== 'device') ||
    !envPath || !output || !isAbsolute(envPath) || !isAbsolute(output) || extra.length) {
  throw new Error('Usage on macOS: launch-agent.mjs <router|device> /absolute/config.env /absolute/label.plist');
}
const config = realpathSync(envPath);
const info = lstatSync(config);
if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
  throw new Error('The environment file must be owned by this user and private (chmod 600).');
}
const label = output.split('/').at(-1)?.replace(/\.plist$/, '');
if (!label || !/^com\.blazar\.[a-z0-9][a-z0-9.-]{0,100}$/.test(label) || !output.endsWith('.plist')) {
  throw new Error('Choose a com.blazar.*.plist filename.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const logDirectory = join(dirname(config), 'logs');
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const logInfo = lstatSync(logDirectory);
if (!logInfo.isDirectory() || logInfo.uid !== process.getuid() || (logInfo.mode & 0o077) !== 0) {
  throw new Error('The log directory must be owned by this user and private (chmod 700).');
}

const xml = value => String(value).replace(/[<>&"'\x00-\x1f]/g, character => {
  const entity = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character];
  if (!entity) throw new Error('Paths may not contain control characters.');
  return entity;
});
// Prefer the same binary through its PATH entry so package-manager symlinks can survive upgrades.
const runningNode = realpathSync(process.execPath);
const node = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, 'node'))
  .find(candidate => {
    try { return realpathSync(candidate) === runningNode; }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return false;
      throw error;
    }
  }) ?? process.execPath;
const args = [
  node, '--env-file=' + config, '--experimental-strip-types', join(root, 'services', role, 'main.ts'),
];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(argument => '    <string>' + xml(argument) + '</string>').join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(dirname(config))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>45</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(logDirectory, label + '.out'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDirectory, label + '.err'))}</string>
</dict>
</plist>
`;
const staging = mkdtempSync(join(dirname(output), '.blazar-launch-'));
try {
  const file = join(staging, 'agent.plist');
  writeFileSync(file, plist, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'ignore' });
  renameSync(file, output);
  console.log(output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
