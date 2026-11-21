import { createHash } from 'node:crypto';
import { spawnWorker } from '../workers/process.ts';
import type { ComputerDriver, DesktopElement } from './driver.ts';

function element(value: unknown, depth = 0): DesktopElement {
  if (!value || typeof value !== 'object' || depth > 16) return { children: [] };
  const node = value as { role?: unknown; name?: unknown; available_actions?: unknown; ref_id?: unknown; children?: unknown };
  const role = typeof node.role === 'string' ? node.role : undefined;
  const name = typeof node.name === 'string' ? node.name : undefined;
  const pressReference = Array.isArray(node.available_actions) && node.available_actions.some(action => action === 'Click' || action === 'AXPress') &&
    typeof node.ref_id === 'string' && /^@[a-zA-Z0-9_-]+:e[0-9]+$/.test(node.ref_id) ? node.ref_id : undefined;
  return { role, name, pressReference,
    children: Array.isArray(node.children) ? node.children.map(child => element(child, depth + 1)) : [] };
}

export function agentDesktop(executable: string): ComputerDriver {
  return {
    async permissions(root, signal) {
      const data = await runDriver(executable, root, ['permissions'], signal);
      const keys = ['accessibility', 'screen_recording', 'automation'] as const;
      return Object.fromEntries(keys.map(key => {
        const state = data?.[key]?.state;
        return [key, typeof state === 'string' && /^[a-z_]{1,32}$/.test(state) ? state : 'unknown'];
      }));
    },
    async windows(root, app, signal) {
      const data: unknown = await runDriver(executable, root, ['list-windows', '--app', app], signal);
      if (!Array.isArray(data)) throw new Error('Invalid application window inventory.');
      return data.filter(window => window && typeof window.id === 'string' &&
        /^w-[0-9]{1,20}$/.test(window.id) && typeof window.app_name === 'string' &&
        window.app_name.toLowerCase() === app.toLowerCase() && window.visible === true)
        .map(window => ({
          id: String(window.id),
          title: typeof window.title === 'string' ? window.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120).toWellFormed() : '',
          accessible: window.accessible === true,
          instance: typeof window.process_instance === 'string' && window.process_instance.length <= 256
            ? window.process_instance : undefined,
        }));
    },
    async snapshot(root, app, signal, windowId) {
      const options = windowId ? ['--window-id', windowId] : [];
      const data = await runDriver(executable, root, ['snapshot', '--app', app, '-i', ...options], signal);
      if (!data?.tree) throw new Error('No application snapshot was available.');
      const stable = JSON.stringify(data.tree, (key, value) => key === 'ref_id' ? undefined : value);
      return { tree: element(data.tree), fingerprint: createHash('sha256').update(stable).digest('hex'),
        windowId: data.window_id, pid: data.pid };
    },
    async screenshot(root, app, windowId, path, signal) {
      await runDriver(executable, root, ['screenshot', '--app', app, '--window-id', windowId, path], signal);
    },
    async click(root, reference, signal) {
      await runDriver(executable, root, ['click', reference], signal);
    },
  };
}

async function runDriver(executable: string, root: string, argv: string[], signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker({
    executable, args: argv, label: 'Computer observation',
  }, root);
  const interrupted = Promise.withResolvers<void>();
  const abort = () => interrupted.resolve();
  active.addEventListener('abort', abort, { once: true });
  const buffers: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (buffer: Buffer) => {
    size += buffer.length;
    if (size > 512_000) interrupted.resolve();
    else buffers.push(buffer);
  });
  child.stdin.on('error', () => {});
  child.stdin.end();
  try {
    active.throwIfAborted();
    await Promise.race([closed, interrupted.promise]);
    active.throwIfAborted();
    if (size > 512_000) throw new Error('Application snapshot is too large.');
    if (child.exitCode !== 0) throw new Error('Application snapshot failed. Check the app and device permissions.');
    const envelope = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (envelope?.ok !== true || envelope.command !== argv[0]) throw new Error('Desktop operation was rejected by the driver.');
    return envelope.data;
  } finally {
    active.removeEventListener('abort', abort);
    await stop();
  }
}
