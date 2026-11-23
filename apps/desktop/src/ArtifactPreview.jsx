import React, { useState } from 'react';
import { DiffPanelShell } from './vendor/t3/DiffPanelShell.tsx';

function checkoutReport(preview) {
  if (preview.name !== 'git-changes.json') return null;
  try {
    const report = JSON.parse(preview.text);
    return report?.version === 1 && typeof report.baseCommit === 'string' && Array.isArray(report.changes) ? report : null;
  } catch {
    return null;
  }
}

function Diff({ text, git }) {
  let oldLine;
  let newLine;
  return <pre className="diff-preview">{text.replace(/\n$/, '').split('\n').map((line, index) => {
    if (line.startsWith('diff --git ')) oldLine = newLine = undefined;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    }
    const inHunk = !hunk && oldLine !== undefined;
    const header = hunk || (git ? !inHunk : index < 3);
    const kind = header ? 'header' : line[0] === '+' ? 'addition' : line[0] === '-' ? 'deletion' : undefined;
    const before = inHunk && [' ', '-'].includes(line[0]) ? oldLine++ : '';
    const after = inHunk && [' ', '+'].includes(line[0]) ? newLine++ : '';
    return <span key={index} data-kind={kind}>{git && <i aria-hidden="true">{String(before).padStart(4)} {String(after).padStart(4)}  </i>}{line || ' '}</span>;
  })}</pre>;
}

function GitDiff({ patch, fileStats, canExport, deliver }) {
  const [selected, setSelected] = useState(0);
  const files = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const stats = new Map((Array.isArray(fileStats) ? fileStats : []).filter(file => typeof file?.path === 'string')
    .map(file => [file.path, file]));
  function downloadPatch() {
    const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-patch' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'blazar-reviewed.patch';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <nav className="git-file-picker" aria-label="Changed files">
      <span className="muted">{files.length} changed {files.length === 1 ? 'file' : 'files'}</span>
      {files.map((file, index) => {
        const lines = file.split('\n').slice(0, 10);
        const path = lines.find(line => line.startsWith('+++ ') && line !== '+++ /dev/null')
          ?? lines.find(line => line.startsWith('--- ') && line !== '--- /dev/null');
        const display = path ? path.slice(4).replace(/^[ab]\//, '') : lines[0].replace(/^diff --git /, '');
        return <button type="button" key={index} aria-pressed={index === selected} onClick={() => setSelected(index)}>
          <span>{display}</span>
          {stats.has(display) && <small>+{stats.get(display).additions} / −{stats.get(display).deletions}</small>}
        </button>;
      })}
    </nav>
    {canExport && <button type="button" onClick={downloadPatch}>Download reviewed patch</button>}
    {canExport && <GitDelivery deliver={deliver} />}
    <Diff text={files[selected]} git />
  </>;
}

function GitDelivery({ deliver }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [repository, setRepository] = useState('');
  const [remote, setRemote] = useState('origin');
  const [pushed, setPushed] = useState('');
  const [pullRequest, setPullRequest] = useState('');
  async function publish(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const action = event.nativeEvent.submitter?.value ?? 'push';
    setBusy(true);
    setError('');
    try {
      const published = await deliver({
        repository, ...result, remote: remote.trim(),
        ...(action === 'pull-request' && { base: String(fields.get('base')).trim(), title: String(fields.get('title')).trim() }),
      }, action);
      if (action === 'push') setPushed(published.remote);
      else setPullRequest(published.url);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setResult(null);
    setPushed('');
    setPullRequest('');
    const path = String(fields.get('repository')).trim();
    try {
      setResult(await deliver({
        repository: path,
        branch: String(fields.get('branch')).trim(),
      }));
      setRepository(path);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return <details>
    <summary>Commit to a new local branch</summary>
    <form onSubmit={submit}>
      <label>Repository path on the Router Mac<input name="repository" placeholder="/Users/me/project" required disabled={busy} /></label>
      <label>New branch<input name="branch" placeholder="blazar/reviewed-changes" required disabled={busy} /></label>
      <button disabled={busy}>{busy ? 'Creating commit…' : 'Create local commit'}</button>
    </form>
    {result && <>
      <p role="status"><code>{result.branch}</code> · <code>{result.commit}</code></p>
      <form onSubmit={publish}>
        <label>Push remote<input value={remote} required disabled={busy}
          onChange={event => { setRemote(event.target.value); setPullRequest(''); }} /></label>
        <button value="push" formNoValidate disabled={busy || !remote.trim()}>Push branch</button>
        {pushed === remote.trim() && <>
          <p role="status">Pushed to {pushed}</p>
          <label>PR base branch<input name="base" defaultValue="main" required disabled={busy} /></label>
          <label>PR title<input name="title" defaultValue="Reviewed Blazar changes" maxLength={240} required disabled={busy} /></label>
          <button value="pull-request" disabled={busy}>Open GitHub pull request</button>
        </>}
      </form>
      {pullRequest && <p role="status">{pullRequest}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </details>;
}

export function ArtifactPreview({ preview, canExport, deliver, close }) {
  const report = checkoutReport(preview);
  const patch = typeof report?.patch === 'string' && report.patch || preview.gitPatch;
  return <DiffPanelShell label="Artifact preview" header={<>
      <h2>{report ? 'Git changes' : preview.name}</h2>
      <button type="button" onClick={close}>Close preview</button>
    </>}>
    {report && <>
      <dl className="git-revisions">
        <dt>Base</dt><dd>{report.baseCommit.slice(0, 12)}</dd>
        {typeof report.head === 'string' && <><dt>Head</dt><dd>{report.head.slice(0, 12)}</dd></>}
      </dl>
      {!patch && Array.isArray(report.fileStats) && report.fileStats.length > 0 && <ul aria-label="Tracked changes">
        {report.fileStats.filter(file => typeof file?.path === 'string').map(file =>
          <li className="git-file-stat" key={file.path}>
            <span>{file.previousPath && typeof file.previousPath === 'string' ? file.previousPath + ' → ' : ''}{file.path}</span>
            <span>+{file.additions} / −{file.deletions}</span>
          </li>)}
      </ul>}
      {!patch && report.changes.some(change => typeof change === 'string' && change.startsWith('?? ')) &&
        <ul aria-label="New files">{report.changes.filter(change => typeof change === 'string' && change.startsWith('?? '))
          .map(change => <li key={change}>{change.slice(3)}</li>)}</ul>}
      {report.patchOmitted === 'size_limit' && <p>The patch exceeds the artifact size limit. Inspect the retained checkout for the full diff.</p>}
    </>}
    {preview.png ? <img className="window-image" src={'data:image/png;base64,' + preview.png} alt="Captured window" /> :
      patch ? <GitDiff patch={patch} fileStats={report?.fileStats} canExport={canExport} deliver={deliver} /> :
        preview.diff ? <Diff text={preview.text} /> : <pre>{preview.text}</pre>}
  </DiffPanelShell>;
}
