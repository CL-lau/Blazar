import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ComputerDriver, DesktopElement } from './driver.ts';
import { runDriverCommand } from './driver-process.ts';

const exec = promisify(execFile);

export function cuaDesktop(executable: string, socket?: string): ComputerDriver {
  async function call(root: string, tool: string, args: object, signal: AbortSignal) {
    const argv = ['call', tool, JSON.stringify(args), ...(socket ? ['--socket', socket] : [])];
    const output = (await runDriverCommand(executable, root, argv, signal)).trimStart();
    const end = output.indexOf('\n}');
    return JSON.parse(end < 0 ? output.split('\n', 1)[0] : output.slice(0, end + 2));
  }

  async function target(root: string, app: string, signal: AbortSignal) {
    const result = await call(root, 'list_apps', {}, signal);
    const apps: unknown = result?.apps;
    const matches = Array.isArray(apps) ? apps.filter(item => item?.running === true &&
      (app.startsWith('bundle:') ? item.bundle_id === app.slice(7)
        : typeof item.name === 'string' && item.name.toLowerCase() === app.toLowerCase())) : [];
    const pid = matches.length === 1 ? matches[0].pid : undefined;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The configured application did not resolve to one running process.');
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { signal, timeout: 2_000, maxBuffer: 4096 });
    if (!stdout.trim()) throw new Error('The configured application process is unavailable.');
    return { pid: Number(pid), instance: String(pid) + ':' + stdout.trim() };
  }

  async function list(root: string, pid: number, signal: AbortSignal) {
    const result = await call(root, 'list_windows', { pid, on_screen_only: true }, signal);
    const windows: unknown = result?.windows;
    if (!Array.isArray(windows)) throw new Error('Invalid CUA window inventory.');
    return windows.filter(window => window?.pid === pid && window.is_on_screen === true &&
      Number.isSafeInteger(window.window_id) && window.window_id > 0 && window.window_id <= 0xffffffff);
  }

  async function permissions(root: string, signal: AbortSignal) {
    const data = await call(root, 'check_permissions', { prompt: false }, signal);
    const status = (value: unknown) => value === true ? 'granted' : value === false ? 'denied' : 'unknown';
    return { accessibility: status(data?.accessibility), screen_recording: status(data?.screen_recording), automation: 'unknown' };
  }

  async function releaseActionSession(root: string, session: string) {
    await call(root, 'end_session', { session }, AbortSignal.timeout(2_000)).catch(() => {});
  }

  return {
    permissions,
    async windows(root, app, signal) {
      const { pid, instance } = await target(root, app, signal);
      const available = await permissions(root, signal);
      return (await list(root, pid, signal)).map(window => ({
        id: 'w-' + window.window_id,
        title: typeof window.title === 'string' ? window.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120).toWellFormed() : '',
        accessible: available.accessibility === 'granted',
        instance,
      }));
    },
    async snapshot(root, app, signal, windowId, forAction) {
      const { pid } = await target(root, app, signal);
      const windows = await list(root, pid, signal);
      const matches = windowId ? windows.filter(window => 'w-' + window.window_id === windowId) : windows;
      if (matches.length !== 1) throw new Error('Choose one window from the current application inventory.');
      const id = matches[0].window_id;
      const session = forAction ? 'blazar-' + randomUUID() : undefined;
      try {
        const data = await call(root, 'get_window_state', {
          pid, window_id: id, include_screenshot: false, tree_format: 'elements', max_elements: 200, session,
        }, signal);
        if (data?.pid !== pid || data?.window_id !== id || !Array.isArray(data.elements) || !data.elements.length) {
          throw new Error('No application snapshot was available.');
        }
        const tree: DesktopElement = { children: [] };
        const elements = new Map<number, DesktopElement>();
        for (const row of data.elements) {
          if (!Number.isSafeInteger(row?.element_index) || elements.has(row.element_index)) continue;
          const node: DesktopElement = {
            role: typeof row.subrole === 'string' && /secure|password/i.test(row.subrole) ? row.subrole
              : typeof row.role === 'string' ? row.role : undefined,
            name: typeof row.label === 'string' ? row.label : undefined,
            pressReference: row.role === 'AXButton' && Array.isArray(row.actions) && row.actions.includes('AXPress') &&
              typeof row.element_token === 'string' && /^[a-zA-Z0-9_-]+:[0-9]+$/.test(row.element_token)
              ? row.element_token : undefined,
            children: [],
          };
          (elements.get(row.parent_index) ?? tree).children.push(node);
          elements.set(row.element_index, node);
        }
        const snapshot = JSON.stringify(data.elements, (key, value) => key === 'element_token' ? undefined : value);
        return { tree, fingerprint: createHash('sha256').update(snapshot).digest('hex'), windowId: 'w-' + id, pid,
          actionSession: session };
      } catch (error) {
        if (session) await releaseActionSession(root, session);
        throw error;
      }
    },
    async screenshot(root, app, windowId, path, signal) {
      const { pid } = await target(root, app, signal);
      const matches = (await list(root, pid, signal)).filter(window => 'w-' + window.window_id === windowId);
      if (matches.length !== 1) throw new Error('Choose one window from the current application inventory.');
      const id = matches[0].window_id;
      const data = await call(root, 'get_window_state', {
        pid, window_id: id, include_accessibility_tree: false, screenshot_out_file: path, max_image_dimension: 1200,
      }, signal);
      if (data?.pid !== pid || data?.window_id !== id || data?.screenshot_file_path !== path) {
        throw new Error('The CUA screenshot did not belong to the selected window.');
      }
    },
    async click(root, reference, signal, session) {
      if (!session) throw new Error('The CUA click requires a fresh action session.');
      await call(root, 'click', { element_token: reference, action: 'press', delivery_mode: 'background', session }, signal);
    },
    releaseActionSession,
  };
}
