import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { TaskStore } from '../store.ts';
import { IdempotencyConflict } from '../domain/idempotency.ts';
import { RequestError } from '../protocol/request.ts';

export const maxDeviceFinishBytes = 1_350_000;
export const maxDeviceClaimBytes = 400_000;

type SocketDevices = Pick<TaskStore, 'deviceForToken' | 'deviceStopTargets' | 'onWorkQueued'>;
type DeviceOperation = (token: string, path: string, body: Record<string, unknown>) => { status: number; body: unknown };

export function createDeviceSocketTransport(store: SocketDevices) {
  const workSubscribers = new Map<string, Map<WebSocket, string>>();
  const workScope = (owner: string, workspace: string) => JSON.stringify([owner, workspace]);
  const stopWorkNotifications = store.onWorkQueued((owner, workspace) => {
    for (const [peer, token] of workSubscribers.get(workScope(owner, workspace)) ?? []) {
      if (peer.readyState === WebSocket.OPEN && peer.bufferedAmount < 256_000 && store.deviceForToken(token)) {
        peer.send(JSON.stringify({ type: 'queue.changed' }));
      }
    }
  });
  const stopSubscribers = new Map<string, Set<WebSocket>>();
  function sendStop(device: string, runId: string) {
    for (const peer of stopSubscribers.get(device) ?? []) {
      if (peer.readyState === WebSocket.OPEN && peer.bufferedAmount < 256_000) {
        peer.send(JSON.stringify({ type: 'run.stop', runId }));
      }
    }
  }
  function flushStops() {
    for (const device of stopSubscribers.keys()) {
      for (const row of store.deviceStopTargets(device)) sendStop(device, String(row.id));
    }
  }

  const socketServer = new WebSocketServer({ noServer: true, maxPayload: maxDeviceFinishBytes, perMessageDeflate: false });
  function attach(server: Server, operate: DeviceOperation) {
    server.on('upgrade', (request, socket, head) => {
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const device = store.deviceForToken(token);
      if (request.url !== '/v1/devices/connect' || !device) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      socketServer.handleUpgrade(request, socket, head, connection => {
        connection.on('error', () => connection.terminate());
        if (request.headers['x-blazar-device-stop-push'] === '1') {
          const peers = stopSubscribers.get(device.id) ?? new Set<WebSocket>();
          stopSubscribers.set(device.id, peers);
          peers.add(connection);
          connection.once('close', () => {
            peers.delete(connection);
            if (!peers.size) stopSubscribers.delete(device.id);
          });
          for (const row of store.deviceStopTargets(device.id)) {
            connection.send(JSON.stringify({ type: 'run.stop', runId: row.id }));
          }
        }
        if (request.headers['x-blazar-device-queue-push'] === '1') {
          const scope = workScope(device.owner, device.workspace);
          const peers = workSubscribers.get(scope) ?? new Map<WebSocket, string>();
          peers.set(connection, token);
          workSubscribers.set(scope, peers);
          connection.once('close', () => {
            peers.delete(connection);
            if (!peers.size) workSubscribers.delete(scope);
          });
        }
        connection.on('message', (raw, binary) => {
          let id: number | undefined;
          try {
            const frame = binary ? null : JSON.parse(raw.toString());
            if (!frame || !Number.isSafeInteger(frame.id) || frame.id < 1 ||
                typeof frame.path !== 'string' || frame.path.length > 128 || !frame.body ||
                typeof frame.body !== 'object' || Array.isArray(frame.body)) {
              connection.close(1003, 'Invalid frame');
              return;
            }
            id = frame.id;
            const limit = frame.path.endsWith('/finish') ? maxDeviceFinishBytes :
              frame.path === 'claim' ? maxDeviceClaimBytes : 65_536;
            if (!Array.isArray(raw) && raw.byteLength > limit) {
              throw new RequestError(413, 'Request too large');
            }
            if (connection.bufferedAmount > 256_000) {
              connection.close(1008, 'Slow device connection');
              return;
            }
            const result = operate(token, '/v1/device/' + frame.path, frame.body);
            connection.send(JSON.stringify({ id, ...result }));
          } catch (error) {
            if (id === undefined) {
              connection.close(1003, 'Invalid frame');
              return;
            }
            const status = error instanceof RequestError ? error.status : error instanceof IdempotencyConflict ? 409 : 500;
            connection.send(JSON.stringify({ id, status, body: { error: status === 500
              ? 'Internal server error' : (error as Error).message } }));
            if (status === 401) connection.close(1008, 'Device revoked');
          }
        });
      });
    });
    server.once('close', closeDeviceSockets);
  }

  let socketsClosed = false;
  const closeDeviceSockets = () => {
    if (socketsClosed) return;
    socketsClosed = true;
    stopWorkNotifications();
    for (const connection of socketServer.clients) connection.terminate();
    socketServer.close();
  };
  return { attach, closeDeviceSockets, flushStops, sendStop };
}
