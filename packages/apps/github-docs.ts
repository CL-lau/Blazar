import { DocumentUnavailable, documentText, readDocumentResponse, type DocumentConnector } from './documents.ts';

const accepts = (path: string) => path.length <= 128 && /\.(md|markdown|txt)$/i.test(path) &&
  path.split('/').every(segment => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..');

export function githubDocuments(account: string, repository: string, token: string, transport = fetch):
    DocumentConnector & Required<Pick<DocumentConnector, 'health'>> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) || /\/(\.|\.\.)$/.test(repository)) {
    throw new Error('GitHub document repository must use owner/repo format');
  }
  return {
    app: 'github', account, accepts,
    async health(signal) {
      const response = await transport('https://api.github.com/repos/' + repository, {
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        redirect: 'error',
        signal,
      });
      await readDocumentResponse(response);
    },
    async read(path, signal) {
      if (!accepts(path)) throw new DocumentUnavailable('Invalid repository document path');
      const response = await transport('https://api.github.com/repos/' + repository + '/contents/' + path, {
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        redirect: 'error',
        signal,
      });
      return documentText(await readDocumentResponse(response));
    },
  };
}
