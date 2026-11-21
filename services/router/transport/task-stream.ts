import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { RouterMetrics } from '../metrics.ts';
import type { TaskStore } from '../store.ts';

export async function streamTaskEvents(store: TaskStore, owner: string, cursor: number, response: ServerResponse, authorized: () => boolean,
                      once: boolean, canReadTask: (taskId: string) => boolean, replayThrough: number, metrics: RouterMetrics) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  response.flushHeaders();
  metrics.recordStream('opened');
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const deadline = Date.now() + 25_000;
  try {
    while (!controller.signal.aborted && Date.now() < deadline && authorized()) {
      if (cursor < store.eventReplayFloor()) {
        metrics.recordStream('resnapshotRequired');
        return;
      }
      const events = store.events(owner, cursor);
      for (const event of events) {
        const frame = JSON.stringify({ ...event, data: canReadTask(event.taskId) ? JSON.parse(event.data) : {} });
        const writable = response.write(`id: ${event.seq}\nevent: task\ndata: ${frame}\n\n`);
        if (event.seq <= replayThrough) metrics.recordStream('replayedEvents');
        if (!writable || once) return;
        cursor = event.seq;
      }
      if (!events.length) await delay(250, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    response.end();
  }
}
