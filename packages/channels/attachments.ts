export async function readAttachmentBytes(response: Response, maxBytes: number) {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) return undefined;
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export function decodeAttachmentText(bytes: Uint8Array) {
  if (bytes.byteLength > 8_192) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

export async function readAttachmentText(response: Response) {
  const bytes = await readAttachmentBytes(response, 8_192);
  return bytes && decodeAttachmentText(bytes);
}
