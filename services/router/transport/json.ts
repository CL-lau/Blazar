import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from '../protocol/request.ts';

export async function jsonBody(request: IncomingMessage, limit = 65_536) {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new RequestError(415, 'Expected application/json');
  }
  let size = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new RequestError(413, 'Request too large');
    }
    buffers.push(chunk);
  }
  try {
    const raw = Buffer.concat(buffers);
    const data = JSON.parse(raw.toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return { body: data as Record<string, unknown>, raw };
  } catch {
    throw new RequestError(400, 'Expected a JSON object');
  }
}

export async function jsonObject(request: IncomingMessage, limit?: number) {
  return (await jsonBody(request, limit)).body;
}

export function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
