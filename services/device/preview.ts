import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const limit = 64 * 1024;

export async function preview(root: string, goal: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const name = goal.slice('/preview '.length).trim();
  if (!goal.startsWith('/preview ') || !name || isAbsolute(name)) {
    throw new Error('Use /preview with a relative path.');
  }
  const path = await realpath(resolve(root, name)).catch(() => {
    throw new Error('Document is unavailable.');
  });
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    throw new Error('The document must be inside the workspace.');
  }
  if (!/\.(?:txt|md)$/i.test(path)) throw new Error('Choose a text or Markdown document.');
  const file = await open(path, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > limit) throw new Error('Document must be a regular file under 64 KiB.');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > limit) throw new Error('Document exceeds 64 KiB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return text.trim() ? Array.from(text).slice(0, 8_000).join('') : '(Empty document)';
  } finally {
    await file.close();
  }
}
