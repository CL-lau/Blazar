import { DesktopIcon } from './DesktopIcon.jsx';
import React from 'react';
import { LanguagePicker, useDesktopLanguage } from './DesktopLanguage.jsx';
import blazarIcon from '../src-tauri/icons/icon.png';

const groupNames = ['Operations', 'Resources', 'System'];

const groups = [
  [['tasks', 'Run desk'], ['work-items', 'Work items'], ['notifications', 'Notifications']],
  [['knowledge', 'Applications'], ['wiki', 'Wiki'], ['schedules', 'Schedules']],
  [['devices', 'Agents'], ['desktop-control', 'Desktop'], ['router-status', 'Router status'],
    ['phones', 'Linked phones'], ['connected-tools', 'Connected tools']],
];

export function DesktopNavigation({ current, choose, unread, create }) {
  const { t } = useDesktopLanguage();
  return <>
    <div className="sidebar-brand"><img src={blazarIcon} alt="" width="27" height="27" /><strong>Blazar</strong><LanguagePicker /></div>
    <button className="sidebar-new-task" type="button" onClick={create}><DesktopIcon name="add" /> {t('New task')}</button>
    <label className="compact-navigation"><span className="visually-hidden">{t('Workspace section', '工作区导航')}</span>
      <select value={current} onChange={event => choose(event.target.value)}>
        {groups.map((group, index) => <optgroup key={groupNames[index]} label={t(groupNames[index])}>
          {group.map(([id, title]) => <option key={id} value={id}>{t(title)}{id === 'notifications' && unread ? ' (' + unread + ')' : ''}</option>)}
        </optgroup>)}
      </select>
    </label>
    <nav aria-label={t('Blazar views', 'Blazar 导航')}>
      {groups.map((group, index) => <div className="sidebar-nav-group" key={groupNames[index]}>
        <span className="nav-group-label">{t(groupNames[index])}</span>
        {group.map(([id, title]) => <button key={id} type="button"
          aria-current={current === id ? 'page' : undefined} onClick={() => choose(id)}>
          <DesktopIcon name={id} /><span>{t(title)}</span>
          {id === 'notifications' && unread > 0 && <small aria-label={t(unread + ' unread', '未读 ' + unread)}>{unread}</small>}
        </button>)}
      </div>)}
    </nav>
  </>;
}
