import { DocumentUnavailable, documentText, readDocumentResponse, type DocumentConnector } from './documents.ts';

const accepts = (document: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(document);

export function feishuDocuments(app: 'feishu' | 'lark', account: string,
                                token: string, transport = fetch): DocumentConnector {
  const origin = app === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return {
    app, account, accepts,
    async read(document, signal) {
      if (!accepts(document)) throw new DocumentUnavailable('Invalid document ID');
      const response = await transport(origin + '/open-apis/docx/v1/documents/' + document + '/raw_content', {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
      const payload = JSON.parse(await readDocumentResponse(response));
      const content = payload?.data?.content;
      if (payload?.code !== 0 || typeof content !== 'string') {
        throw new DocumentUnavailable('No document text was available to import');
      }
      return documentText(content);
    },
  };
}
