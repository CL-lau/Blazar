// Adapted from T3 Code 0591d328, apps/web/src/components/DiffPanelShell.tsx.
// Copyright (c) 2026 T3 Tools Inc. Licensed under MIT.
import type { ReactNode } from "react";

export function DiffPanelShell(props: {
  label: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="artifact-panel" aria-label={props.label}>
      <div className="artifact-panel-bar" data-surface-subheader>
        {props.header}
      </div>
      <div className="artifact-panel-body">{props.children}</div>
    </section>
  );
}
