import { observationConfig, probeComputer } from '../../packages/computer-use/observe.ts';
import { realpath, stat } from 'node:fs/promises';
import { probePi } from '../../packages/workers/pi.ts';
import { probeAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const [mode = process.env.BLAZAR_DEVICE_WORKER, ...extra] = process.argv.slice(2);
if (!mode || mode === 'preview' || extra.length) {
  console.error('Usage: npm run device:probe -- <worker-preset|custom|observe>');
  process.exitCode = 2;
} else {
  try {
    if (mode === 'observe') {
      const root = await realpath(process.env.BLAZAR_WORKSPACE_PATH ?? process.cwd());
      if (!(await stat(root)).isDirectory()) throw new Error('Workspace must be a directory');
      const config = observationConfig(process.env);
      const permissions = await probeComputer(config, root, AbortSignal.timeout(5000));
      console.log(JSON.stringify({ driver: config.executable, permissions }, null, 2));
    } else {
      const worker = await resolveWorker(mode, process.env.BLAZAR_WORKER_MANIFEST, process.env.BLAZAR_WORKER_EXECUTABLE);
      if (!worker) throw new Error('Worker not configured');
      const protocol = worker.protocol ?? 'acp';
      const credentials = Object.fromEntries((worker.env ?? [])
        .filter(name => /KEY|TOKEN|CREDENTIAL/i.test(name))
        .map(name => [name, Boolean(process.env[name])]));
      let handshake;
      if (protocol === 'acp' || protocol === 'pi') {
        const root = await realpath(process.env.BLAZAR_WORKSPACE_PATH ?? process.cwd());
        if (!(await stat(root)).isDirectory()) throw new Error('Workspace must be a directory');
        handshake = await (protocol === 'pi' ? probePi : probeAcp)(worker, root, AbortSignal.timeout(5000));
      }
      console.log(JSON.stringify({
        label: worker.label, protocol, executable: worker.executable, credentials,
        executableChecked: protocol !== 'claude' || worker.executable !== 'claude',
        handshake: handshake ?? null, providerLogin: 'unverified',
      }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker probe failed');
    process.exitCode = 1;
  }
}
