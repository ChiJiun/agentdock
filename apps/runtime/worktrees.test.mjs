import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SessionStore } from './store.mjs';
import { WorktreeManager, defaultWorktreeRoot } from './worktrees.mjs';
import { createRuntimeServer } from './server.mjs';
import { DEFAULT_MOCK } from './adapters.mjs';

// Disposable repositories live in the system temp folder (never inside the AgentDock checkout);
// the folder name has a space and CJK characters on purpose (ADR-0002 WT-4).
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdock wt 測試-')));
  const repo = join(root, '來源 repo');
  const worktreeRoot = join(root, 'isolated 工作樹');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000 });
  git('init', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'Original fixture\n');
  git('add', 'README.md');
  git('-c', 'user.name=AgentDock Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, repo, worktreeRoot, git, close: () => rmSync(root, { recursive: true, force: true }) };
}
const branches = f => f.git('branch', '--format=%(refname:short)').trim().split('\n').sort();
const registered = f => f.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;

describe('safe worktree-per-task isolation', () => {
  test('creates new isolated branch/worktree without modifying original branch or files', async () => {
    const f = fixture(), db = new SessionStore(':memory:');
    try {
      const manager = new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: f.worktreeRoot });
      assert.equal(existsSync(f.worktreeRoot), false, 'root is created only on explicit creation');
      const before = f.git('rev-parse', 'HEAD').trim();
      const item = await manager.create({ repoPath: f.repo });
      assert.match(item.branch, /^agentdock\/task-[a-f0-9]{12}$/);
      assert.equal(item.exists, true);
      assert.equal(item.available, true);
      assert.equal(dirname(item.path), realpathSync(f.worktreeRoot));
      assert.deepEqual(manager.list().map(x => x.path), [item.path]);
      // Line endings follow the user's Git config (core.autocrlf on Windows), like their own checkouts.
      assert.equal(readFileSync(join(item.path, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'Original fixture\n');
      const worktreeHead = execFileSync('git', ['-C', item.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.equal(before, worktreeHead);
      assert.equal(f.git('branch', '--show-current').trim(), 'main');
      // No upstream is configured for the task branch (--no-track).
      assert.throws(() => f.git('rev-parse', '--abbrev-ref', `${item.branch}@{upstream}`));
      writeFileSync(join(item.path, 'README.md'), 'Changed ONLY in isolated worktree\n');
      assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'Original fixture\n');
      assert.equal(f.git('status', '--porcelain').trim(), '');
      assert.equal(manager.permittedWorkspacePaths()[0], realpathSync(item.path));
      assert.equal(db.listWorktrees()[0].branch, item.branch);
    } finally { db.close(); f.close(); }
  });

  test('rejects paths outside permitted roots, including traversal and non-repositories', async () => {
    const f = fixture(), db = new SessionStore(':memory:');
    try {
      const manager = new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: f.worktreeRoot });
      await assert.rejects(manager.create({ repoPath: '..' }), e => e.status === 400 && /absolute|workspace/.test(e.message));
      await assert.rejects(manager.create({ repoPath: '/' }), e => e.status === 400 && /outside/.test(e.message));
      await assert.rejects(manager.create({ repoPath: join(f.root, 'not-a-repo') }), e => e.status === 400);
      await assert.rejects(manager.create({ repoPath: 42 }), e => e.status === 400);
      // A plain folder inside an approved root that is not a Git working tree.
      const plainRoot = join(f.root, 'plain');
      mkdirSync(plainRoot);
      const plain = new WorktreeManager({ store: db, sourceRoots: [plainRoot], worktreeRoot: f.worktreeRoot });
      await assert.rejects(plain.create({ repoPath: plainRoot }), e => e.status === 400);
      assert.equal(db.listWorktrees().length, 0);
      assert.deepEqual(branches(f), ['main']);
    } finally { db.close(); f.close(); }
  });

  test('worktree root may not overlap an approved root and defaults outside the repository', () => {
    const f = fixture(), db = new SessionStore(':memory:');
    try {
      assert.throws(() => new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: join(f.repo, '.local', 'worktrees') }), /overlap/);
      assert.throws(() => new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: f.root }), /overlap/);
      assert.equal(existsSync(join(f.repo, '.local')), false);
      assert.equal(defaultWorktreeRoot({}, f.repo), resolve(f.root, '來源 repo.worktrees'));
      assert.equal(defaultWorktreeRoot({ AGENTDOCK_WORKTREE_ROOT: f.worktreeRoot }, f.repo), resolve(f.worktreeRoot));
    } finally { db.close(); f.close(); }
  });

  test('an existing branch name is never moved or overwritten', async () => {
    const f = fixture(), db = new SessionStore(':memory:');
    try {
      const fixedId = '0123456789ab-cdef-0000-0000-000000000000';
      f.git('branch', 'agentdock/task-0123456789ab');
      writeFileSync(join(f.repo, 'second.txt'), 'second\n');
      f.git('add', 'second.txt');
      f.git('-c', 'user.name=AgentDock Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'second');
      const existing = f.git('rev-parse', 'agentdock/task-0123456789ab').trim();
      const manager = new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: f.worktreeRoot, newId: () => fixedId });
      await assert.rejects(manager.create({ repoPath: f.repo }), e => e.status === 409 && /already exists/.test(e.message));
      assert.equal(f.git('rev-parse', 'agentdock/task-0123456789ab').trim(), existing);
      assert.equal(registered(f), 1);
      assert.equal(db.listWorktrees().length, 0);
    } finally { db.close(); f.close(); }
  });

  test('concurrent explicit creations get distinct branches and folders', async () => {
    const f = fixture(), db = new SessionStore(':memory:');
    try {
      const manager = new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: f.worktreeRoot });
      const items = await Promise.all([1, 2, 3].map(() => manager.create({ repoPath: f.repo })));
      assert.equal(new Set(items.map(i => i.branch)).size, 3);
      assert.equal(new Set(items.map(i => i.path)).size, 3);
      assert.equal(registered(f), 4);
      assert.equal(f.git('branch', '--show-current').trim(), 'main');
    } finally { db.close(); f.close(); }
  });

  test('a failed checkout removes only the branch this attempt created', { skip: process.platform !== 'win32' && 'needs a file name Windows cannot create' }, async () => {
    const f = fixture(), db = new SessionStore(':memory:');
    try {
      // A tracked path that Windows cannot check out makes `git worktree add` fail.
      const blob = execFileSync('git', ['-C', f.repo, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf8' }).trim();
      f.git('-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},bad<name>.txt`);
      f.git('-c', 'core.protectNTFS=false', '-c', 'user.name=AgentDock Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'unportable');
      const manager = new WorktreeManager({ store: db, sourceRoots: [f.repo], worktreeRoot: f.worktreeRoot });
      await assert.rejects(manager.create({ repoPath: f.repo }), e => e.status === 502 && /git_failed/.test(e.message));
      assert.deepEqual(branches(f), ['main']);
      assert.equal(registered(f), 1);
      assert.equal(db.listWorktrees().length, 0);
    } finally { db.close(); f.close(); }
  });

  test('local API only creates when explicitly posted and makes isolated folder available for ACP', async () => {
    const f = fixture();
    const server = createRuntimeServer({ roots: [f.repo], dbPath: ':memory:', adapters: [DEFAULT_MOCK], worktreeRoot: f.worktreeRoot });
    const address = await server.listen(0);
    const url = `http://127.0.0.1:${address.port}`;
    const post = (body, headers = {}) => fetch(url + '/api/worktrees', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    try {
      assert.equal((await (await fetch(url + '/api/worktrees')).json()).length, 0);
      assert.equal((await post(JSON.stringify({ repoPath: f.repo }), { origin: 'https://evil.invalid' })).status, 403);
      assert.equal((await post('null')).status, 400);
      const notRepo = await post(JSON.stringify({ repoPath: join(f.root, 'missing') }));
      assert.equal(notRepo.status, 400);
      const r = await post(JSON.stringify({ repoPath: f.repo }));
      assert.equal(r.status, 201);
      const created = await r.json();
      const roots = await (await fetch(url + '/api/workspaces')).json();
      assert.ok(roots.some(x => x.path === created.path));
      // A rejected path is a 400. A 500 here is the mock agent missing its 15 s start-up
      // budget on a heavily loaded machine, so only that case is retried.
      let s;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        s = await fetch(url + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapterId: 'mock', cwd: created.path }) });
        if (s.status !== 500) break;
      }
      assert.equal(s.status, 201);
      assert.equal((await s.json()).cwd, created.path);
      assert.equal(f.git('branch', '--show-current').trim(), 'main');
    } finally { await server.close(); f.close(); }
  });

  test('registered worktrees remain available after runtime restart', async () => {
    const f = fixture(), dbPath = join(f.root, 'store.db');
    let server = createRuntimeServer({ roots: [f.repo], dbPath, adapters: [DEFAULT_MOCK], worktreeRoot: f.worktreeRoot });
    try {
      const item = await server.worktrees.create({ repoPath: f.repo });
      await server.close();
      server = createRuntimeServer({ roots: [f.repo], dbPath, adapters: [DEFAULT_MOCK], worktreeRoot: f.worktreeRoot });
      assert.ok(server.allowedRoots.includes(item.path));
      assert.equal(server.worktrees.list()[0].available, true);
    } finally { await server.close(); f.close(); }
  });

  test('a worktree folder replaced by a link, or whose repository is no longer approved, is not an approved root', async () => {
    const f = fixture(), dbPath = join(f.root, 'store.db');
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    let server = createRuntimeServer({ roots: [f.repo], dbPath, adapters: [DEFAULT_MOCK], worktreeRoot: f.worktreeRoot });
    try {
      const swapped = await server.worktrees.create({ repoPath: f.repo });
      const kept = await server.worktrees.create({ repoPath: f.repo });
      // Simulate an agent replacing a sibling worktree with a junction/symlink to elsewhere.
      renameSync(swapped.path, swapped.path + '-moved');
      symlinkSync(outside, swapped.path, process.platform === 'win32' ? 'junction' : 'dir');
      const url = `http://127.0.0.1:${(await server.listen(0)).port}`;
      const roots = (await (await fetch(url + '/api/workspaces')).json()).map(x => x.path);
      assert.ok(!roots.includes(swapped.path), 'link is dropped while running');
      assert.ok(roots.includes(kept.path));
      const s = await fetch(url + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapterId: 'mock', cwd: outside }) });
      assert.equal(s.status, 400);
      await server.close();

      server = createRuntimeServer({ roots: [f.repo], dbPath, adapters: [DEFAULT_MOCK], worktreeRoot: f.worktreeRoot });
      assert.ok(!server.allowedRoots.includes(swapped.path), 'link is dropped after restart');
      assert.ok(server.allowedRoots.includes(kept.path));
      await server.close();

      // The operator no longer approves the source repository: its worktrees are not reinstated.
      const other = join(f.root, 'other');
      mkdirSync(other);
      server = createRuntimeServer({ roots: [other], dbPath, adapters: [DEFAULT_MOCK], worktreeRoot: f.worktreeRoot });
      assert.deepEqual(server.allowedRoots, [realpathSync(other)]);
      assert.equal(server.worktrees.list().every(item => item.available === false), true);
    } finally { await server.close(); f.close(); }
  });
});
