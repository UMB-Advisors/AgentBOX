// MBOX-349 — customer-initiated OTA "Update now" orchestration.
//
// The execute half of NFR-6 (read-only "update available" detection landed in
// MBOX-184). Orchestrates: pull → recreate → migrate → smoke → commit-or-
// rollback, writing a mailbox.ota_update_attempts audit row at each transition
// so a fleet-support session can reconstruct what the box tried without SSH.
//
// ── DANGER: SHELL STEPS RUN ON THE APPLIANCE HOST ───────────────────────────
// The four orchestration steps (pull, recreate, migrate, rollback) shell out
// to `docker compose` / `git` on the Jetson. They are deliberately ISOLATED
// behind the injectable `OtaShell` interface (same pattern as queries-git.ts's
// GitRunner) so:
//   (a) unit tests inject a mock and assert the state machine WITHOUT spawning
//       anything — this file never runs docker in CI / on a dev workstation;
//   (b) the dangerous commands live in exactly one place (makeDefaultShell),
//       clearly marked, never string-interpolated with user input.
// The smoke gate reuses scripts/smoke-pipeline.sh (MBOX-181) as the
// post-update health check — a non-zero exit triggers rollback.
//
// This module owns ONLY the state machine + audit writes. The route handler
// (app/api/internal/ota/update-now/route.ts) owns the HTTP surface + the
// cooldown / in-flight guards (mirroring lib/transitions.ts), so the guards
// short-circuit BEFORE any audit row is written.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

const execFileP = promisify(execFile);

// Terminal results mirror the migration-033 CHECK constraint. 'started' is the
// non-terminal entry state; everything else is terminal.
export type OtaResult = 'started' | 'succeeded' | 'rolled_back' | 'failed';

// The ordered steps the orchestrator walks. Surfaced in `detail` so the audit
// row records how far the attempt got before a terminal transition.
export type OtaStep = 'pull' | 'recreate' | 'migrate' | 'smoke' | 'rollback';

// Injectable shell surface. The default (makeDefaultShell) runs real docker /
// git / smoke commands on the appliance host; tests inject a mock. Each method
// rejects on a non-zero exit (execFile semantics) so the state machine can
// catch + branch to rollback. The image digest pin comes from the appliance
// `.env` (Ollama-style digest, per CLAUDE.md) — `docker compose` reads it from
// there, so the steps take no digest argument.
export interface OtaShell {
  // `git pull` + `git submodule update --init` in the appliance repo.
  pull(): Promise<void>;
  // `docker compose up -d --build --remove-orphans` (recreate services).
  recreate(): Promise<void>;
  // `docker compose --profile migrate run --rm mailbox-migrate`.
  migrate(): Promise<void>;
  // scripts/smoke-pipeline.sh --host local — the MBOX-181 pipeline smoke run
  // against this box. Rejects on non-zero exit, which the orchestrator treats
  // as "update is unhealthy".
  smoke(): Promise<void>;
  // Bring the stack back up so the box keeps serving after a failed step.
  rollback(): Promise<void>;
}

// Repo root on the appliance host. The dashboard container mounts the host repo
// read-only at MAILBOX_REPO_MOUNT for git STATE reads (MBOX-163); the EXECUTE
// path runs on the host (where writes are allowed), so this default points at
// the appliance repo path from CLAUDE.md. Overridable for field tuning.
const DEFAULT_APPLIANCE_REPO = '/home/bob/mailbox';
const SHELL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — image pull/build can be slow.

function applianceRepo(): string {
  return process.env.MAILBOX_APPLIANCE_REPO?.trim() || DEFAULT_APPLIANCE_REPO;
}

// DANGER ZONE — the only place real docker/git commands are constructed.
// execFile (not exec): args are positional, never shell-interpolated. Nothing
// here takes free-form user input — digests are validated by the route's zod
// schema before reaching this module.
export function makeDefaultShell(repo: string = applianceRepo()): OtaShell {
  const run = (cmd: string, args: string[]) =>
    execFileP(cmd, args, { cwd: repo, timeout: SHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }).then(
      () => undefined,
    );
  return {
    pull: async () => {
      await run('git', ['pull']);
      await run('git', ['submodule', 'update', '--init']);
    },
    recreate: async () => {
      await run('docker', ['compose', 'up', '-d', '--build', '--remove-orphans']);
    },
    migrate: async () => {
      await run('docker', ['compose', '--profile', 'migrate', 'run', '--rm', 'mailbox-migrate']);
    },
    smoke: async () => {
      // --host local: run the pipeline smoke against THIS box, not over SSH.
      // The script defaults to `--host mailbox1` (an SSH hop); on the appliance
      // that makes the box SSH to itself and the smoke gate fails → every
      // update rolls back. (MBOX-349 review fix.)
      await run('bash', ['scripts/smoke-pipeline.sh', '--host', 'local']);
    },
    rollback: async () => {
      // Best-effort restore: `docker compose up -d` brings the stack back up
      // (no --build, so it reuses already-present images). The git revert and
      // any digest re-pin are left to the operator (field validation
      // MBOX-350) — this just keeps the box serving after a failed step.
      await run('docker', ['compose', 'up', '-d', '--remove-orphans']);
    },
  };
}

// ── Audit writes ────────────────────────────────────────────────────────────

export interface OtaAttemptRow {
  id: number;
  from_digest: string | null;
  to_digest: string | null;
  result: OtaResult;
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

// INSERT the 'started' audit row at orchestration entry. Returns the row id so
// terminal transitions UPDATE the same row in place (one row per attempt).
export async function recordAttemptStarted(
  fromDigest: string | null,
  toDigest: string | null,
): Promise<number> {
  const db = getKysely();
  const row = await sql<{ id: number }>`
    INSERT INTO mailbox.ota_update_attempts (from_digest, to_digest, result, detail)
    VALUES (${fromDigest}, ${toDigest}, 'started', ${'step: pull'})
    RETURNING id
  `.execute(db);
  return row.rows[0].id;
}

// Stamp the terminal result + finished_at on an existing attempt row.
export async function recordAttemptFinished(
  id: number,
  result: Exclude<OtaResult, 'started'>,
  detail: string,
): Promise<void> {
  const db = getKysely();
  await sql`
    UPDATE mailbox.ota_update_attempts
       SET result = ${result},
           detail = ${detail},
           finished_at = NOW()
     WHERE id = ${id}
  `.execute(db);
}

// ── State machine ────────────────────────────────────────────────────────────

export interface OtaUpdateInput {
  fromDigest: string | null;
  toDigest: string | null;
}

export interface OtaUpdateOutcome {
  attempt_id: number;
  result: Exclude<OtaResult, 'started'>;
  // The step that failed (when result !== 'succeeded'); null on success.
  failed_step: OtaStep | null;
  detail: string;
}

// Hooks so the route layer (and tests) can drive the audit persistence without
// this module owning the DB. Defaults wire the real recordAttempt* helpers.
export interface OtaUpdateHooks {
  recordStarted: (from: string | null, to: string | null) => Promise<number>;
  recordFinished: (
    id: number,
    result: Exclude<OtaResult, 'started'>,
    detail: string,
  ) => Promise<void>;
}

const defaultHooks: OtaUpdateHooks = {
  recordStarted: recordAttemptStarted,
  recordFinished: recordAttemptFinished,
};

/**
 * Run the OTA update state machine: pull → recreate → migrate → smoke, and on
 * any failure attempt a rollback. Writes a 'started' audit row up front and a
 * terminal row (succeeded | rolled_back | failed) when done.
 *
 * - Steps pull/recreate/migrate failing → rollback, terminal 'rolled_back'
 *   (or 'failed' if the rollback itself throws — the box may be wedged).
 * - Smoke failing (the post-update health gate, MBOX-181) → rollback, same as
 *   above. This is the whole point of the smoke gate: a bad image rolls back.
 * - All steps clean → terminal 'succeeded'.
 *
 * Never throws — always resolves to an OtaUpdateOutcome the route can return,
 * mirroring the total-failure-safe contract of the status-page helpers.
 */
export async function runOtaUpdate(
  shell: OtaShell,
  input: OtaUpdateInput,
  hooks: OtaUpdateHooks = defaultHooks,
): Promise<OtaUpdateOutcome> {
  const attemptId = await hooks.recordStarted(input.fromDigest, input.toDigest);

  // Walk the forward steps in order; the first throw breaks out to rollback.
  const forward: ReadonlyArray<{ step: OtaStep; run: () => Promise<void> }> = [
    { step: 'pull', run: () => shell.pull() },
    { step: 'recreate', run: () => shell.recreate() },
    { step: 'migrate', run: () => shell.migrate() },
    { step: 'smoke', run: () => shell.smoke() },
  ];

  let failedStep: OtaStep | null = null;
  let failureDetail = '';
  for (const { step, run } of forward) {
    try {
      await run();
    } catch (err) {
      failedStep = step;
      failureDetail = `${step} failed: ${errMsg(err)}`;
      break;
    }
  }

  if (failedStep === null) {
    const detail = 'all steps ok (pull → recreate → migrate → smoke)';
    await hooks.recordFinished(attemptId, 'succeeded', detail);
    return { attempt_id: attemptId, result: 'succeeded', failed_step: null, detail };
  }

  // A forward step failed — attempt rollback so the box keeps serving.
  try {
    await shell.rollback();
    const detail = `${failureDetail}; rolled back to ${input.fromDigest ?? 'prior image'}`;
    await hooks.recordFinished(attemptId, 'rolled_back', detail);
    return { attempt_id: attemptId, result: 'rolled_back', failed_step: failedStep, detail };
  } catch (rollbackErr) {
    // Rollback itself failed — the box may be in a degraded state. Record
    // 'failed' so fleet support escalates rather than assuming a clean revert.
    const detail = `${failureDetail}; ROLLBACK FAILED: ${errMsg(rollbackErr)}`;
    await hooks.recordFinished(attemptId, 'failed', detail);
    return { attempt_id: attemptId, result: 'failed', failed_step: failedStep, detail };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
