import { createHash } from 'node:crypto';

export class DocumentUnavailable extends Error {}
export class DocumentAccessDenied extends DocumentUnavailable {}
export class DocumentBackendUnavailable extends DocumentUnavailable {}

export type DocumentConnector = {
  app: string;
  account: string;
  definition?: { label: string; version: number };
  documentAliases?: readonly string[];
  discover?(signal: AbortSignal): Promise<{ aliases: string[]; complete: boolean }>;
  accepts(document: string): boolean;
  read(document: string, signal: AbortSignal): Promise<{ text: string; revision: string }>;
};

const documentApps = new Map([
  ['feishu', 'Feishu'], ['lark', 'Lark'], ['github', 'GitHub'], ['mcp', 'MCP'],
]);

const appCapabilities = [
  { id: 'document.test', label: 'Test document access', input: ['workspace', 'document'], effect: 'read' },
  { id: 'document.import', label: 'Import document', input: ['workspace', 'document'], effect: 'local_write' },
  { id: 'document.discover', label: 'Discover available documents', input: ['workspace'], effect: 'read' },
  { id: 'document.search', label: 'Search imported documents', input: ['workspace', 'query'], effect: 'read' },
  { id: 'document.refresh', label: 'Refresh imported documents', input: ['workspace'], effect: 'local_write' },
] as const;

export type DocumentCapabilityId = typeof appCapabilities[number]['id'];

export function isDocumentCapability(value: string): value is DocumentCapabilityId {
  return appCapabilities.some(capability => capability.id === value);
}

export function documentAppCatalog(connectors: readonly DocumentConnector[]) {
  const apps = new Map([...documentApps].map(([id, label]) => [id, { label, version: 1 }]));
  for (const connector of connectors) {
    if (!apps.has(connector.app)) apps.set(connector.app, connector.definition ?? { label: connector.app, version: 1 });
  }
  return [...apps].map(([id, definition]) => ({
    id, ...definition,
    accounts: connectors.filter(connector => connector.app === id).map(connector => connector.account).sort(),
    capabilities: appCapabilities.filter(capability => capability.id !== 'document.discover' || id === 'mcp' ||
      connectors.some(connector => connector.app === id && connector.discover)),
  }));
}

export function documentCapabilityState(connection: { active: number; app: string }, reader: DocumentConnector | undefined) {
  if (!reader && !documentApps.has(connection.app)) return [];
  const state = !connection.active ? 'disconnected' : reader ? 'configured' : 'configuration_required';
  return appCapabilities.filter(capability => capability.id !== 'document.discover' || connection.app === 'mcp' || reader?.discover).map(({ id, label }) => ({ id, label, state }));
}

export async function readDocumentResponse(response: Response): Promise<string> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    const throttled = response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0';
    if ([401, 404, 410].includes(response.status) || (response.status === 403 && !throttled)) {
      throw new DocumentAccessDenied('The configured account no longer has access to this document');
    }
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
