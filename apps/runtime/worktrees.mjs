import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureInside } from './adapters.mjs';

const MAX_GIT_OUTPUT = 60_000;
const SAFE_REF = /^agentdock\/task-[a-f0-9]{12}$/;
const GIT_TIMEOUT_MS = 8_000;

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      // Git's native prompt must never hang a headless process or display credentials.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        SystemRoot: process.env.SystemRoot,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim();
  } catch (error) {
    const code = error.code === 'ETIMEDOUT' ? 'git_timeout' : 'git_failed';
    throw new Error(`${code}: ${String(error.message || '').slice(0, 160)}`);
  }
}
function repoRoot(candidate, allowedRoots) {
  const path = ensureInside(candidate, allowedRoots);
  const repository = realpathSync(git(path, ['rev-parse', '--show-toplevel']));
  ensureInside(repository, allowedRoots);
  if (git(repository, ['rev-parse', '--is-bare-repository']) !== 'false') {
    throw new Error('bare repositories not supported');
  }
  if (git(repository, ['rev-parse', '--verify', 'HEAD'])) {
    return repository;
  }
  throw new Error('repository has no initial commit');
}
function assertSafeFolder(root, target) {
  const base = realpathSync(root);
  if (existsSync(target)) throw new Error('new worktree target already exists');
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('target must be inside approved worktree root');
  // Parent is always the canonical existing directory, no path from the user.
  const parent = realpathSync(resolve(target, '..'));
  if (parent !== base) throw new Error('target parent changed or was a symlink');
}
export class WorktreeManager {
  constructor({store, sourceRoots, worktreeRoot}) {
    this.store = store;
    this.sourceRoots = sourceRoots.map(x => realpathSync(x));
    const folder = resolve(worktreeRoot);
    mkdirSync(folder, { recursive: true });
    if (lstatSync(folder).isSymbolicLink()) throw new Error('worktree root cannot be a symlink');
    this.worktreeRoot = realpathSync(folder);
  }
  list() {
    // Trust only registered paths that still belong to the worktree directory.
    return this.store.listWorktrees().map(item => ({
      ...item,
      exists: existsSync(item.path),
    }));
  }
  async create({repoPath}) {
    if (typeof repoPath !== 'string' || repoPath.length > 1000)
      throw new Error('invalid source repository path');
    const repository = repoRoot(repoPath, this.sourceRoots);
    const id = randomUUID();
    const branch = `agentdock/task-${id.replace(/-/g, '').slice(0,12)}`;
    if (!SAFE_REF.test(branch)) throw new Error('invalid branch generation');
    const target = join(this.worktreeRoot, id);
    assertSafeFolder(this.worktreeRoot, target);
    // A deliberate UI action only; do not use destructive cleanup, reset, or
    // worktree remove. Git creates a fresh isolated branch at current HEAD.
    git(repository, ['worktree', 'add', '-b', branch, target, 'HEAD']);
    const path = realpathSync(target);
    ensureInside(path, [this.worktreeRoot]);
    this.store.createWorktree({
      id, sourceRepo: repository, path, branch,
    });
    return this.list().find(item => item.id === id);
  }
  permittedWorkspacePaths() {
    return this.list().filter(item => item.exists).map(item => item.path);
  }
}
