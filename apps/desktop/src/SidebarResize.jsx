import React, { useEffect, useRef, useState } from 'react';
import {
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY, clampThreadSidebarWidth, resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth, resolveThreadSidebarMinimumWidth,
} from './vendor/t3/threadSidebarWidth.ts';

function savedWidth() {
  try {
    const stored = Number(localStorage.getItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch { return null; }
}

export function SidebarResize({ width, setWidth }) {
  const drag = useRef(null);
  const min = resolveThreadSidebarMinimumWidth(0);
  const [max, setMax] = useState(() => resolveThreadSidebarMaximumWidth(window.innerWidth, min));
  const visibleWidth = clampThreadSidebarWidth(width, min, max);

  useEffect(() => {
    const resize = () => setMax(resolveThreadSidebarMaximumWidth(window.innerWidth, min));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [min]);

  useEffect(() => {
    try { localStorage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, String(width)); } catch { /* Session-only width. */ }
  }, [width]);

  return <div className="sidebar-resize" role="separator" aria-label="Resize navigation"
    aria-orientation="vertical" aria-controls="blazar-navigation" aria-valuemin={min} aria-valuemax={max}
    aria-valuenow={visibleWidth} tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: visibleWidth };
    }}
    onPointerMove={event => {
      if (drag.current?.pointerId === event.pointerId) {
        setWidth(clampThreadSidebarWidth(drag.current.width + event.clientX - drag.current.x, min, max));
      }
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const next = { ArrowLeft: visibleWidth - 16, ArrowRight: visibleWidth + 16, Home: min, End: max }[event.key];
      if (next !== undefined) {
        event.preventDefault();
        setWidth(clampThreadSidebarWidth(next, min, max));
      }
    }}
  />;
}

export function useSidebarWidth() {
  return useState(() => resolveInitialThreadSidebarWidth(savedWidth()));
}
