import { chromium } from 'playwright-core';
import type { ActionBackend } from './actions.ts';

export function browserFormBackend(config: {
  id: string; capability: string; url: string; submitUrl: string; button: string;
  inputLabel: string; inputKey: string; storageState?: string;
}): ActionBackend {
  const pageUrl = new URL(config.url);
  const submitUrl = new URL(config.submitUrl);
  if (pageUrl.origin !== submitUrl.origin || [pageUrl, submitUrl].some(url =>
    url.username || url.password || url.hash || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1')))) {
    throw new Error('Browser form URLs must share an HTTPS or loopback HTTP origin');
  }
  return {
    id: config.id, capability: config.capability, connectionId: '', effect: 'write',
    async invoke(action, signal, authorizeDispatch) {
      const value = action.input[config.inputKey];
      if (typeof value !== 'string' || Object.keys(action.input).length !== 1) return { status: 'denied' };
      signal.throwIfAborted();
      const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, timeout: 4_000 });
      const stop = () => { void browser.close().catch(() => {}); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        signal.throwIfAborted();
        const context = await browser.newContext({
          storageState: config.storageState, serviceWorkers: 'block', acceptDownloads: false,
        });
        let readyToSubmit = false;
        let attempted = false;
        let sent = false;
        let dispatchDenied = false;
        await context.routeWebSocket('**/*', socket => { void socket.close(); });
        await context.route('**/*', async route => {
          const request = route.request();
          const target = new URL(request.url());
          if (target.origin !== pageUrl.origin) return route.abort();
          if (request.method() === 'POST' && readyToSubmit && !attempted && target.href === submitUrl.href) {
            attempted = true;
            if (signal.aborted || !await authorizeDispatch() || signal.aborted) {
              dispatchDenied = true;
              return route.abort();
            }
            sent = true;
          } else if (request.method() !== 'GET') {
            return route.abort();
          }
          try {
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 4_000 });
            if (response.status() < 300 || response.status() >= 400) {
              await route.fulfill({ response });
              return;
            }
          } catch {
            // A failed fetch after send is classified by the missing response below.
          }
          await route.abort().catch(() => {});
        });
        const page = await context.newPage();
        const loaded = await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded', timeout: 4_000 });
        if (!loaded?.ok() || page.url() !== pageUrl.href) return { status: 'denied' };
        const input = page.getByLabel(config.inputLabel, { exact: true });
        const button = page.getByRole('button', { name: config.button, exact: true });
        if (await input.count() !== 1 || await button.count() !== 1) return { status: 'denied' };
        await input.fill(value, { timeout: 2_000 });
        if (!await authorizeDispatch()) return { status: 'denied' };
        signal.throwIfAborted();
        readyToSubmit = true;
        const [response] = await Promise.all([
          page.waitForResponse(item => item.url() === submitUrl.href && item.request().method() === 'POST', { timeout: 4_000 }),
          button.click({ timeout: 2_000 }),
        ]).catch(error => {
          if (dispatchDenied) return [undefined];
          throw error;
        });
        if (dispatchDenied) return { status: 'denied' };
        if (!sent || !response?.ok()) throw new Error('Browser form did not confirm the write');
        return { status: 'succeeded', output: { status: response.status() } };
      } finally {
        signal.removeEventListener('abort', stop);
        await browser.close().catch(() => {});
      }
    },
  };
}
