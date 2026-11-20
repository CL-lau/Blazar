import { isAbsolute } from 'node:path';
import { lockDatabaseFile } from '../storage/exclusive.ts';
import { spawnWorker } from '../workers/process.ts';

export type ObservationConfig = {
  executable: string;
  apps: ReadonlyMap<string, string>;
  buttons?: ReadonlyMap<string, ReadonlySet<string>>;
  desktopLockPath?: string;
};

export function observationConfig(env: NodeJS.ProcessEnv, desktopLockPath?: string): ObservationConfig {
  const executable = env.BLAZAR_COMPUTER_DRIVER;
  if (!executable || !isAbsolute(executable)) throw new Error('Set an absolute computer driver executable path');
  const raw = JSON.parse(env.BLAZAR_COMPUTER_APPS ?? '{}');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid computer app configuration');
  const apps = new Map<string, string>();
  for (const [alias, app] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(alias) || typeof app !== 'string' ||
        !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u.test(app)) throw new Error('Invalid computer app entry');
    apps.set(alias, app);
  }
  if (!apps.size || apps.size > 25) throw new Error('Configure 1 to 25 approved applications');
  const configured = JSON.parse(env.BLAZAR_COMPUTER_BUTTONS ?? '{}');
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('Invalid button configuration');
  const buttons = new Map<string, ReadonlySet<string>>();
  for (const [alias, values] of Object.entries(configured)) {
    if (!apps.has(alias) || !Array.isArray(values) || values.length > 25 ||
        values.some(value => typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value))) {
      throw new Error('Invalid configured button');
    }
    buttons.set(alias, new Set(values as string[]));
  }
  return { executable, apps, buttons, desktopLockPath };
}

function describeTree(input: unknown) {
  const rows: string[] = [];
  function visit(node: unknown, depth: number) {
    if (!node || typeof node !== 'object' || rows.length >= 80 || depth >= 10) return;
    const item = node as { role?: unknown; name?: unknown; children?: unknown };
    const role = typeof item.role === 'string' ? item.role.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) : '';
    if (/secure|password/i.test(role)) return;
    if (role) {
      const name = typeof item.name === 'string' ? item.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) : '';
      rows.push('  '.repeat(depth) + role + (name ? ': ' + name : ''));
    }
    if (Array.isArray(item.children)) {
      for (const child of item.children.slice(0, 80)) visit(child, depth + 1);
    }
  }
  visit(input, 0);
  return rows.join('\n').slice(0, 4_000).toWellFormed();
}

export async function probeComputer(config: ObservationConfig, root: string, signal: AbortSignal) {
  const data = await runDriver(config, root, ['permissions'], signal);
  const keys = ['accessibility', 'screen_recording', 'automation'] as const;
  return Object.fromEntries(keys.map(key => {
    const state = data?.[key]?.state;
    return [key, typeof state === 'string' && /^[a-z_]{1,32}$/.test(state) ? state : 'unknown'];
  }));
}

async function windowsFor(config: ObservationConfig, root: string, app: string, signal: AbortSignal) {
  const data: unknown = await runDriver(config, root, ['list-windows', '--app', app], signal);
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
}

async function accessibleWindow(config: ObservationConfig, root: string, app: string, id: string, signal: AbortSignal) {
  const windows = await windowsFor(config, root, app, signal);
  const found = windows.filter(window => window.id === id && window.accessible);
  if (found.length !== 1) throw new Error('The selected window is unavailable or inaccessible.');
  return found[0];
}

async function withDesktopLock<T>(config: ObservationConfig, signal: AbortSignal, operation: () => Promise<T>) {
  signal.throwIfAborted();
  const unlock = config.desktopLockPath
    ? lockDatabaseFile(config.desktopLockPath, 'Another Blazar run is using the desktop. Retry this action.')
    : undefined;
  try { return await operation(); }
  finally { unlock?.(); }
}

export function observeApp(config: ObservationConfig, root: string, goal: string, signal: AbortSignal) {
  return withDesktopLock(config, signal, () => observeWindow(config, root, goal, signal));
}

async function observeWindow(config: ObservationConfig, root: string, goal: string, signal: AbortSignal) {
  const match = /^\/observe ([a-z0-9_-]{1,32})(?: (--windows)| --window (w-[0-9]{1,20}))?$/.exec(goal);
  const app = match && config.apps.get(match[1]);
  if (!app || !match) throw new Error('Choose a configured application alias for /observe.');
  if (match[2]) {
    const windows = await windowsFor(config, root, app, signal);
    return windows.slice(0, 25).map(window =>
      [window.id, window.title || 'Untitled', window.accessible ? 'Accessible' : 'Accessibility unavailable'].join(' · ')
    ).join('\n') || 'No visible windows found.';
  }
  const windowId = match[3];
  if (windowId) await accessibleWindow(config, root, app, windowId, signal);
  const snapshot = await readSnapshot(config, root, app, signal, windowId);
  const description = describeTree(snapshot.tree);
  if (!description) throw new Error('No accessible elements were found.');
  return description;
}

async function readSnapshot(config: ObservationConfig, root: string, app: string, signal: AbortSignal, windowId?: string) {
  const options = windowId ? ['--window-id', windowId] : [];
  const data = await runDriver(config, root, ['snapshot', '--app', app, '-i', ...options], signal);
  if (!data?.tree) throw new Error('No application snapshot was available.');
  return data;
}

async function runDriver(config: ObservationConfig, root: string, argv: string[], signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker({
    executable: config.executable, args: argv, label: 'Computer observation',
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

function buttonIn(tree: unknown, label: string) {
  const matches: { ref: string; path: string }[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (!value || typeof value !== 'object' || depth > 16) return;
    const node = value as { name?: unknown; role?: unknown; ref_id?: unknown; children?: unknown; available_actions?: unknown };
    if (node.name === label && ['button', 'AXButton'].includes(String(node.role)) &&
        Array.isArray(node.available_actions) && node.available_actions.some(action => ['Click', 'AXPress'].includes(action)) &&
        typeof node.ref_id === 'string' && /^@[a-zA-Z0-9_-]+:e[0-9]+$/.test(node.ref_id)) {
      matches.push({ ref: node.ref_id, path });
    }
    if (Array.isArray(node.children)) node.children.forEach((child, index) => visit(child, path + '.' + index, depth + 1));
  }
  visit(tree, '0', 0);
  if (matches.length !== 1) throw new Error('The configured button must be uniquely visible.');
  return matches[0];
}

export async function clickApp(config: ObservationConfig, root: string, goal: string, signal: AbortSignal,
                               authorize: (summary: string, signal: AbortSignal) => Promise<(() => Promise<boolean>) | undefined>) {
  const match = /^\/click ([a-z0-9_-]{1,32})(?: --window (w-[0-9]{1,20}))? (.{1,120})$/.exec(goal);
  const app = match && config.apps.get(match[1]);
  if (!app || !match || !config.buttons?.get(match[1])?.has(match[3])) throw new Error('Choose a configured application button.');
  const windowId = match[2];
  const label = match[3];
  const { initialWindow, initial, button, summary } = await withDesktopLock(config, signal, async () => {
    const initialWindow = windowId ? await accessibleWindow(config, root, app, windowId, signal) : undefined;
    if (initialWindow && !initialWindow.instance) throw new Error('The driver cannot identify the selected window process.');
    const initial = await readSnapshot(config, root, app, signal, windowId);
    return { initialWindow, initial, button: buttonIn(initial.tree, label), summary: describeTree(initial.tree) };
  });
  const consume = await authorize(`Click "${label}" in ${app}${windowId ? ` window ${windowId}` : ''}.`, signal);
  if (!consume) throw new Error('Desktop action was not approved.');
  return withDesktopLock(config, signal, async () => {
    if (windowId) {
      const currentWindow = await accessibleWindow(config, root, app, windowId, signal);
      if (currentWindow.instance !== initialWindow?.instance) {
        throw new Error('The application changed after review. Request a new action.');
      }
    }
    const current = await readSnapshot(config, root, app, signal, windowId);
    const latest = buttonIn(current.tree, label);
    if (describeTree(current.tree) !== summary || latest.path !== button.path ||
        initial.window_id !== current.window_id || initial.pid !== current.pid) {
      throw new Error('The application changed after review. Request a new action.');
    }
    signal.throwIfAborted();
    if (!await consume()) throw new Error('Desktop approval is no longer valid.');
    signal.throwIfAborted();
    await runDriver(config, root, ['click', latest.ref], signal);
    const refreshed = await readSnapshot(config, root, app, signal, windowId).catch(() => undefined);
    return refreshed ? describeTree(refreshed.tree) : 'Click completed; the application could not be observed afterward.';
  });
}
