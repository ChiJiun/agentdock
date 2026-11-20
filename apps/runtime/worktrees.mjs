import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { childEnvironment, ensureInside } from './adapters.mjs';

// `git worktree list --porcelain -z` needs Git 2.36 or newer.
export const MIN_GIT_VERSION = '2.36';
const MAX_GIT_OUTPUT = 1_000_000;
const SAFE_REF = /^agentdock\/task-[a-f0-9]{12}$/;
const SAFE_SHA = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
// Generous for slow or heavily loaded Windows machines (antivirus scanning .git).
const GIT_TIMEOUT_MS = 30_000;
// Checking out a large repository can take far longer than a metadata query.
const GIT_CHECKOUT_TIMEOUT_MS = 120_000;

/** Errors whose status and message are safe to return to the local UI. */
export class WorktreeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Default location is outside the repository (ADR-0002 WT-1): `<cwd>.worktrees`,
 * unless the operator sets AGENTDOCK_WORKTREE_ROOT.
 */
export function defaultWorktreeRoot(env = process.env, cwd = process.cwd()) {
  if (env.AGENTDOCK_WORKTREE_ROOT) return resolve(env.AGENTDOCK_WORKTREE_ROOT);
  return resolve(dirname(cwd), `${basename(cwd)}.worktrees`);
}

/** Case-insensitive on Windows because path.win32.relative is (ADR-0002 WT-9). */
function samePath(a, b) { return relative(a, b) === ''; }
function isWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function gitEnvironment() {
  // Only an allow-listed environment: inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
  // must never redirect Git away from the repository the backend validated.
  // System config stays enabled: Git for Windows keeps core.autocrlf / core.longpaths there,
  // and the worktree must check out the same way the user's own Git would.
  return { ...childEnvironment(['ProgramData', 'XDG_CONFIG_HOME']), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}
function gitOptions(timeout) {
  return { encoding: 'utf8', timeout, maxBuffer: MAX_GIT_OUTPUT, windowsHide: true, env: gitEnvironment() };
}
function gitFailure(error) {
  const timedOut = error.code === 'ETIMEDOUT' || error.killed === true;
  const detail = String(error.stderr || error.message || '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const failure = new Error(`${timedOut ? 'git_timeout' : 'git_failed'}: ${detail}`);
  failure.timedOut = timedOut;
  return failure;
}
function gitSync(cwd, args, timeout = GIT_TIMEOUT_MS) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], gitOptions(timeout));
  } catch (error) {
    throw gitFailure(error);
  }
}
function gitAsync(cwd, args, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolveGit, rejectGit) => {
    execFile('git', ['-C', cwd, ...args], gitOptions(timeout), (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        rejectGit(gitFailure(error));
      } else resolveGit(stdout);
    });
  });
}

/** Parses `git worktree list --porcelain -z` into `{ path, branch }` records. */
function registeredWorktrees(repository) {
  const records = [];
  let current = null;
  for (const field of gitSync(repository, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (field === '') { if (current) records.push(current); current = null; continue; }
    if (field.startsWith('worktree ')) current = { path: resolve(field.slice('worktree '.length)), branch: null };
    else if (current && field.startsWith('branch ')) current.branch = field.slice('branch '.length);
  }
  if (current) records.push(current);
  return records;
}

function repositoryRoot(candidate, sourceRoots) {
  let path;
  try {
    path = ensureInside(candidate, sourceRoots);
  } catch (error) {
    throw new WorktreeError(400, String(error.message).slice(0, 160));
  }
  let repository;
  try {
    repository = realpathSync(gitSync(path, ['rev-parse', '--show-toplevel']).trim());
  } catch (error) {
    // Bare repositories also land here: they have no working tree top level.
    throw new WorktreeError(400, `not a Git working tree: ${String(error.message).slice(0, 160)}`);
  }
  try {
    ensureInside(repository, sourceRoots);
  } catch {
    throw new WorktreeError(400, 'repository top level is outside approved workspace roots');
  }
  let head;
  try {
    head = gitSync(repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
  } catch {
    throw new WorktreeError(400, 'repository has no initial commit');
  }
  if (!SAFE_SHA.test(head)) throw new WorktreeError(400, 'cannot resolve repository HEAD');
  return { repository, head };
}

function assertSafeFolder(root, target) {
  const base = realpathSync(root);
  if (existsSync(target)) throw new WorktreeError(409, 'new worktree target already exists');
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new WorktreeError(400, 'target must be inside approved worktree root');
  // Parent is always the canonical existing directory, no path from the user.
  const parent = realpathSync(resolve(target, '..'));
  if (!samePath(parent, base)) throw new WorktreeError(409, 'target parent changed or was a symlink');
}

export class WorktreeManager {
  /**
   * @param {{ store: any, sourceRoots: string[], worktreeRoot: string, newId?: () => string }} options
   * The worktree root is created lazily on the first explicit creation, never at start-up.
   */
  constructor({ store, sourceRoots, worktreeRoot, newId = randomUUID }) {
    this.store = store;
    this.newId = newId;
    this.sourceRoots = sourceRoots.map(x => realpathSync(x));
    this.worktreeRoot = resolve(worktreeRoot);
    this.assertNoOverlap(this.worktreeRoot);
    if (existsSync(this.worktreeRoot)) this.worktreeRoot = this.canonicalRoot();
    this.queue = Promise.resolve();
    // Registered worktrees are trusted only after Git confirms them again (restart, moved roots).
    this.trusted = this.verifyRegistered();
  }

  assertNoOverlap(root) {
    // A worktree inside an approved root would let a session at that root see every task's
    // worktree, and an approved root inside the worktree root would let one task reach another.
    if (this.sourceRoots.some(source => isWithin(source, root) || isWithin(root, source)))
      throw new Error('worktree root must not overlap an approved workspace root; set AGENTDOCK_WORKTREE_ROOT outside them');
  }

  canonicalRoot() {
    if (lstatSync(this.worktreeRoot).isSymbolicLink()) throw new Error('worktree root cannot be a symlink or junction');
    const real = realpathSync(this.worktreeRoot);
    this.assertNoOverlap(real);
    return real;
  }

  ensureRoot() {
    mkdirSync(this.worktreeRoot, { recursive: true });
    try {
      this.worktreeRoot = this.canonicalRoot();
    } catch (error) {
      throw new WorktreeError(409, String(error.message));
    }
  }

  /** Cheap filesystem check, repeated before each use: no link in the path, direct child of the root. */
  stillInPlace(item) {
    try {
      const real = realpathSync(item.path);
      return samePath(real, item.path) && samePath(dirname(real), this.worktreeRoot);
    } catch {
      return false;
    }
  }

  /** Reconcile durable intent with Git metadata after a crash. No Git writes or file deletion. */
  verifyRegistered() {
    const trusted = new Set();
    const listings = new Map();
    for (const item of this.store.listWorktrees()) {
      let approved = false;
      try {
        ensureInside(item.source_repo, this.sourceRoots);
        approved = true;
      } catch { /* a revoked source root is never re-authorized */ }
      if (approved && !listings.has(item.source_repo)) {
        try { listings.set(item.source_repo, registeredWorktrees(item.source_repo)); }
        catch { listings.set(item.source_repo, []); }
      }
      const registered = listings.get(item.source_repo) ?? [];
      // Exact branch and path are required: a repository may register a
      // DIFFERENT branch at the same path after an interrupted checkout.
      const match = registered.some(w => samePath(w.path, item.path)
        && w.branch === `refs/heads/${item.branch}`);
      const safe = approved && this.stillInPlace(item);
      if (match && safe) {
        // A completed checkout with a failed database commit is recoverable.
        if (item.state !== 'ready') this.store.setWorktreeState(item.id, 'ready');
        trusted.add(item.id);
      } else {
        // A registered worktree or unexpected folder with the wrong branch/path
        // is an orphan requiring inspection. An incomplete Git operation is partial.
        const state = existsSync(item.path) ? 'orphan' : 'partial';
        if (item.state !== state) this.store.setWorktreeState(item.id, state);
      }
    }
    return trusted;
  }

  list() {
    // Authorization must reflect current Git registration, not a startup-only
    // snapshot: the same folder may later be registered to another branch.
    this.trusted = this.verifyRegistered();
    return this.store.listWorktrees().map(item => ({
      ...item,
      exists: existsSync(item.path),
      available: this.trusted.has(item.id) && this.stillInPlace(item),
    }));
  }

  /** Serialized so two clicks or retries cannot race on Git metadata. */
  create({ repoPath, idempotencyKey = null }) {
    const run = this.queue.then(() => this.createNow(repoPath, idempotencyKey));
    this.queue = run.catch(() => {});
    return run;
  }

  async createNow(repoPath, idempotencyKey) {
    if (typeof repoPath !== 'string' || !repoPath || repoPath.length > 1000)
      throw new WorktreeError(400, 'invalid source repository path');
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string'
        || !/^[a-zA-Z0-9_-]{16,80}$/.test(idempotencyKey))) {
      throw new WorktreeError(400, 'invalid worktree idempotency key');
    }
    const { repository, head } = repositoryRoot(repoPath, this.sourceRoots);
    if (idempotencyKey) {
      const prior = this.store.worktreeByKey(idempotencyKey);
      if (prior) {
        if (!samePath(prior.source_repo, repository)) throw new WorktreeError(409, 'key belongs to a different repository');
        // Revalidate a saved creating/partial intent without repeating any Git operation.
        this.trusted = this.verifyRegistered();
        return this.list().find(item => item.id === prior.id);
      }
    }
    this.ensureRoot();
    const id = this.newId();
    const slug = id.replace(/-/g, '').slice(0, 12).toLowerCase();
    const branch = `agentdock/task-${slug}`;
    if (!SAFE_REF.test(branch)) throw new WorktreeError(500, 'invalid branch generation');
    // Short folder name keeps Windows paths under MAX_PATH for deep repositories.
    const target = join(this.worktreeRoot, `task-${slug}`);
    assertSafeFolder(this.worktreeRoot, target);
    // A crash at any later point leaves a discoverable intent. This insert must
    // commit BEFORE the first Git mutation; retries never start a new attempt.
    this.store.createWorktree({
      id, sourceRepo: repository, path: target, branch, head,
      idempotencyKey, state: 'creating',
    });

    // ADR-0002 WT-2: create the branch first at the resolved commit. `git branch` without
    // --force refuses an existing name, so a user's branch is never moved or overwritten.
    try {
      await gitAsync(repository, ['branch', '--no-track', branch, head]);
    } catch (error) {
      this.store.setWorktreeState(id, 'failed');
      if (/already exists/i.test(error.message)) throw new WorktreeError(409, `branch ${branch} already exists; nothing was changed`);
      throw new WorktreeError(502, error.message);
    }
    try {
      await gitAsync(repository, ['worktree', 'add', target, branch], GIT_CHECKOUT_TIMEOUT_MS);
    } catch (error) {
      const outcome = this.undoFailedCreate(repository, branch, head, target);
      this.store.setWorktreeState(id, existsSync(target) ? 'orphan' : 'partial');
      throw new WorktreeError(502, `${error.message} — ${outcome}`);
    }
    try {
      const path = realpathSync(target);
      if (!samePath(path, target) || !this.stillInPlace({ path }))
        throw new Error('created worktree moved or became a symlink');
      const registered = registeredWorktrees(repository);
      if (!registered.some(w => samePath(w.path, path) && w.branch === `refs/heads/${branch}`))
        throw new Error('Git did not register the expected worktree and branch');
      // Only the final state transition is needed; no second INSERT can lose
      // this folder when SQLite rejects the commit.
      this.store.setWorktreeState(id, 'ready');
    } catch (error) {
      throw new WorktreeError(502, `Worktree created at ${target} but not finalized; use the same idempotency key to reconcile, and inspect before cleanup: ${String(error.message).slice(0, 120)}`);
    }
    this.trusted.add(id);
    return this.list().find(item => item.id === id);
  }

  /**
   * Undo only what this attempt created (ADR-0002 WT-2). Never removes a worktree or a
   * directory: a partial checkout is left in place and reported for manual inspection.
   */
  undoFailedCreate(repository, branch, head, target) {
    let records;
    try {
      records = registeredWorktrees(repository);
    } catch {
      return `could not re-read worktree state; branch ${branch} and ${target} left for manual inspection`;
    }
    if (records.some(w => samePath(w.path, target) || w.branch === `refs/heads/${branch}`)) {
      return `partial worktree left at ${target} on branch ${branch} for manual inspection`;
    }
    try {
      // Compare-and-delete: only if the branch still points at the commit this attempt used.
      gitSync(repository, ['update-ref', '-d', `refs/heads/${branch}`, head]);
    } catch {
      return `branch ${branch} kept because it changed or could not be removed`;
    }
    return existsSync(target)
      ? `branch ${branch} removed; unregistered folder ${target} left for manual inspection`
      : `branch ${branch} removed; nothing else was created`;
  }

  permittedWorkspacePaths() {
    return this.list().filter(item => item.available).map(item => item.path);
  }
}
