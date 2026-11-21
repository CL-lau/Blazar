import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const inventory = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' });
if (inventory.error || inventory.status !== 0) {
  console.error('Select a full Xcode installation with an iOS Simulator runtime to run the tests.');
  console.error(inventory.error?.message ?? inventory.stderr.trim());
  process.exit(1);
}
const devices = Object.entries(JSON.parse(inventory.stdout).devices)
  .filter(([runtime]) => runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'))
  .sort(([left], [right]) => right.localeCompare(left, 'en', { numeric: true }))
  .flatMap(([, simulators]) => simulators)
  .filter(device => device.isAvailable && device.name.startsWith('iPhone'));
const simulator = devices.find(device => device.state === 'Booted') ?? devices[0];
if (!simulator) throw new Error('Install an iOS simulator runtime with an available iPhone.');

const result = spawnSync('xcodebuild', [
  'test', '-project', 'Blazar.xcodeproj', '-scheme', 'Blazar',
  '-destination', 'id=' + simulator.udid, '-derivedDataPath', 'build',
  '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO',
], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
