import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from './store.mjs';
import { TaskError, TaskWorkflow } from './task-workflow.mjs';
import { createRuntimeServer } from './server.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PR_URL = 'https://github.com/ChiJiun/agentdock/pull/24';

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'agentdock-tasks-'));
  const dbPath = join(folder, 'tasks.sqlite');
  let store = new SessionStore(dbPath);
  const f = {
    folder, dbPath, store,
    tasks: new TaskWorkflow({ store, roots: [folder] }),
    /** Simulates a runtime restart: the process state is gone, only SQLite remains. */
    reopen() {
      store.close();
      store = new SessionStore(dbPath);
      f.store = store;
      f.tasks = new TaskWorkflow({ store, roots: [folder] });
    },
    close() { store.close(); rmSync(folder, { recursive: true, force: true }); },
  };
  return f;
}
function move(f, task, to, options = {}) {
  return f.tasks.advance(task.id, { to, expectedRevision: task.revision, reason: 'human review', ...options });
}
function evidence(f, task, kind, result = 'passed', commitSha = SHA_A, extra = {}) {
  const sha = kind === 'plan' ? {} : { commitSha };
  const reference = kind === 'pull_request' ? { reference: PR_URL } : {};
  return f.tasks.addEvidence(task.id, { kind, result, summary: `${kind} ${result}`, ...sha, ...reference, ...extra });
}
/** Walks a new task to `target` along the happy path, recording passing evidence for `sha`. */
function reach(f, target, sha = SHA_A) {
  let task = f.tasks.create({ workspace: f.folder, objective: 'Improve code' });
  const steps = [
    ['planning'],
    ['awaiting_plan_approval', () => evidence(f, task, 'plan')],
    ['preparing', null, { humanConfirmed: true }],
    ['implementing'],
    ['verifying'],
    ['reviewing', () => evidence(f, task, 'local_tests', 'passed', sha)],
    ['ready_for_pr', () => evidence(f, task, 'independent_review', 'passed', sha)],
    ['awaiting_pr_approval'],
    ['pr_open', () => evidence(f, task, 'pull_request', 'passed', sha), { humanConfirmed: true }],
    ['ci'],
    ['awaiting_merge', () => evidence(f, task, 'ci_checks', 'passed', sha)],
  ];
  for (const [state, before, options] of steps) {
    if (task.state === target) break;
    before?.();
    task = move(f, task, state, options);
  }
  assert.equal(task.state, target);
  return task;
}
function rejects(fn, status, pattern) {
  assert.throws(fn, error => {
    assert.ok(error instanceof TaskError, `expected TaskError, got ${error}`);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

test('task lifecycle persists and has append-only transitions, revisions and issue association', () => {
  const f = fixture();
  try {
    let task = f.tasks.create({ workspace: f.folder, objective: 'Fix a CI workflow', issueNumber: 42, issueUrl: 'https://github.com/ChiJiun/agentdock/issues/42' });
    assert.equal(task.state, 'queued');
    assert.equal(task.issue_number, 42);
    task = move(f, task, 'planning');
    task = move(f, task, 'awaiting_plan_approval');
    rejects(() => move(f, task, 'preparing'), 403, /human confirmation required/);
    rejects(() => move(f, task, 'preparing', { humanConfirmed: true }), 409, /passing plan evidence required/);
    evidence(f, task, 'plan');
    task = move(f, task, 'preparing', { humanConfirmed: true });
    assert.equal(task.revision, 3);
    const history = f.tasks.history(task.id);
    assert.deepEqual(history.map(e => e.state), ['queued', 'planning', 'awaiting_plan_approval', 'preparing']);
    assert.deepEqual(history.map(e => e.revision), [0, 1, 2, 3]);
    assert.equal(f.tasks.list()[0].id, task.id);
    rejects(() => f.tasks.advance(task.id, { to: 'implementing', expectedRevision: 2, reason: 'stale' }), 409, /stale task revision/);
  } finally { f.close(); }
});

test('gates require passing plan, test, review, PR and CI evidence; no implicit merge', () => {
  const f = fixture();
  try {
    let task = reach(f, 'verifying');
    rejects(() => move(f, task, 'reviewing'), 409, /passing local_tests evidence required/);
    evidence(f, task, 'local_tests', 'failed');
    rejects(() => move(f, task, 'reviewing'), 409, /passing local_tests evidence required/);
    evidence(f, task, 'local_tests', 'pending');
    rejects(() => move(f, task, 'reviewing'), 409, /passing local_tests evidence required/);
    evidence(f, task, 'local_tests');
    task = move(f, task, 'reviewing');
    rejects(() => move(f, task, 'ready_for_pr'), 409, /passing independent_review evidence required/);
    evidence(f, task, 'independent_review');
    task = move(f, task, 'ready_for_pr');
    task = move(f, task, 'awaiting_pr_approval');
    rejects(() => move(f, task, 'pr_open', { humanConfirmed: true }), 409, /passing pull_request evidence required/);
    evidence(f, task, 'pull_request');
    rejects(() => move(f, task, 'pr_open'), 403, /human confirmation required/);
    task = move(f, task, 'pr_open', { humanConfirmed: true });
    task = move(f, task, 'ci');
    rejects(() => move(f, task, 'awaiting_merge'), 409, /passing ci_checks evidence required/);
    evidence(f, task, 'ci_checks', 'pending');
    rejects(() => move(f, task, 'awaiting_merge'), 409, /passing ci_checks evidence required/);
    evidence(f, task, 'ci_checks');
    task = move(f, task, 'awaiting_merge');
    rejects(() => move(f, task, 'complete', { humanConfirmed: true }), 409, /merge must be verified/);
    assert.equal(f.tasks.get(task.id).state, 'awaiting_merge');
  } finally { f.close(); }
});

test('evidence from an earlier round never satisfies a later round', () => {
  const f = fixture();
  try {
    // CI failed: back to implementing. Everything recorded in round one is now stale.
    let task = reach(f, 'ci');
    evidence(f, task, 'ci_checks');
    task = move(f, task, 'implementing');
    task = move(f, task, 'verifying');
    rejects(() => move(f, task, 'reviewing'), 409, /passing local_tests evidence required/);
    evidence(f, task, 'local_tests', 'passed', SHA_B);
    task = move(f, task, 'reviewing');
    rejects(() => move(f, task, 'ready_for_pr'), 409, /passing independent_review evidence required/);
    evidence(f, task, 'independent_review', 'passed', SHA_B);
    task = move(f, task, 'ready_for_pr');
    task = move(f, task, 'awaiting_pr_approval');
    rejects(() => move(f, task, 'pr_open', { humanConfirmed: true }), 409, /passing pull_request evidence required/);
    evidence(f, task, 'pull_request', 'passed', SHA_B);
    task = move(f, task, 'pr_open', { humanConfirmed: true });
    task = move(f, task, 'ci');
    rejects(() => move(f, task, 'awaiting_merge'), 409, /passing ci_checks evidence required/);
    evidence(f, task, 'ci_checks', 'passed', SHA_B);
    task = move(f, task, 'awaiting_merge');

    // A rejected plan must be replaced before it can be approved again.
    let second = reach(f, 'awaiting_plan_approval');
    second = move(f, second, 'planning');
    second = move(f, second, 'awaiting_plan_approval');
    rejects(() => move(f, second, 'preparing', { humanConfirmed: true }), 409, /passing plan evidence required/);
  } finally { f.close(); }
});

test('reviewed commit, PR head and CI commit must be the tested commit', () => {
  const f = fixture();
  try {
    let task = reach(f, 'reviewing');
    evidence(f, task, 'independent_review', 'passed', SHA_B);
    rejects(() => move(f, task, 'ready_for_pr'), 409, /independent_review evidence must name the same commit as local_tests/);
    evidence(f, task, 'independent_review');
    task = move(f, task, 'ready_for_pr');
    task = move(f, task, 'awaiting_pr_approval');
    evidence(f, task, 'pull_request', 'passed', SHA_B);
    rejects(() => move(f, task, 'pr_open', { humanConfirmed: true }), 409, /pull_request evidence must name the same commit as independent_review/);
    evidence(f, task, 'pull_request');
    task = move(f, task, 'pr_open', { humanConfirmed: true });
    task = move(f, task, 'ci');
    evidence(f, task, 'ci_checks', 'passed', SHA_B);
    rejects(() => move(f, task, 'awaiting_merge'), 409, /ci_checks evidence must name the same commit as pull_request/);

    // The PR head moved to an unreviewed commit while CI was running: green CI
    // for the new head must not reach awaiting_merge.
    evidence(f, task, 'pull_request', 'passed', SHA_B);
    rejects(() => move(f, task, 'awaiting_merge'), 409, /pull_request evidence must name the same commit as independent_review/);
    evidence(f, task, 'pull_request');
    evidence(f, task, 'ci_checks');
    // A newer failing review or test run invalidates everything downstream.
    evidence(f, task, 'independent_review', 'failed');
    rejects(() => move(f, task, 'awaiting_merge'), 409, /passing independent_review evidence required/);
    evidence(f, task, 'independent_review');
    evidence(f, task, 'local_tests', 'failed');
    rejects(() => move(f, task, 'awaiting_merge'), 409, /passing local_tests evidence required/);
    evidence(f, task, 'local_tests');
    task = move(f, task, 'awaiting_merge');
    assert.equal(task.state, 'awaiting_merge');
  } finally { f.close(); }
});

test('illegal transitions, invalid input and attempts to forge actor confirmation are rejected', () => {
  const f = fixture();
  try {
    rejects(() => f.tasks.create({ workspace: tmpdir(), objective: 'invalid' }), 400, /workspace outside approved roots/);
    rejects(() => f.tasks.create({ workspace: join(f.folder, 'missing'), objective: 'invalid' }), 400, /workspace path does not exist/);
    rejects(() => f.tasks.create({ workspace: 'relative', objective: 'invalid' }), 400, /workspace path must be absolute/);
    writeFileSync(join(f.folder, 'file.txt'), 'x');
    rejects(() => f.tasks.create({ workspace: join(f.folder, 'file.txt'), objective: 'invalid' }), 400, /not a directory/);
    rejects(() => f.tasks.create({ workspace: f.folder, objective: 'test', issueNumber: 1, issueUrl: 'https://evil.test/a' }), 400, /invalid GitHub issue URL/);
    rejects(() => f.tasks.create({ workspace: f.folder, objective: 'test', issueNumber: 2, issueUrl: 'https://github.com/a/b/issues/1' }), 400, /issue number mismatch/);
    rejects(() => f.tasks.create({ workspace: f.folder, objective: 'test', issueNumber: 1.5 }), 400, /invalid issue number/);
    for (const bad of [null, [], 'text', 7]) rejects(() => f.tasks.create(bad), 400, /invalid request body/);
    let task = f.tasks.create({ workspace: f.folder, objective: 'Check tests' });
    rejects(() => move(f, task, 'pr_open'), 409, /illegal task transition/);
    rejects(() => move(f, task, 'toString'), 400, /invalid target state/);
    rejects(() => move(f, task, 'planning', { reason: '   ' }), 400, /invalid transition reason/);
    rejects(() => f.tasks.advance(task.id, null), 400, /invalid request body/);
    rejects(() => f.tasks.advance(task.id, { to: 'planning', expectedRevision: '0', reason: 'x' }), 400, /invalid revision/);
    rejects(() => f.tasks.advance(task.id, { to: 'planning', expectedRevision: 0, reason: 'x' }, 'agent'), 400, /invalid actor/);
    rejects(() => f.tasks.get('nope') ?? f.tasks.history('nope'), 404, /task not found/);
    task = move(f, task, 'planning');
    task = move(f, task, 'awaiting_plan_approval');
    evidence(f, task, 'plan');
    rejects(() => f.tasks.advance(task.id, { to: 'preparing', expectedRevision: task.revision, reason: 'agent says yes', humanConfirmed: true }, 'system'), 403, /human confirmation required/);
    rejects(() => move(f, task, 'preparing', { humanConfirmed: 'true' }), 403, /human confirmation required/);

    rejects(() => f.tasks.addEvidence(task.id, { kind: 'approval', result: 'passed', summary: 'x' }), 400, /invalid evidence kind/);
    rejects(() => f.tasks.addEvidence(task.id, { kind: 'plan', result: 'ok', summary: 'x' }), 400, /invalid evidence result/);
    rejects(() => f.tasks.addEvidence(task.id, { kind: 'plan', result: 'passed', summary: 'x', commitSha: SHA_A }), 400, /invalid commit SHA/);
    rejects(() => f.tasks.addEvidence(task.id, { kind: 'local_tests', result: 'passed', summary: 'x' }), 400, /invalid commit SHA/);
    rejects(() => f.tasks.addEvidence(task.id, { kind: 'local_tests', result: 'passed', summary: 'x', commitSha: 'abc1234' }), 400, /invalid commit SHA/);
    rejects(() => f.tasks.addEvidence(task.id, { kind: 'ci_checks', result: 'passed', summary: 'x', commitSha: SHA_A.toUpperCase() }), 400, /invalid commit SHA/);
    for (const reference of [undefined, 'https://github.com/a/b/pull/0', 'https://evil.test/a/b/pull/1', 'https://github.com/a/b/pull/1/files'])
      rejects(() => f.tasks.addEvidence(task.id, { kind: 'pull_request', result: 'passed', summary: 'x', commitSha: SHA_A, reference }), 400, /invalid evidence reference/);
    rejects(() => f.tasks.addEvidence(task.id, []), 400, /invalid request body/);

    task = move(f, task, 'cancelled');
    rejects(() => f.tasks.addEvidence(task.id, { kind: 'plan', result: 'passed', summary: 'late' }), 409, /terminal/);
    rejects(() => move(f, task, 'planning'), 409, /illegal task transition/);
  } finally { f.close(); }
});

test('a task with an open PR or running CI can still be cancelled, and stays cancelled', () => {
  const f = fixture();
  try {
    for (const state of ['pr_open', 'ci', 'awaiting_merge']) {
      let task = reach(f, state);
      task = move(f, task, 'cancelled');
      assert.equal(task.state, 'cancelled');
      for (const to of ['planning', 'implementing', 'complete'])
        rejects(() => move(f, task, to, { humanConfirmed: true }), 409, /illegal task transition/);
    }
  } finally { f.close(); }
});

test('retried requests are idempotent: no duplicate task, evidence or transition', () => {
  const f = fixture();
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    const request = { id, workspace: f.folder, objective: 'Retry me' };
    const task = f.tasks.create(request);
    assert.equal(task.id, id);
    assert.deepEqual(f.tasks.create(request), task);
    assert.equal(f.tasks.list().length, 1);
    assert.equal(f.tasks.history(id).length, 1);
    rejects(() => f.tasks.create({ ...request, objective: 'Something else' }), 409, /task id already used/);
    rejects(() => f.tasks.create({ ...request, id: 'not-a-uuid' }), 400, /invalid task id/);

    const evidenceId = '22222222-2222-4222-8222-222222222222';
    const record = { id: evidenceId, kind: 'plan', result: 'passed', summary: 'plan v1' };
    const first = f.tasks.addEvidence(id, record);
    assert.deepEqual(f.tasks.addEvidence(id, record), first);
    assert.equal(f.tasks.evidence(id).length, 1);
    rejects(() => f.tasks.addEvidence(id, { ...record, result: 'failed' }), 409, /evidence id already used/);
    const other = f.tasks.create({ workspace: f.folder, objective: 'Other task' });
    rejects(() => f.tasks.addEvidence(other.id, record), 409, /evidence id already used/);

    // A transition that was applied is not applied twice when the request is replayed.
    const advance = { to: 'planning', expectedRevision: 0, reason: 'start' };
    assert.equal(f.tasks.advance(id, advance).revision, 1);
    rejects(() => f.tasks.advance(id, advance), 409, /stale task revision/);
    assert.equal(f.tasks.history(id).length, 2);
  } finally { f.close(); }
});

test('state, history and evidence survive a restart and the gates still hold afterwards', () => {
  const f = fixture();
  try {
    let task = reach(f, 'verifying');
    evidence(f, task, 'local_tests', 'failed');
    f.reopen();
    task = f.tasks.get(task.id);
    assert.equal(task.state, 'verifying');
    assert.equal(task.revision, 5);
    rejects(() => move(f, task, 'reviewing'), 409, /passing local_tests evidence required/);
    evidence(f, task, 'local_tests');
    task = move(f, task, 'reviewing');
    f.reopen();
    // The projection can be rebuilt from the transition log alone.
    const history = f.tasks.history(task.id);
    const last = history.at(-1);
    assert.equal(last.state, f.tasks.get(task.id).state);
    assert.equal(last.revision, f.tasks.get(task.id).revision);
    history.slice(1).forEach((entry, index) => assert.equal(entry.previous_state, history[index].state));
    assert.deepEqual(history.map(e => e.revision), history.map((_, index) => index));
    assert.deepEqual(f.tasks.evidence(task.id).map(e => e.result), ['passed', 'failed', 'passed']);
  } finally { f.close(); }
});

test('transition and evidence ledgers are append-only at the database level; failed writes roll back', () => {
  const f = fixture();
  try {
    const task = reach(f, 'verifying');
    evidence(f, task, 'local_tests', 'failed');
    const db = f.store.db;
    assert.throws(() => db.exec("UPDATE task_evidence SET result='passed'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM task_evidence'), /append-only/);
    assert.throws(() => db.exec("UPDATE task_transitions SET state='awaiting_merge'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM task_transitions'), /append-only/);
    rejects(() => move(f, task, 'reviewing'), 409, /passing local_tests evidence required/);

    // If the history row cannot be written, the state change is rolled back with it.
    db.exec(`CREATE TRIGGER break_history BEFORE INSERT ON task_transitions BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    assert.throws(() => move(f, task, 'implementing'), /disk full/);
    assert.throws(() => f.tasks.create({ workspace: f.folder, objective: 'never stored' }), /disk full/);
    db.exec('DROP TRIGGER break_history');
    assert.deepEqual(f.tasks.get(task.id), task);
    assert.equal(f.tasks.list().length, 1);
    assert.equal(db.isTransaction, false);
    assert.equal(move(f, task, 'implementing').revision, task.revision + 1);
  } finally { f.close(); }
});

test('a database written by the first preview schema is upgraded and its old evidence is not trusted', () => {
  const folder = mkdtempSync(join(tmpdir(), 'agentdock-task-legacy-'));
  const dbPath = join(folder, 'legacy.sqlite');
  const id = '33333333-3333-4333-8333-333333333333';
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE coding_tasks (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, objective TEXT NOT NULL, issue_number INTEGER,
      issue_url TEXT, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL,
      summary TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES coding_tasks(id));
    CREATE TABLE task_transitions (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, previous_state TEXT,
      state TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES coding_tasks(id));
    INSERT INTO coding_tasks VALUES('${id}','${folder.replaceAll("'", "''")}','legacy',NULL,NULL,'verifying',1,'2026-11-17T00:00:00.000Z','2026-11-17T00:00:00.000Z');
    INSERT INTO task_transitions(task_id,previous_state,state,actor,reason,created_at) VALUES('${id}','implementing','verifying','human','legacy','2026-11-17T00:00:00.000Z');
    INSERT INTO task_evidence VALUES('44444444-4444-4444-8444-444444444444','${id}','local_tests','passed','legacy pass',NULL,'2026-11-17T00:00:01.000Z');
  `);
  legacy.close();
  const store = new SessionStore(dbPath);
  try {
    const tasks = new TaskWorkflow({ store, roots: [folder] });
    const task = tasks.get(id);
    assert.equal(tasks.evidence(id)[0].commit_sha, null);
    rejects(() => tasks.advance(id, { to: 'reviewing', expectedRevision: task.revision, reason: 'x' }), 409, /passing local_tests evidence required/);
    tasks.addEvidence(id, { kind: 'local_tests', result: 'passed', summary: 'rerun', commitSha: SHA_A });
    assert.equal(tasks.advance(id, { to: 'reviewing', expectedRevision: task.revision, reason: 'x' }).state, 'reviewing');
    // Constructing twice (two runtimes, or a restart) must not fail on the existing schema.
    assert.equal(new TaskWorkflow({ store, roots: [folder] }).get(id).state, 'reviewing');
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('local HTTP API reports gate, conflict and validation failures with precise statuses', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'agentdock-task-api-'));
  const runtime = createRuntimeServer({ roots: [folder], dbPath: join(folder, 'db.sqlite'), worktreeRoot: join(folder, 'worktrees') });
  const address = await runtime.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (url, payload) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, json: await response.json() };
  };
  const get = async url => {
    const response = await fetch(base + url);
    return { status: response.status, json: await response.json() };
  };
  try {
    const created = await post('/api/tasks', { workspace: folder, objective: 'Fixture task', issueNumber: 3, issueUrl: 'https://github.com/ChiJiun/agentdock/issues/3' });
    assert.equal(created.status, 201);
    const task = created.json;
    assert.equal(task.state, 'queued');
    const path = `/api/tasks/${task.id}`;
    const advanced = await post(`${path}/advance`, { to: 'planning', expectedRevision: 0, reason: 'start plan' });
    assert.equal(advanced.status, 200);
    assert.equal(advanced.json.revision, 1);
    const stale = await post(`${path}/advance`, { to: 'planning', expectedRevision: 0, reason: 'replay' });
    assert.deepEqual(stale, { status: 409, json: { error: 'stale task revision' } });
    const illegal = await post(`${path}/advance`, { to: 'pr_open', expectedRevision: 1, reason: 'skip', humanConfirmed: true });
    assert.deepEqual(illegal, { status: 409, json: { error: 'illegal task transition' } });
    assert.equal((await post(`${path}/advance`, { to: 'awaiting_plan_approval', expectedRevision: 1, reason: 'plan drafted' })).status, 200);
    // The body cannot choose the actor, and an unconfirmed human gate is refused.
    const forged = await post(`${path}/advance`, { to: 'preparing', expectedRevision: 2, reason: 'go', actor: 'human' });
    assert.deepEqual(forged, { status: 403, json: { error: 'human confirmation required' } });
    const gated = await post(`${path}/advance`, { to: 'preparing', expectedRevision: 2, reason: 'go', humanConfirmed: true });
    assert.equal(gated.status, 409);
    assert.match(gated.json.error, /passing plan evidence required/);
    const added = await post(`${path}/evidence`, { kind: 'plan', result: 'passed', summary: 'plan ready' });
    assert.equal(added.status, 201);
    assert.equal(added.json.task_id, task.id);
    assert.equal((await post(`${path}/advance`, { to: 'preparing', expectedRevision: 2, reason: 'go', humanConfirmed: true })).json.state, 'preparing');

    for (const invalid of [null, [], 'text']) {
      assert.equal((await post('/api/tasks', invalid)).status, 400);
      assert.equal((await post(`${path}/advance`, invalid)).status, 400);
      assert.equal((await post(`${path}/evidence`, invalid)).status, 400);
    }
    assert.equal((await post('/api/tasks', { workspace: tmpdir(), objective: 'outside' })).status, 400);
    assert.equal((await post(`${path}/evidence`, { kind: 'local_tests', result: 'passed', summary: 'no sha' })).status, 400);
    assert.equal((await get('/api/tasks/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await post('/api/tasks/00000000-0000-4000-8000-000000000000/advance', { to: 'planning', expectedRevision: 0, reason: 'x' })).status, 404);

    const history = await get(`${path}/history`);
    assert.deepEqual(history.json.map(e => e.state), ['queued', 'planning', 'awaiting_plan_approval', 'preparing']);
    const page = await get(`${path}/history?after=${history.json[1].seq}`);
    assert.deepEqual(page.json.map(e => e.state), ['awaiting_plan_approval', 'preparing']);
    assert.equal((await get(`${path}/history?after=-1`)).status, 400);
    const listed = await get(`${path}/evidence`);
    assert.equal(listed.json.length, 1);
    assert.deepEqual(listed.json[0], added.json);
    assert.equal((await get(`${path}/evidence?after=${listed.json[0].seq}`)).json.length, 0);
    assert.equal((await get('/api/tasks')).json.length, 1);

    const forbidden = await fetch(base + '/api/tasks', { headers: { Origin: 'https://malicious.example' } });
    assert.equal(forbidden.status, 403);
    const crossSite = await fetch(`${base}${path}/advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://malicious.example' },
      body: JSON.stringify({ to: 'implementing', expectedRevision: 3, reason: 'csrf' }),
    });
    assert.equal(crossSite.status, 403);
    // A form-encoded "simple request" cannot reach the state machine either.
    const simple = await fetch(`${base}${path}/advance`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(simple.status, 415);
    assert.equal((await get(path)).json.revision, 3);
  } finally {
    await runtime.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
