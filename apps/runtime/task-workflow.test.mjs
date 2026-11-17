import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.mjs';
import { TaskWorkflow } from './task-workflow.mjs';
import { createRuntimeServer } from './server.mjs';

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'agentdock-tasks-'));
  const store = new SessionStore(join(folder, 'tasks.sqlite'));
  const tasks = new TaskWorkflow({ store, roots: [folder] });
  return { folder, store, tasks, close() { store.close(); rmSync(folder, { recursive: true, force: true }); } };
}
function move(tasks, task, to, options = {}) {
  return tasks.advance(task.id, { to, expectedRevision: task.revision, reason: 'human review', ...options });
}
test('task lifecycle persists and has append-only transitions, revisions and issue association', () => {
  const f = fixture();
  try {
    let task = f.tasks.create({ workspace: f.folder, objective: 'Fix a CI workflow', issueNumber: 42, issueUrl: 'https://github.com/ChiJiun/agentdock/issues/42' });
    assert.equal(task.state, 'queued');
    assert.equal(task.issue_number, 42);
    task = move(f.tasks, task, 'planning');
    task = move(f.tasks, task, 'awaiting_plan_approval');
    assert.throws(() => move(f.tasks, task, 'preparing'), /human confirmation required/);
    task = move(f.tasks, task, 'preparing', { humanConfirmed: true });
    assert.equal(task.revision, 3);
    assert.deepEqual(f.tasks.history(task.id).map(e => e.state), ['queued', 'planning', 'awaiting_plan_approval', 'preparing']);
    assert.equal(f.tasks.list()[0].id, task.id);
    assert.throws(() => f.tasks.advance(task.id, { to: 'implementing', expectedRevision: 2, reason: 'stale' }), /stale task revision/);
  } finally { f.close(); }
});
test('gates require successful test, independent review and CI evidence; no implicit merge', () => {
  const f = fixture();
  try {
    let task = f.tasks.create({ workspace: f.folder, objective: 'Improve code' });
    for (const state of ['planning', 'awaiting_plan_approval']) task = move(f.tasks, task, state);
    task = move(f.tasks, task, 'preparing', { humanConfirmed: true });
    task = move(f.tasks, task, 'implementing');
    task = move(f.tasks, task, 'verifying');
    assert.throws(() => move(f.tasks, task, 'reviewing'), /local_tests evidence required/);
    f.tasks.addEvidence(task.id, { kind: 'local_tests', result: 'failed', summary: 'one test failed' });
    assert.throws(() => move(f.tasks, task, 'reviewing'), /local_tests evidence required/);
    f.tasks.addEvidence(task.id, { kind: 'local_tests', result: 'passed', summary: 'test passed' });
    task = move(f.tasks, task, 'reviewing');
    assert.throws(() => move(f.tasks, task, 'ready_for_pr'), /independent_review evidence required/);
    f.tasks.addEvidence(task.id, { kind: 'independent_review', result: 'passed', summary: 'reviewer approved diff' });
    task = move(f.tasks, task, 'ready_for_pr');
    task = move(f.tasks, task, 'awaiting_pr_approval');
    assert.throws(() => move(f.tasks, task, 'pr_open', { humanConfirmed: true }), /pull request URL evidence required/);
    f.tasks.addEvidence(task.id, { kind: 'pull_request', result: 'passed', summary: 'verified PR', reference: 'https://github.com/ChiJiun/agentdock/pull/24' });
    task = move(f.tasks, task, 'pr_open', { humanConfirmed: true });
    task = move(f.tasks, task, 'ci');
    assert.throws(() => move(f.tasks, task, 'awaiting_merge'), /ci_checks evidence required/);
    f.tasks.addEvidence(task.id, { kind: 'ci_checks', result: 'passed', summary: 'all checks passed' });
    task = move(f.tasks, task, 'awaiting_merge');
    assert.throws(() => move(f.tasks, task, 'complete', { humanConfirmed: true }), /merge must be verified/);
    assert.equal(task.state, 'awaiting_merge');
  } finally { f.close(); }
});
test('illegal transitions, invalid URLs and attempts to forge actor confirmation are rejected', () => {
  const f = fixture();
  try {
    assert.throws(() => f.tasks.create({ workspace: tmpdir(), objective: 'invalid' }), /workspace/);
    assert.throws(() => f.tasks.create({ workspace: f.folder, objective: 'test', issueNumber: 1, issueUrl: 'https://evil.test/a' }), /invalid GitHub issue URL/);
    let task = f.tasks.create({ workspace: f.folder, objective: 'Check tests' });
    assert.throws(() => move(f.tasks, task, 'pr_open'), /illegal task transition/);
    task = move(f.tasks, task, 'planning');
    task = move(f.tasks, task, 'awaiting_plan_approval');
    assert.throws(() => f.tasks.advance(task.id, { to: 'preparing', expectedRevision: task.revision, reason: 'agent says yes', humanConfirmed: true }, 'system'), /human confirmation required/);
    task = move(f.tasks, task, 'cancelled');
    assert.throws(() => f.tasks.addEvidence(task.id, { kind: 'plan', result: 'passed', summary: 'late' }), /terminal/);
    assert.throws(() => move(f.tasks, task, 'planning'), /illegal task transition/);
  } finally { f.close(); }
});
test('local HTTP API supports task creation, evidence, history and optimistic transitions', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'agentdock-task-api-'));
  const runtime = createRuntimeServer({ roots: [folder], dbPath: join(folder, 'db.sqlite'), worktreeRoot: join(folder, 'worktrees') });
  const address = await runtime.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  try {
    const created = await post('/api/tasks', { workspace: folder, objective: 'Fixture task', issueNumber: 3, issueUrl: 'https://github.com/ChiJiun/agentdock/issues/3' });
    assert.equal(created.status, 201);
    const task = created.json;
    assert.equal(task.state, 'queued');
    const advanced = await post(`/api/tasks/${task.id}/advance`, { to: 'planning', expectedRevision: 0, reason: 'start plan' });
    assert.equal(advanced.status, 200);
    assert.equal(advanced.json.revision, 1);
    const stale = await post(`/api/tasks/${task.id}/advance`, { to: 'planning', expectedRevision: 0, reason: 'replay' });
    assert.notEqual(stale.status, 200);
    const added = await post(`/api/tasks/${task.id}/evidence`, { kind: 'plan', result: 'passed', summary: 'plan ready' });
    assert.equal(added.status, 201);
    const events = await (await fetch(`${base}/api/tasks/${task.id}/history`)).json();
    assert.equal(events.length, 2);
    const evidence = await (await fetch(`${base}/api/tasks/${task.id}/evidence`)).json();
    assert.equal(evidence.length, 1);
    const forbidden = await fetch(base + '/api/tasks', { headers: { Origin: 'https://malicious.example' } });
    assert.equal(forbidden.status, 403);
  } finally {
    await runtime.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
