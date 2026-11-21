import type { DatabaseSync } from 'node:sqlite';
import type { PredecessorInput, Run, RunHistoryEntry, Task, TaskAttachment, TaskMemoryInput, WorkflowAction } from '../../../packages/protocol/task.ts';
import { resolveWorkflowWindow, workflowActionGoal } from '../domain/workflow.ts';

export class RunInputRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  desktopAction(task: Pick<Task, 'id' | 'goal'>) {
    if (!/^\/(observe|click) /.test(task.goal)) return undefined;
    const row = this.db.prepare(`SELECT json_extract(data,'$.action') AS action FROM event
      WHERE taskId=? AND type='task.created' ORDER BY seq LIMIT 1`).get(task.id);
    return typeof row?.action === 'string' ? JSON.parse(row.action) as WorkflowAction : undefined;
  }

  resolveDesktopGoal(task: Task, action?: WorkflowAction) {
    if (!action || !('windowFrom' in action)) return task.goal;
    const input = this.db.prepare(`SELECT p.result FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
      JOIN workflow_step source ON source.task_id=p.id WHERE d.task_id=? AND source.step_key=? AND p.status='succeeded'`)
      .get(task.id, action.windowFrom.step);
    const target = typeof input?.result === 'string' && resolveWorkflowWindow(input.result, action.windowFrom.title);
    return target ? workflowActionGoal(action, target) : undefined;
  }

  predecessorInputs(taskId: string): PredecessorInput[] {
    const rows = this.db.prepare(`SELECT p.id AS taskId,p.version,p.result,a.id AS artifactId,a.name,a.sha256,a.size,a.content
      FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
      LEFT JOIN artifact a ON a.rowid=(
        SELECT a.rowid FROM artifact a JOIN artifact_version v ON v.artifact_id=a.id
        WHERE a.taskId=p.id AND v.task_version=p.version
          AND NOT EXISTS(SELECT 1 FROM artifact_image image WHERE image.artifact_id=a.id)
          ORDER BY a.rowid DESC LIMIT 1
      )
      WHERE d.task_id=? ORDER BY p.rowid`).all(taskId);
    let budget = 16_000;
    return rows.map(row => {
      const input: PredecessorInput = {
        taskId: String(row.taskId), version: Number(row.version), result: row.result === null ? null : String(row.result),
      };
      if (!row.artifactId || !(row.content instanceof Uint8Array)) return input;
      const text = Buffer.from(row.content).toString('utf8');
      const excerpt = text.slice(0, Math.min(2000, budget)).toWellFormed();
      budget -= excerpt.length;
      input.artifact = {
        id: String(row.artifactId), name: String(row.name), sha256: String(row.sha256),
        excerpt, truncated: excerpt.length < text.length, size: Number(row.size),
      };
      return input;
    });
  }

  private runHistory(taskId: string): RunHistoryEntry[] {
    const rows = this.db.prepare(`SELECT seq,json_extract(data,'$.runId') AS run_id,
      CASE type
        WHEN 'run.device_interrupted' THEN 'interrupted'
        WHEN 'run.device_revoked' THEN 'device_revoked'
        WHEN 'run.lease_expired' THEN 'lease_expired'
        WHEN 'run.deadline_exceeded' THEN 'deadline_exceeded'
        WHEN 'run.inputs_changed' THEN 'inputs_changed'
        WHEN 'run.finished' THEN CASE
          WHEN json_extract(data,'$.waitingReason') IN ('git_patch_inputs','worker_question') THEN json_extract(data,'$.waitingReason')
          WHEN json_extract(data,'$.status') IN ('succeeded','failed') THEN json_extract(data,'$.status')
          ELSE 'review_required'
        END
      END AS outcome
      FROM event WHERE taskId=? AND type IN ('run.finished','run.device_interrupted','run.device_revoked',
        'run.lease_expired','run.deadline_exceeded','run.inputs_changed')
      AND json_type(data,'$.runId')='text' ORDER BY seq DESC LIMIT 5`).all(taskId);
    return rows.reverse().map(row => ({
      eventSeq: Number(row.seq), runId: String(row.run_id), outcome: row.outcome as RunHistoryEntry['outcome'],
    }));
  }

  assignment(task: Task, run: Run, predecessors: PredecessorInput[], requireReadOnly: boolean, action?: WorkflowAction) {
    const instructionEvents = this.db.prepare(`SELECT data FROM event WHERE taskId=?
      AND type='task.instruction_added' ORDER BY seq`).all(run.taskId)
      .map(row => JSON.parse(String(row.data)) as { text: string; question?: string });
    const instructions = instructionEvents.map(event => event.text);
    const previousQuestion = instructionEvents.findLast(event => event.question)?.question;
    const acceptanceCriteria = this.db.prepare('SELECT criterion FROM task_criterion WHERE task_id=? ORDER BY position')
      .all(run.taskId).map(row => String(row.criterion));
    const memoryInputs = this.db.prepare(`SELECT memory_id AS id,version,'' AS body FROM task_memory_input WHERE task_id=? ORDER BY position`)
      .all(run.taskId) as unknown as TaskMemoryInput[];
    const attachments = this.db.prepare('SELECT name,text FROM task_attachment WHERE task_id=? ORDER BY position')
      .all(run.taskId) as unknown as TaskAttachment[];
    const expected = action && 'expectedText' in action ? action.expectedText : undefined;
    const observationWaitSeconds = action?.kind === 'desktop.observe' && action.mode === 'window' ? action.waitSeconds : undefined;
    const required = this.db.prepare('SELECT capability FROM task_worker_capability WHERE task_id=?').get(run.taskId)?.capability;
    const runHistory = run.version > 1 ? this.runHistory(run.taskId) : [];
    return { run, task, instructions, predecessors, acceptanceCriteria,
      ...(runHistory.length && { runHistory }),
      ...(previousQuestion && { previousQuestion }),
      ...(required === 'full-input-artifacts' && { fullInputRequired: true }),
      ...(required === 'git-patch-inputs' && { gitPatchInputsRequired: true }),
      ...((required === 'read-only' || requireReadOnly) && { readOnlyRequired: true }),
      ...(typeof expected === 'string' && (task.goal.startsWith('/click ')
        ? { clickExpectedText: expected } : { observationExpectedText: expected })),
      ...(observationWaitSeconds !== undefined && { observationWaitSeconds }),
      ...(attachments.length && { attachments }),
      ...(memoryInputs.length && { memoryInputs }),
    };
  }

  runInputArtifact(runId: string, device: string, artifactId: string, now: number) {
    return this.db.prepare(`SELECT a.id,a.name,a.sha256,a.content FROM run r JOIN task t ON t.id=r.taskId
      JOIN run_dependency d ON d.run_id=r.id JOIN artifact a ON a.taskId=d.predecessor
      JOIN artifact_version v ON v.artifact_id=a.id AND v.task_version=d.version
      WHERE a.id=? AND NOT EXISTS(SELECT 1 FROM artifact_image image WHERE image.artifact_id=a.id)
      AND r.id=? AND r.device=? AND r.expires>? AND t.status='running' AND r.version=t.version
      AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)`)
      .get(artifactId, runId, device, now) as
      { id: string; name: string; sha256: string; content: Uint8Array } | undefined;
  }
}
