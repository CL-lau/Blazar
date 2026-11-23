import React from 'react';

const glyphs = {
  tasks: 'M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 3h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M8 13l2 2 4-4 M8 18h8',
  'work-items': 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 4v16M15 4v16 M6 8v3 M12 8v5 M18 8v2',
  notifications: 'M18 9a6 6 0 0 0-12 0c0 6-2 6-2 8h16c0-2-2-2-2-8 M10 20a2 2 0 0 0 4 0',
  knowledge: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  wiki: 'M12 6a8 8 0 0 0-8-1v13a8 8 0 0 1 8 1 8 8 0 0 1 8-1V5a8 8 0 0 0-8 1v13',
  schedules: 'M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M4 10h16 M8 4v4 M16 4v4 M8 14h2 M14 14h2 M8 17h2',
  devices: 'M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M12 8V4 M10 4h4 M2 12v3 M22 12v3 M9 12h.01 M15 12h.01 M10 16h4',
  'desktop-control': 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M12 17v4 M8 21h8',
  'router-status': 'M3 13h4l3-7 4 12 3-5h4',
  phones: 'M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M11 17h2',
  'connected-tools': 'M14 7l2-2a4 4 0 0 1 6 5l-3 3a4 4 0 0 1-6 0 M10 17l-2 2a4 4 0 0 1-6-5l3-3a4 4 0 0 1 6 0 M9 15l6-6',
  add: 'M12 5v14M5 12h14',
  search: 'M16 16l4 4 M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  chevron: 'm9 6 6 6-6 6',
  close: 'm6 6 12 12M18 6 6 18',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1.2-1.5 2.5 M12 17h.01',
  account: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2',
  external: 'M13 5h6v6 M19 5l-9 9 M18 13v6H5V6h6',
  attachment: 'm8 13 6-6a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l8-8a5 5 0 0 1 7 7l-8 8',
  memory: 'M6 4h12v16l-6-4-6 4z M9 8h6 M9 11h4',
  queue: 'M4 6h16M4 12h12M4 18h8',
  execution: 'm8 4 12 8-12 8z',
  decision: 'M12 3 21 12 12 21 3 12z M12 8v4 M12 16h.01',
  outcome: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M8 12l3 3 5-6',
  archive: 'M4 4h16v4H4z M6 8v12h12V8 M10 12h4',
  repository: 'M4 4h13a2 2 0 0 1 2 2v14H7a3 3 0 0 1-3-3z M4 17a2 2 0 0 1 2-2h13 M8 7h6 M8 10h4',
  documents: 'M8 3h7l4 4v12H8z M15 3v5h4 M5 6v15h11 M11 12h5 M11 15h5',
  workspace: 'M5 5h14v9h-7l-4 4v-4H5z M8 9h8 M8 12h4',
  agent: 'M12 2c0 5-3 8-8 8 5 0 8 3 8 8 0-5 3-8 8-8-5 0-8-3-8-8z M5 16v5 M2.5 18.5h5 M20 16v4 M18 18h4',
};

export function DesktopIcon({ name, size = 17, className }) {
  return <svg className={className} data-icon={name} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">
    <path d={glyphs[name]} />
  </svg>;
}
