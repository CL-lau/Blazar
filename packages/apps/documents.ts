import { createHash } from 'node:crypto';

export class DocumentUnavailable extends Error {}

export type DocumentConnector = {
  app: string;
  account: string;
  documentAliases?: readonly string[];
  accepts(document: string): boolean;
  read(document: string, signal: AbortSignal): Promise<{ text: string; revision: string }>;
};

export async function readDocumentResponse(response: Response): Promise<string> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new DocumentUnavailable('Document could not be read with the configured account');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512_000) {
        await reader.cancel();
        throw new DocumentUnavailable('Document exceeds the import limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export function documentText(content: string) {
  if (!content.trim() || content.includes('\0')) {
    throw new DocumentUnavailable('No document text was available to import');
  }
  const revision = 'sha256:' + createHash('sha256').update(content).digest('hex');
  return { text: content.slice(0, 16_000).toWellFormed(), revision };
}
