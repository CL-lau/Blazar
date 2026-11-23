import React from 'react';

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
  let inHunk = false;
  return <pre className="diff-preview">{text.trimEnd().split('\n').map((line, index) => {
    if (line.startsWith('diff --git ')) inHunk = false;
    if (line.startsWith('@@')) inHunk = true;
    const header = line.startsWith('@@') || (git ? !inHunk : index < 3);
    const kind = header ? 'header' : line[0] === '+' ? 'addition' : line[0] === '-' ? 'deletion' : undefined;
    return <span key={index} data-kind={kind}>{line || ' '}</span>;
  })}</pre>;
}

export function ArtifactPreview({ preview, close }) {
  const report = checkoutReport(preview);
  return <section className="artifact-panel" aria-label="Artifact preview">
    <div className="artifact-panel-bar">
      <h2>{report ? 'Git changes' : preview.name}</h2>
      <button type="button" onClick={close}>Close preview</button>
    </div>
    {report && <>
      <dl className="git-revisions">
        <dt>Base</dt><dd>{report.baseCommit.slice(0, 12)}</dd>
        {typeof report.head === 'string' && <><dt>Head</dt><dd>{report.head.slice(0, 12)}</dd></>}
      </dl>
      {Array.isArray(report.fileStats) && report.fileStats.length > 0 && <ul aria-label="Tracked changes">
        {report.fileStats.filter(file => typeof file?.path === 'string').map(file =>
          <li className="git-file-stat" key={file.path}>
            <span>{file.previousPath && typeof file.previousPath === 'string' ? file.previousPath + ' → ' : ''}{file.path}</span>
            <span>+{file.additions} / −{file.deletions}</span>
          </li>)}
      </ul>}
      {report.changes.some(change => typeof change === 'string' && change.startsWith('?? ')) &&
        <ul aria-label="New files">{report.changes.filter(change => typeof change === 'string' && change.startsWith('?? '))
          .map(change => <li key={change}>{change.slice(3)}</li>)}</ul>}
      {report.patchOmitted === 'size_limit' && <p>The patch exceeds the artifact size limit. Inspect the retained checkout for the full diff.</p>}
    </>}
    {preview.png ? <img className="window-image" src={'data:image/png;base64,' + preview.png} alt="Captured window" /> :
      typeof report?.patch === 'string' && report.patch ? <Diff text={report.patch} git /> :
        preview.diff ? <Diff text={preview.text} /> : <pre>{preview.text}</pre>}
  </section>;
}
