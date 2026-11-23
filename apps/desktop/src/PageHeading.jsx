import React from 'react';
import { useDesktopLanguage } from './DesktopLanguage.jsx';

export function PageHeading({ title, description, actions, id }) {
  const { t } = useDesktopLanguage();
  return <header className="page-heading">
    <div>
      <h1 id={id}>{t(title)}</h1>
      {description && <p>{t(description)}</p>}
    </div>
    {actions && <div className="page-heading-actions">{actions}</div>}
  </header>;
}
