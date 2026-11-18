import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AcpHost } from './acp-host.mjs';
import { DEFAULT_MOCK, ensureInside, loadAdapters } from './adapters.mjs';
import { SessionStore } from './store.mjs';
import { deriveAttention } from './attention.mjs';
import { WorktreeError, WorktreeManager, defaultWorktreeRoot } from './worktrees.mjs';
import { GitHubEvidenceError, GitHubReader } from './github-reader.mjs';
import { TaskError, TaskWorkflow } from './task-workflow.mjs';

const MAX_BODY = 20_000;
const PORT = Number(process.env.AGENTDOCK_RUNTIME_PORT || 4319);

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(JSON.stringify(value));
}
async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new ClientError(415, 'JSON content-type required');
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString('utf8');
    if (body.length > MAX_BODY) throw new ClientError(413, 'payload too large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new ClientError(400, 'invalid JSON'); }
}
class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function allowedOrigin(origin) {
  if (!origin) return true; // Node/Curl testing. Browser mutation requests carry Origin.
  try {
    const u = new URL(origin);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      && u.protocol === 'http:'
      && (u.port === '5173' || u.port === String(process.env.AGENTDOCK_VITE_PORT || 5173));
  } catch { return false; }
}

/**
 * Local development API with a real ACP client. It is NOT a public server.
 * In production, the Tauri host must expose typed IPC instead of an HTTP port.
 */
export function createRuntimeServer({
  roots = [process.cwd()],
  dbPath = resolve('.local', 'agentdock.db'),
  adapters = loadAdapters(process.env.AGENTDOCK_ADAPTER_CONFIG),
  worktreeRoot = defaultWorktreeRoot(),
} = {}) {
  const sourceRoots = roots.map(root => realpathSync(root));
  const allowedRoots = [...sourceRoots];
  const store = new SessionStore(dbPath);
  const worktrees = new WorktreeManager({store,sourceRoots,worktreeRoot});
  // Shared by reference with AcpHost. Rebuilt in place before each use so a worktree folder
  // later replaced by a symlink/junction (or moved) stops being an approved root.
  const refreshRoots = () => allowedRoots.splice(sourceRoots.length, Infinity, ...worktrees.permittedWorkspacePaths());
  refreshRoots();
  const host = new AcpHost({ store, roots: allowedRoots, adapters });
  const github = new GitHubReader({ roots: allowedRoots });
  const tasks = new TaskWorkflow({ store, roots: allowedRoots });
  const server = createServer(async (request, response) => {
    try {
      const method = request.method;
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      if (request.headers.origin && !allowedOrigin(request.headers.origin)) {
        throw new ClientError(403, 'cross-origin request rejected');
      }
      if (method === 'GET' && pathname === '/api/health') return json(response, 200, { ok: true, mode: 'local-development', protocol: 'ACP v1', storage: 'sqlite' });
      if (method === 'GET' && pathname === '/api/adapters') return json(response, 200, adapters.map(({ id, label }) => ({ id, label })));
      if (pathname === '/api/workspaces' || pathname === '/api/sessions' || pathname.startsWith('/api/git/')) refreshRoots();
      if (method === 'GET' && pathname === '/api/workspaces') return json(response, 200, allowedRoots.map(path => ({ path })));
      if (method === 'GET' && pathname === '/api/worktrees') return json(response, 200, worktrees.list());
      if (method === 'POST' && pathname === '/api/worktrees') {
        const payload = await readJson(request);
        // This endpoint creates only a new branch and worktree after explicit user action.
        // Never deletes/cleans, force-pushes or modifies the base branch.
        const item = await worktrees.create({ repoPath: payload?.repoPath });
        refreshRoots();
        return json(response, 201, item);
      }
      if (method === 'GET' && pathname === '/api/github/issues') {
        return json(response, 200, await github.issues(url.searchParams.get('cwd') || ''));
      }
      if (method === 'GET' && pathname === '/api/github/pulls') {
        return json(response, 200, await github.pulls(url.searchParams.get('cwd') || ''));
      }
      if (method === 'GET' && pathname === '/api/github/checks') {
        return json(response, 200, await github.checks(url.searchParams.get('cwd') || '', url.searchParams.get('sha') || ''));
      }
      if (method === 'GET' && pathname === '/api/tasks') return json(response, 200, tasks.list());
      if (method === 'POST' && pathname === '/api/tasks') {
        return json(response, 201, tasks.create(await readJson(request)));
      }
      const taskMatch = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(evidence|history|advance))?$/.exec(pathname);
      if (taskMatch) {
        const [, id, route] = taskMatch;
        if (!tasks.get(id)) throw new ClientError(404, 'task not found');
        if (method === 'GET' && !route) return json(response, 200, tasks.get(id));
        if (method === 'GET' && (route === 'evidence' || route === 'history')) {
          const after = Number(url.searchParams.get('after') || 0);
          return json(response, 200, route === 'evidence' ? tasks.evidence(id, after) : tasks.history(id, after));
        }
        if (method === 'POST' && route === 'evidence') {
          const payload = await readJson(request);
          return json(response, 201, tasks.addEvidence(id, payload));
        }
        if (method === 'POST' && route === 'advance') {
          const payload = await readJson(request);
          // Actor is set by this local operator endpoint; agent cannot claim
          // an approval by supplying actor='human' in the request body.
          return json(response, 200, tasks.advance(id, payload, 'human'));
        }
      }
      if (method === 'GET' && pathname === '/api/sessions') return json(response, 200, store.list());
      if (method === 'GET' && pathname === '/api/attention') return json(response, 200, deriveAttention(store));
      const dismissMatch = /^\/api\/attention\/([^/]+)\/dismiss$/.exec(pathname);
      if (method === 'POST' && dismissMatch) {
        await readJson(request);
        const id = decodeURIComponent(dismissMatch[1]);
        if (id.length > 130 || !deriveAttention(store, { includeDismissed: true }).some(item => item.id === id))
          throw new ClientError(404, 'attention item no longer exists');
        store.dismissAttention(id);
        return json(response, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/api/git/status') {
        const cwd = ensureInside(url.searchParams.get('cwd') || '', allowedRoots);
        const output = execFileSync('git', ['-C', cwd, 'status', '--short', '--branch'], { timeout: 5000, encoding: 'utf8', maxBuffer: 1_000_000 });
        return json(response, 200, { cwd, status: output.slice(0, 25_000) });
      }
      if (method === 'GET' && pathname === '/api/git/diff') {
        const cwd = ensureInside(url.searchParams.get('cwd') || '', allowedRoots);
        const output = execFileSync('git', ['-C', cwd, '--no-pager', 'diff', '--', '.'], { timeout: 7000, encoding: 'utf8', maxBuffer: 1_000_000 });
        return json(response, 200, { cwd, diff: output.slice(0, 120_000), truncated: output.length > 120_000 });
      }
      if (method === 'POST' && pathname === '/api/sessions') {
        const payload = await readJson(request);
        const session = await host.start({ adapterId: payload.adapterId, cwd: payload.cwd });
        return json(response, 201, session);
      }
      const sessionMatch = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(events|prompt|cancel|close|approvals))?$/.exec(pathname);
      if (sessionMatch) {
        const [,id,route] = sessionMatch;
        if (!store.get(id)) throw new ClientError(404, 'session not found');
        if (method === 'GET' && !route) return json(response, 200, store.get(id));
        if (method === 'GET' && route === 'events') {
          const cursor = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ClientError(400, 'invalid event cursor');
          return json(response, 200, store.events(id, cursor));
        }
        if (method === 'GET' && route === 'approvals') return json(response, 200, store.pendingApprovals(id));
        if (method === 'POST' && route === 'prompt') {
          const payload = await readJson(request);
          if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 12_000)
            throw new ClientError(400, 'invalid prompt');
          const conn = host.connections.get(id);
          if (!conn || conn.closed) throw new ClientError(409, 'agent is not connected; view-only historical session');
          if (conn.busy) throw new ClientError(409, 'agent already busy');
          // Not awaited: caller sees streaming updates through the event API.
          void host.prompt(id, payload.text).catch(() => {});
          return json(response, 202, { accepted: true });
        }
        if (method === 'POST' && route === 'cancel') {
          await readJson(request);
          return json(response, 200, await host.cancel(id));
        }
        if (method === 'POST' && route === 'close') {
          await readJson(request);
          await host.close(id);
          return json(response, 200, { ok: true });
        }
      }
      const approveMatch = /^\/api\/sessions\/([a-f0-9-]{36})\/approvals\/([a-f0-9-]{36})$/.exec(pathname);
      if (method === 'POST' && approveMatch) {
        const payload = await readJson(request);
        return json(response, 200, host.approve(approveMatch[1], approveMatch[2], payload.decision));
      }
      throw new ClientError(404, 'endpoint not found');
    } catch (error) {
      const status = error instanceof ClientError || error instanceof WorktreeError || error instanceof GitHubEvidenceError || error instanceof TaskError ? error.status
        : /workspace|adapter|approval|not connected|already processing|invalid/i.test(error.message) ? 400 : 500;
      const message = status === 500 ? 'internal runtime error' : String(error.message).slice(0, 200);
      json(response, status, { error: message });
    }
  });
  return {
    server, store, host, worktrees, github, tasks, allowedRoots,
    async listen(port = PORT) {
      return await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', rejectListen);
          resolveListen(server.address());
        });
      });
    },
    async close() {
      await host.shutdown();
      await new Promise(resolveClose => server.close(resolveClose));
      // Close DB only after all owned ACP child processes were torn down.
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const roots = (process.env.AGENTDOCK_WORKSPACE_ROOTS || process.cwd()).split(',').map(x => resolve(x.trim()));
  const runtime = createRuntimeServer({ roots });
  try {
    const address = await runtime.listen();
    console.log(`AgentDock development ACP host listening on http://127.0.0.1:${address.port} (roots: ${runtime.allowedRoots.length})`);
  } catch (e) {
    console.error('Cannot start ACP host:', e.message);
    process.exitCode = 1;
  }
  const shutdown = async () => {
    try { await runtime.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
