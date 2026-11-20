const maxCells = 250_000;

export function artifactDiff(baseName: string, baseText: string, name: string, text: string): string {
  if (baseText === text) return 'No changes.';
  const before = baseText.split('\n');
  const after = text.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let trailing = 0;
  while (trailing < before.length - start && trailing < after.length - start &&
         before[before.length - trailing - 1] === after[after.length - trailing - 1]) trailing++;

  const oldLines = before.slice(start, before.length - trailing);
  const newLines = after.slice(start, after.length - trailing);
  const safeName = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ');
  const rows = ['--- ' + safeName(baseName), '+++ ' + safeName(name),
    '@@ line ' + String(start + 1) + ' @@'];
  for (const unchanged of before.slice(Math.max(0, start - 3), start)) rows.push(' ' + unchanged);

  const width = newLines.length + 1;
  if ((oldLines.length + 1) * width > maxCells) {
    rows.push(...oldLines.map(line => '-' + line), ...newLines.map(line => '+' + line));
  } else {
    const lengths = new Uint32Array((oldLines.length + 1) * width);
    for (let i = oldLines.length - 1; i >= 0; i--) {
      for (let j = newLines.length - 1; j >= 0; j--) {
        lengths[i * width + j] = oldLines[i] === newLines[j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        rows.push(' ' + oldLines[i++]);
        j++;
      } else if (i < oldLines.length && (j === newLines.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        rows.push('-' + oldLines[i++]);
      } else {
        rows.push('+' + newLines[j++]);
      }
    }
  }
  for (const unchanged of after.slice(after.length - trailing, after.length - trailing + 3)) rows.push(' ' + unchanged);
  return rows.join('\n');
}
