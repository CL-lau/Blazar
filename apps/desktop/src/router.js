import { invoke, isTauri } from '@tauri-apps/api/core';

function routerError(message, status) {
  return Object.assign(new Error(message), { status });
}

export async function callRouter(token, path, { method = 'GET', body, key, signal } = {}) {
  if (isTauri()) {
    const response = await invoke('router_request', { call: { token, path, method, body, key } })
      .catch(failure => { throw failure instanceof Error ? failure : new Error(String(failure)); });
    const data = response.json ? JSON.parse(response.text) : response.text;
    if (response.status < 200 || response.status >= 300) {
      throw routerError(data?.error ?? `Router request failed (${response.status}).`, response.status);
    }
    return data;
  }
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch('/v1' + path, {
    method, headers, signal, redirect: 'error', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw routerError(error?.error ?? `Router request failed (${response.status}).`, response.status);
  }
  if (response.headers.get('Content-Type')?.startsWith('application/json')) return response.json();
  return response.text();
}
