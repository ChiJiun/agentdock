import { createServer } from 'node:http';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AcpHost } from './acp-host.mjs';
import { ensureInside, loadAdapters } from './adapters.mjs';
import { SessionStore } from './store.mjs';

// Bytes, not characters: a 12,000-character CJK prompt is about 36 KB of UTF-8.
const MAX_BODY_BYTES = 128 * 1024;
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
  // Decode once at the end: decoding per chunk corrupts multi-byte characters split across chunks.
  // The rest of an oversized body is read and discarded so the 413 can still be
  // delivered: leaving the loop early would destroy the socket instead.
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES * 8) { request.destroy(); throw new ClientError(413, 'payload too large'); }
    if (size > MAX_BODY_BYTES) chunks.length = 0;
    else chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new ClientError(413, 'payload too large');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ClientError(400, 'invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientError(400, 'invalid JSON body');
  return value;
}
class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
/**
 * Reject requests addressed to any name other than the loopback of this machine.
 * Without this, a web page whose DNS name is re-pointed at 127.0.0.1 (DNS
 * rebinding) is same-origin with this API and could read history and diffs.
 */
function allowedHost(host) {
  if (typeof host !== 'string') return false;
  try {
    const { hostname } = new URL(`http://${host}`);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch { return false; }
}

const heldLocks = new Set();
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
/**
 * One host process per database. A second host would mark the live sessions
 * of the first one as interrupted while their agents are still running.
 */
function acquireLock(dbPath) {
  if (dbPath === ':memory:') return () => {};
  const lockPath = `${resolve(dbPath)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      heldLocks.add(lockPath);
      return () => {
        if (!heldLocks.delete(lockPath)) return;
        try { unlinkSync(lockPath); } catch { /* already removed */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = NaN;
      try { owner = Number(readFileSync(lockPath, 'utf8')); } catch { /* removed meanwhile */ }
      const held = owner === process.pid ? heldLocks.has(lockPath) : Number.isInteger(owner) && owner > 0 && isAlive(owner);
      if (held) throw new Error(`another AgentDock runtime (pid ${owner}) is already using ${dbPath}`);
      try { unlinkSync(lockPath); } catch { /* removed meanwhile */ }
    }
  }
  throw new Error(`could not take the runtime lock for ${dbPath}`);
}

// Repository configuration is untrusted input for an inspector that promises to be
// read-only: never run fsmonitor hooks, external diff drivers or textconv filters,
// and never take locks or rewrite the index.
const GIT_SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '--no-pager'];
function git(cwd, args, timeout) {
  return new Promise((resolveGit, rejectGit) => {
    execFile('git', ['-C', cwd, ...GIT_SAFE, ...args], {
      timeout, encoding: 'utf8', maxBuffer: 1_000_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => {
      // Output beyond the buffer is cut off, which the caller reports as truncated.
      if (!error || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolveGit(String(stdout ?? ''));
      rejectGit(new ClientError(422, 'git inspection failed for this directory'));
    });
  });
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
  limits = {},
} = {}) {
  const allowedRoots = roots.map(root => realpathSync(root));
  const releaseLock = acquireLock(dbPath);
  let store;
  try { store = new SessionStore(dbPath); }
  catch (error) { releaseLock(); throw error; }
  const host = new AcpHost({ store, roots: allowedRoots, adapters, limits });
  const server = createServer(async (request, response) => {
    try {
      const method = request.method;
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      if (!allowedHost(request.headers.host)) throw new ClientError(403, 'unexpected Host header');
      if (request.headers.origin && !allowedOrigin(request.headers.origin)) {
        throw new ClientError(403, 'cross-origin request rejected');
      }
      if (method === 'GET' && pathname === '/api/health') return json(response, 200, { ok: true, mode: 'local-development', protocol: 'ACP v1', storage: 'sqlite' });
      if (method === 'GET' && pathname === '/api/adapters') return json(response, 200, adapters.map(({ id, label }) => ({ id, label })));
      if (method === 'GET' && pathname === '/api/workspaces') return json(response, 200, allowedRoots.map(path => ({ path })));
      if (method === 'GET' && pathname === '/api/sessions') return json(response, 200, store.list());
      if (method === 'GET' && pathname === '/api/git/status') {
        const cwd = ensureInside(url.searchParams.get('cwd') || '', allowedRoots);
        const output = await git(cwd, ['status', '--short', '--branch'], 5000);
        return json(response, 200, { cwd, status: output.slice(0, 25_000), truncated: output.length > 25_000 });
      }
      if (method === 'GET' && pathname === '/api/git/diff') {
        const cwd = ensureInside(url.searchParams.get('cwd') || '', allowedRoots);
        const output = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--', '.'], 7000);
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
          if (!conn || conn.closed || !conn.ctx) throw new ClientError(409, 'agent is not connected; view-only historical session');
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
      // ClientError and HostError carry a status and an operator-safe message.
      const status = Number.isInteger(error?.status) ? error.status
        : /workspace|adapter/i.test(String(error?.message)) ? 400 : 500;
      const message = status === 500 ? 'internal runtime error' : String(error.message).slice(0, 200);
      if (!response.headersSent) json(response, status, { error: message });
      else response.destroy();
    }
  });
  return {
    server, store, host, allowedRoots,
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
      await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections?.(); });
      // Close DB only after all owned ACP child processes were torn down.
      store.close();
      releaseLock();
    },
    /** Synchronous last resort when the process is going away without `close()`. */
    abandon() {
      host.killAllSync();
      releaseLock();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const roots = (process.env.AGENTDOCK_WORKSPACE_ROOTS || process.cwd()).split(',').map(x => resolve(x.trim()));
  const initTimeoutMs = Number(process.env.AGENTDOCK_INIT_TIMEOUT_MS);
  let runtime;
  try {
    runtime = createRuntimeServer({ roots, limits: Number.isFinite(initTimeoutMs) && initTimeoutMs >= 1000 ? { initTimeoutMs } : {} });
    const address = await runtime.listen();
    console.log(`AgentDock development ACP host listening on http://127.0.0.1:${address.port} (roots: ${runtime.allowedRoots.length})`);
  } catch (e) {
    console.error('Cannot start ACP host:', e.message);
    runtime?.abandon();
    process.exit(1);
  }
  let stopping = false;
  const shutdown = async code => {
    if (stopping) return;
    stopping = true;
    try { await runtime.close(); } finally { process.exit(code); }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(signal, () => void shutdown(0));
  // An agent must not outlive a host that dies on a programming error.
  process.on('uncaughtException', error => {
    console.error('ACP host stopping after an unexpected error:', error?.message);
    void shutdown(1);
  });
  process.on('exit', () => runtime.abandon());
}
