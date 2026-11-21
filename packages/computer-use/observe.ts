import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lockDatabaseFile } from '../storage/exclusive.ts';
import { agentDesktop } from './agent-desktop.ts';
import type { ComputerDriver, DesktopElement } from './driver.ts';

export type ObservationConfig = {
  executable: string;
  driver: ComputerDriver;
  apps: ReadonlyMap<string, string>;
  visualApps?: ReadonlySet<string>;
  buttons?: ReadonlyMap<string, ReadonlySet<string>>;
  desktopLockPath?: string;
  sessionLocked?: (signal: AbortSignal) => Promise<boolean>;
};

const runCommand = promisify(execFile);

async function macSessionLocked(signal: AbortSignal) {
  const { stdout } = await runCommand('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], {
    signal, timeout: 2_000, maxBuffer: 256_000,
  });
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes\b/.test(stdout);
}

export class DesktopSessionLocked extends Error {
  constructor() { super('The desktop session is locked. Unlock the computer before retrying.'); }
}

async function assertDesktopUnlocked(config: ObservationConfig, signal: AbortSignal) {
  signal.throwIfAborted();
  if (await config.sessionLocked?.(signal)) throw new DesktopSessionLocked();
}

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
  const visual = JSON.parse(env.BLAZAR_COMPUTER_VISUAL_APPS ?? '[]');
  if (!Array.isArray(visual) || visual.length > apps.size || visual.some(alias => !apps.has(alias))) {
    throw new Error('Configure visual capture with approved application aliases.');
  }
  return { executable, driver: agentDesktop(executable), apps, buttons, visualApps: new Set(visual), desktopLockPath,
    sessionLocked: process.platform === 'darwin' ? macSessionLocked : undefined };
}

function describeTree(input: DesktopElement) {
  const rows: string[] = [];
  function visit(item: DesktopElement, depth: number) {
    if (rows.length >= 80 || depth >= 10) return;
    const role = typeof item.role === 'string' ? item.role.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) : '';
    if (/secure|password/i.test(role)) return;
    if (role) {
      const name = typeof item.name === 'string' ? item.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) : '';
      rows.push('  '.repeat(depth) + role + (name ? ': ' + name : ''));
    }
    for (const child of item.children.slice(0, 80)) visit(child, depth + 1);
  }
  visit(input, 0);
  return rows.join('\n').slice(0, 4_000).toWellFormed();
}

export function probeComputer(config: ObservationConfig, root: string, signal: AbortSignal) {
  return config.driver.permissions(root, signal);
}

function windowIdentity(app: string, window: { id: string; instance?: string; title: string }) {
  if (!window.instance) return undefined;
  return createHash('sha256').update(JSON.stringify([app, window.id, window.instance, window.title])).digest('hex');
}

async function accessibleWindow(config: ObservationConfig, root: string, app: string, id: string, signal: AbortSignal,
                                identity?: string) {
  const windows = await config.driver.windows(root, app, signal);
  const found = windows.filter(window => window.id === id && window.accessible);
  if (found.length !== 1) throw new Error('The selected window is unavailable or inaccessible.');
  if (identity && windowIdentity(app, found[0]) !== identity) {
    throw new Error('The selected window changed. Refresh the window list.');
  }
  return found[0];
}

async function withDesktopLock<T>(config: ObservationConfig, signal: AbortSignal, operation: () => Promise<T>) {
  signal.throwIfAborted();
  const unlock = config.desktopLockPath
    ? lockDatabaseFile(config.desktopLockPath, 'Another Blazar run is using the desktop. Retry this action.')
    : undefined;
  try {
    await assertDesktopUnlocked(config, signal);
    return await operation();
  }
  finally { unlock?.(); }
}

export function observeApp(config: ObservationConfig, root: string, goal: string, signal: AbortSignal) {
  return withDesktopLock(config, signal, () => observeWindow(config, root, goal, signal));
}

export function captureWindow(config: ObservationConfig, root: string, alias: string, id: string,
                              identity: string, signal: AbortSignal) {
  return withDesktopLock(config, signal, () => captureWindowImage(config, root, alias, id, identity, signal));
}

export function observeWindowWithImage(config: ObservationConfig, root: string, alias: string, id: string,
                                       identity: string, signal: AbortSignal) {
  return withDesktopLock(config, signal, async () => {
    const image = await captureWindowImage(config, root, alias, id, identity, signal);
    const text = await observeWindow(config, root, '/observe ' + alias + ' --window ' + id + ' --instance ' + identity, signal);
    return { image, text };
  });
}

async function captureWindowImage(config: ObservationConfig, root: string, alias: string, id: string,
                                  identity: string, signal: AbortSignal) {
  const app = config.apps.get(alias);
  if (!app || !config.visualApps?.has(alias) || !/^w-[0-9]{1,20}$/.test(id) || !/^[a-f0-9]{64}$/.test(identity)) {
    throw new Error('Choose a window from the current application inventory.');
  }
  const permissions = await probeComputer(config, root, signal);
  if (permissions.screen_recording !== 'granted') {
    throw new Error('Screen Recording permission is required for window screenshots.');
  }
  const assertPresent = async () => {
    const matches = (await config.driver.windows(root, app, signal)).filter(window => window.id === id);
    if (matches.length !== 1 || windowIdentity(app, matches[0]) !== identity) {
      throw new Error('The selected window changed. Refresh the window list.');
    }
  };
  await assertPresent();
  const scratch = await mkdtemp(join(tmpdir(), 'blazar-window-image-'));
  try {
    const path = join(scratch, 'window.png');
    await config.driver.screenshot(root, app, id, path, signal);
    await assertPresent();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const limit = 1_000_000;
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 33 || stat.size > limit) throw new Error('Window image has an invalid size.');
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (bytesRead !== buffer.length || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR' ||
          !width || !height || width * height > 16_000_000) throw new Error('Window image is not a supported PNG.');
      signal.throwIfAborted();
      return buffer;
    } finally {
      await file.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function observeWindow(config: ObservationConfig, root: string, goal: string, signal: AbortSignal) {
  const match = /^\/observe ([a-z0-9_-]{1,32})(?: (--windows(?:-json)?)| --window (w-[0-9]{1,20})(?: --instance ([a-f0-9]{64}))?)?$/.exec(goal);
  const app = match && config.apps.get(match[1]);
  if (!app || !match) throw new Error('Choose a configured application alias for /observe.');
  if (match[2]) {
    const windows = await config.driver.windows(root, app, signal);
    if (match[2] === '--windows-json') {
      return JSON.stringify(windows.slice(0, 25).map(window => ({
        id: window.id, title: window.title, accessible: window.accessible, identity: windowIdentity(app, window),
      })));
    }
    return windows.slice(0, 25).map(window =>
      [window.id, window.title || 'Untitled', window.accessible ? 'Accessible' : 'Accessibility unavailable'].join(' · ')
    ).join('\n') || 'No visible windows found.';
  }
  const windowId = match[3];
  const identity = match[4];
  if (windowId) await accessibleWindow(config, root, app, windowId, signal, identity);
  const snapshot = await config.driver.snapshot(root, app, signal, windowId);
  if (windowId && identity) await accessibleWindow(config, root, app, windowId, signal, identity);
  const description = describeTree(snapshot.tree);
  if (!description) throw new Error('No accessible elements were found.');
  return description;
}

function buttonIn(tree: DesktopElement, label: string) {
  const matches: { ref: string; path: string }[] = [];
  function visit(node: DesktopElement, path: string, depth: number) {
    if (depth > 16) return;
    if (node.name === label && (node.role === 'button' || node.role === 'AXButton') && node.pressReference) {
      matches.push({ ref: node.pressReference, path });
    }
    node.children.forEach((child, index) => visit(child, path + '.' + index, depth + 1));
  }
  visit(tree, '0', 0);
  if (matches.length !== 1) throw new Error('The configured button must be uniquely visible.');
  return matches[0];
}

export class DesktopResultUnverified extends Error {
  constructor() { super('The click may have been applied. Check the application before retrying.'); }
}

export async function clickApp(config: ObservationConfig, root: string, goal: string, signal: AbortSignal,
                               authorize: (summary: string, signal: AbortSignal) => Promise<(() => Promise<boolean>) | undefined>,
                               expectedText?: string) {
  const match = /^\/click ([a-z0-9_-]{1,32})(?: --window (w-[0-9]{1,20})(?: --instance ([a-f0-9]{64}))?)? (.{1,120})$/.exec(goal);
  const app = match && config.apps.get(match[1]);
  if (!app || !match || !config.buttons?.get(match[1])?.has(match[4])) throw new Error('Choose a configured application button.');
  const windowId = match[2];
  const identity = match[3];
  const label = match[4];
  const { initialWindow, initial, button, summary } = await withDesktopLock(config, signal, async () => {
    const initialWindow = windowId ? await accessibleWindow(config, root, app, windowId, signal, identity) : undefined;
    if (initialWindow && !initialWindow.instance) throw new Error('The driver cannot identify the selected window process.');
    const initial = await config.driver.snapshot(root, app, signal, windowId);
    return { initialWindow, initial, button: buttonIn(initial.tree, label), summary: describeTree(initial.tree) };
  });
  if (expectedText && summary.includes(expectedText)) {
    throw new Error('The expected text is already visible. Review the window before clicking.');
  }
  const expected = expectedText ? ` Expected visible text: "${expectedText}".` : '';
  const consume = await authorize(`Click "${label}" in ${app}${windowId ? ` window ${windowId}` : ''}.${expected}`, signal);
  if (!consume) throw new Error('Desktop action was not approved.');
  return withDesktopLock(config, signal, async () => {
    if (windowId) {
      const currentWindow = await accessibleWindow(config, root, app, windowId, signal, identity);
      if (currentWindow.instance !== initialWindow?.instance) {
        throw new Error('The application changed after review. Request a new action.');
      }
    }
    const current = await config.driver.snapshot(root, app, signal, windowId);
    const latest = buttonIn(current.tree, label);
    if (current.fingerprint !== initial.fingerprint || latest.path !== button.path ||
        initial.windowId !== current.windowId || initial.pid !== current.pid) {
      throw new Error('The application changed after review. Request a new action.');
    }
    await assertDesktopUnlocked(config, signal);
    if (!await consume()) throw new Error('Desktop approval is no longer valid.');
    signal.throwIfAborted();
    try {
      await assertDesktopUnlocked(config, signal);
      await config.driver.click(root, latest.ref, signal);
      const refreshed = await config.driver.snapshot(root, app, signal, windowId);
      if (initial.windowId !== refreshed.windowId || initial.pid !== refreshed.pid) throw new DesktopResultUnverified();
      if (windowId) {
        const verifiedWindow = await accessibleWindow(config, root, app, windowId, signal);
        if (verifiedWindow.instance !== initialWindow?.instance) throw new DesktopResultUnverified();
      }
      const result = describeTree(refreshed.tree);
      if (!result || result === summary || (expectedText && !result.includes(expectedText))) throw new DesktopResultUnverified();
      return result;
    } catch {
      throw new DesktopResultUnverified();
    }
  });
}
