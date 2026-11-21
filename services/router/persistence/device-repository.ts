import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DesktopAppControls, WorkerConfiguration } from '../../../packages/protocol/task.ts';
import { sqliteTransaction } from '../../../packages/storage/sqlite.ts';

export class DeviceRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  registerDevice(owner: string, name: string, workspace: string) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    this.db.prepare('INSERT INTO device(id,owner,workspace,name,token_hash) VALUES(?,?,?,?,?)')
      .run(id, owner, workspace, name, hash);
    return { id, name, workspace, token };
  }

  devices(owner: string, now = Date.now()) {
    return this.db.prepare(`SELECT d.id,d.name,d.workspace,d.revoked,p.last_seen AS lastSeen,
      p.capability,p.platform,w.label AS workerLabel,w.protocol AS workerProtocol,
      w.revision AS workerRevision,w.adapter_version AS workerAdapterVersion,
      CASE WHEN p.capability='agent.acp' AND policy.protocols IS NOT NULL
        THEN NOT EXISTS(SELECT 1 FROM json_each(policy.protocols) WHERE value=w.protocol)
          OR (policy.require_read_only=1 AND NOT EXISTS(SELECT 1 FROM json_each(w.capabilities) WHERE value='read-only'))
        ELSE 0 END AS workerPolicyBlocked,
      i.run_id AS interruptedRunId,(pause.device_id IS NOT NULL) AS paused,CASE WHEN d.revoked=0 AND p.last_seen>=? THEN 1 ELSE 0 END AS online
      FROM device d LEFT JOIN device_presence p ON p.device_id=d.id
      LEFT JOIN device_interruption i ON i.device_id=d.id
      LEFT JOIN device_worker w ON w.device_id=d.id
      LEFT JOIN workspace_worker_policy policy ON policy.owner=d.owner AND policy.workspace=d.workspace
      LEFT JOIN device_pause pause ON pause.device_id=d.id
      WHERE d.owner=? ORDER BY d.rowid DESC`).all(now - 45_000, owner);
  }

  workspaceWorkerPolicies(owner: string) {
    return this.db.prepare('SELECT workspace,protocols,max_concurrent,run_limit_seconds,require_read_only FROM workspace_worker_policy WHERE owner=? ORDER BY workspace')
      .all(owner).map(row => ({
        workspace: String(row.workspace), protocols: JSON.parse(String(row.protocols)) as string[],
        ...(row.run_limit_seconds !== null && { runLimitSeconds: Number(row.run_limit_seconds) }),
        ...(row.require_read_only === 1 && { requireReadOnly: true }),
        ...(row.max_concurrent !== null && { maxConcurrent: Number(row.max_concurrent) }),
      }));
  }

  setWorkspaceWorkerPolicy(owner: string, workspace: string, protocols: string[] | null, maxConcurrent?: number, runLimitSeconds?: number, requireReadOnly = false) {
    if (protocols === null) {
      this.db.prepare('DELETE FROM workspace_worker_policy WHERE owner=? AND workspace=?').run(owner, workspace);
    } else {
      this.db.prepare(`INSERT INTO workspace_worker_policy(owner,workspace,protocols,max_concurrent,run_limit_seconds,require_read_only) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner,workspace) DO UPDATE SET protocols=excluded.protocols,max_concurrent=excluded.max_concurrent,
          run_limit_seconds=excluded.run_limit_seconds,require_read_only=excluded.require_read_only`)
        .run(owner, workspace, JSON.stringify(protocols), maxConcurrent ?? null, runLimitSeconds ?? null, Number(requireReadOnly));
    }
  }

  recordDesktopApps(device: string, aliases?: string[], permissions?: Record<string, string>, controls?: DesktopAppControls[]) {
    if (controls) {
      this.db.prepare(`INSERT INTO device_desktop_controls VALUES(?,?) ON CONFLICT(device_id)
        DO UPDATE SET controls=excluded.controls WHERE controls<>excluded.controls`).run(device, JSON.stringify(controls));
    } else {
      this.db.prepare('DELETE FROM device_desktop_controls WHERE device_id=?').run(device);
    }
    if (permissions) {
      this.db.prepare(`INSERT INTO device_desktop_permissions VALUES(?,?) ON CONFLICT(device_id)
        DO UPDATE SET states=excluded.states WHERE states<>excluded.states`).run(device, JSON.stringify(permissions));
    } else {
      this.db.prepare('DELETE FROM device_desktop_permissions WHERE device_id=?').run(device);
    }
    if (!aliases) {
      this.db.prepare('DELETE FROM device_desktop_apps WHERE device_id=?').run(device);
      return;
    }
    this.db.prepare(`INSERT INTO device_desktop_apps VALUES(?,?) ON CONFLICT(device_id)
      DO UPDATE SET aliases=excluded.aliases WHERE aliases<>excluded.aliases`).run(device, JSON.stringify(aliases));
  }

  desktopTargets(owner: string, now = Date.now()) {
    return this.db.prepare(`SELECT d.workspace,d.id AS deviceId,d.name AS deviceName,j.value AS alias,
      json_extract(xp.states,'$.accessibility') AS accessibility,
      json_extract(xp.states,'$.screen_recording') AS screenRecording,
      (SELECT value FROM json_each(c.controls) WHERE json_extract(value,'$.alias')=j.value) AS controls
      FROM device d
      JOIN device_presence p ON p.device_id=d.id JOIN device_desktop_apps a ON a.device_id=d.id
      LEFT JOIN device_desktop_permissions xp ON xp.device_id=d.id
      LEFT JOIN device_desktop_controls c ON c.device_id=d.id
      JOIN json_each(a.aliases) j WHERE d.owner=? AND d.revoked=0 AND p.last_seen>=?
      AND p.capability='computer.observe'
      AND NOT EXISTS(SELECT 1 FROM device_interruption i WHERE i.device_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM device_pause x WHERE x.device_id=d.id)
      ORDER BY d.workspace,d.name,d.id,j.value LIMIT 250`).all(owner, now - 45_000)
      .map(row => ({
        workspace: String(row.workspace), deviceId: String(row.deviceId), deviceName: String(row.deviceName), alias: String(row.alias),
        accessibility: row.accessibility, screenRecording: row.screenRecording,
        controls: row.controls ? JSON.parse(String(row.controls)) as DesktopAppControls : null,
      }));
  }

  ownsDesktopTarget(owner: string, workspace: string, id: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM device d JOIN device_desktop_apps a ON a.device_id=d.id
      WHERE d.owner=? AND d.workspace=? AND d.id=? AND d.revoked=0`).get(owner, workspace, id));
  }

  recordDeviceActivity(id: string, now: number, capability?: string, platform?: string) {
    this.db.prepare(`INSERT INTO device_presence VALUES(?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen,
      capability=COALESCE(excluded.capability,device_presence.capability),
      platform=COALESCE(excluded.platform,device_presence.platform)
      WHERE excluded.last_seen>=device_presence.last_seen AND (
        excluded.last_seen-device_presence.last_seen>=10000 OR
        (excluded.capability IS NOT NULL AND excluded.capability IS NOT device_presence.capability) OR
        (excluded.platform IS NOT NULL AND excluded.platform IS NOT device_presence.platform)
      )`).run(id, now, capability ?? null, platform ?? null);
  }

  recordDeviceWorker(id: string, worker?: WorkerConfiguration) {
    if (!worker) {
      this.db.prepare('DELETE FROM device_worker WHERE device_id=?').run(id);
      return;
    }
    this.db.prepare(`INSERT INTO device_worker(device_id,label,protocol,revision,adapter_version,capabilities) VALUES(?,?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET label=excluded.label,protocol=excluded.protocol,
        revision=excluded.revision,adapter_version=excluded.adapter_version,capabilities=excluded.capabilities
      WHERE label<>excluded.label OR protocol<>excluded.protocol OR revision IS NOT excluded.revision
        OR adapter_version IS NOT excluded.adapter_version OR capabilities<>excluded.capabilities`)
      .run(id, worker.label, worker.protocol, worker.revision ?? null, worker.adapterVersion ?? null, JSON.stringify(worker.capabilities ?? []));
  }

  clearInterruption(device: string) {
    this.db.prepare('DELETE FROM device_interruption WHERE device_id=?').run(device);
  }

  deviceForToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const hash = createHash('sha256').update(token).digest('hex');
    return this.db.prepare('SELECT id,owner,workspace FROM device WHERE token_hash=? AND revoked=0')
      .get(hash) as { id: string; owner: string; workspace: string } | undefined;
  }

  setDevicePaused(owner: string, id: string, paused: boolean) {
    return sqliteTransaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM device WHERE owner=? AND id=? AND revoked=0').get(owner, id)) return false;
      if (paused) this.db.prepare('INSERT OR IGNORE INTO device_pause VALUES(?)').run(id);
      else this.db.prepare('DELETE FROM device_pause WHERE device_id=?').run(id);
      return true;
    });
  }
}
