import { execFile, spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { childEnvironment, ensureInside } from './adapters.mjs';

const MAX_PROMPT = 12_000;
const TERMINAL = new Set(['closed', 'failed', 'interrupted']);
const CANCELLED = { outcome: { outcome: 'cancelled' } };

export const DEFAULT_LIMITS = Object.freeze({
  approvalTtlMs: 90_000,
  // Node-based agents can take well over 10 s to cold-start on a busy Windows machine.
  initTimeoutMs: 30_000,
  stdinGraceMs: 1_500,
  killGraceMs: 3_000,
  maxLiveSessions: 8,
  maxPendingApprovals: 16,
  maxMessageBytes: 16 * 1024 * 1024,
});

/** An error whose message is safe to show to the local operator, with an HTTP status. */
export class HostError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hasExited = proc => proc.exitCode !== null || proc.signalCode !== null;

function taskkill() {
  return join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * Stop the agent and everything it started.
 * Windows has no process groups: `child.kill()` ends only the direct child, so
 * the tree is walked with taskkill. POSIX agents are spawned as group leaders.
 * This is best effort; the production Rust host must use a Job Object (ADR-0002).
 */
function signalTree(proc, signal) {
  if (!proc.pid || hasExited(proc)) return;
  if (process.platform === 'win32') {
    execFile(taskkill(), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, error => {
      if (error && !hasExited(proc)) { try { proc.kill(); } catch { /* already gone */ } }
    });
    return;
  }
  try { process.kill(-proc.pid, signal); }
  catch { try { proc.kill(signal); } catch { /* already gone */ } }
}

function killTreeSync(proc) {
  if (!proc.pid || hasExited(proc)) return;
  try {
    if (process.platform === 'win32') spawnSync(taskkill(), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function waitForExit(proc, ms) {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { proc.off('exit', onExit); resolve(false); }, ms);
    proc.once('exit', onExit);
  });
}

/**
 * A real ACP v1 client wrapping existing external coding-agent binaries.
 * The mock fixture uses this exact transport; no model or shell-based prompt parsing.
 *
 * This development runtime is intentionally separate from the future Tauri/Rust host.
 * Browser requests choose a named, locally configured adapter, never a shell command.
 */
export class AcpHost {
  constructor({ store, roots, adapters, limits = {} }) {
    this.store = store;
    this.roots = roots;
    this.adapters = new Map(adapters.map(a => [a.id, a]));
    this.connections = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Store writes from timers and process events must never crash the host. */
  #safely(fn) {
    try { return fn(); } catch { return undefined; }
  }

  #markFailed(connection, code, message) {
    this.#safely(() => {
      const current = this.store.get(connection.id);
      if (!current || TERMINAL.has(current.status)) return;
      this.store.atomic(() => {
        this.store.status(connection.id, 'failed');
        this.store.event(connection.id, 'error', { code, message: String(message).slice(0, 500) });
      });
    });
  }

  /** Answer every waiting permission request with `cancelled` and record why. */
  #releasePending(connection, reason) {
    for (const [approvalId, pending] of connection.pending) {
      clearTimeout(pending.timer);
      this.#safely(() => this.store.atomic(() => {
        if (this.store.resolveApproval(approvalId, null, 'cancelled'))
          this.store.event(connection.id, 'approval_resolved', { approvalId, decision: 'cancelled', reason });
      }));
      pending.resolve(CANCELLED);
    }
    connection.pending.clear();
  }

  /** Leave `awaiting_approval` only when no other request is still waiting. */
  #afterApproval(connection) {
    const current = this.store.get(connection.id);
    if (!current || current.status !== 'awaiting_approval' || connection.pending.size) return;
    this.store.status(connection.id, connection.busy ? 'running' : 'ready');
  }

  async start({ adapterId, cwd }) {
    const adapter = typeof adapterId === 'string' ? this.adapters.get(adapterId) : undefined;
    if (!adapter) throw new HostError(400, 'unknown adapter');
    if (typeof cwd !== 'string') throw new HostError(400, 'workspace path must be absolute');
    const path = ensureInside(cwd, this.roots);
    if (!statSync(path).isDirectory()) throw new HostError(400, 'workspace path must be a directory');
    const live = [...this.connections.values()].filter(c => !c.closed).length;
    if (live >= this.limits.maxLiveSessions) throw new HostError(429, 'too many live agent sessions; close one first');

    const id = randomUUID();
    this.store.create({ id, adapter: adapter.id, cwd: path });

    const connection = {
      id, proc: null, ctx: null, agentSessionId: null, busy: false, ready: false,
      stop: null, closed: false, closing: null, startError: null,
      pending: new Map(), early: [], done: null,
    };
    let proc;
    try {
      proc = spawn(adapter.bin, adapter.args, {
        cwd: path, env: childEnvironment(adapter.authEnv), shell: false,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX so the whole tree can be signalled.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      this.#markFailed(connection, 'spawn_failed', error.code || error.name);
      throw new HostError(502, `Could not launch configured agent: ${error.code || error.name}`, 'spawn_failed');
    }
    connection.proc = proc;
    this.connections.set(id, connection);

    let readyResolve;
    let readyReject;
    let completed = false;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const becomeReady = () => { if (!completed) { completed = true; readyResolve(this.store.get(id)); } };
    const failReady = err => { if (!completed) { completed = true; readyReject(err); } };
    const hold = new Promise(resolve => { connection.stop = resolve; });

    // A broken pipe must surface as a failed request, not as an uncaught stream error.
    for (const pipe of [proc.stdin, proc.stdout, proc.stderr]) pipe?.on('error', () => {});
    proc.stderr?.on('data', chunk => {
      // Drained so a full pipe cannot stall the agent. Stderr may contain
      // credentials; intentionally do not persist or expose it.
      void chunk;
    });
    proc.on('error', err => {
      failReady(new HostError(502, `Could not launch configured agent: ${err.code || err.name}`, 'spawn_failed'));
    });
    proc.on('exit', (code, signal) => {
      connection.closed = true;
      this.#releasePending(connection, 'agent_exited');
      connection.stop();
      this.#safely(() => {
        const old = this.store.get(id);
        if (!old || TERMINAL.has(old.status)) return;
        this.store.atomic(() => {
          // Dying before the handshake finished is a start failure, not an interruption.
          this.store.status(id, connection.ready ? 'interrupted' : 'failed');
          this.store.event(id, 'process_exit', { exitCode: code, signal, duringStartup: !connection.ready });
        });
      });
      failReady(new HostError(502, 'Agent exited before initialization', 'exited_before_init'));
      // A crashed agent has nothing left to close; drop the entry once the transport settles.
      if (!connection.closing) Promise.resolve(connection.done).finally(() => {
        if (!connection.closing && this.connections.get(id) === connection) this.connections.delete(id);
      });
    });

    const recordUpdate = update => this.store.event(id, 'agent_update', { update });
    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout), {
      // One oversized line ends this connection explicitly instead of growing without bound.
      maxMessageBytes: this.limits.maxMessageBytes,
    });
    const app = acp.client({ name: 'agentdock-dev-host' })
      .onNotification(acp.methods.client.session.update, ctx => {
        const params = ctx.params;
        if (!params?.update || connection.closed) return;
        if (connection.agentSessionId === null) {
          // Agents may announce commands before the session/new reply is processed here.
          if (connection.early.length < 64) connection.early.push(params);
          return;
        }
        if (params.sessionId !== connection.agentSessionId) return;
        // Output length is bounded and secrets are redacted by the store.
        recordUpdate(params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, async ctx => {
        const request = ctx.params ?? {};
        // Fail closed: nothing is ever allowed without an explicit human decision.
        if (connection.closed || request.sessionId !== connection.agentSessionId) return CANCELLED;
        if (connection.pending.size >= this.limits.maxPendingApprovals) {
          this.store.event(id, 'approval_rejected', { reason: 'too_many_pending' });
          return CANCELLED;
        }
        const approvalId = randomUUID();
        const options = (Array.isArray(request.options) ? request.options : []).slice(0, 12).map(o => ({
          id: String(o?.optionId), kind: String(o?.kind), name: String(o?.name).slice(0, 120),
        }));
        const tool = request.toolCall ?? {};
        const title = String(tool.title || 'Tool access requested').slice(0, 200);
        // What the human is deciding on. The store redacts and bounds it.
        const detail = {
          kind: tool.kind == null ? null : String(tool.kind).slice(0, 40),
          input: tool.rawInput ?? null,
          locations: (Array.isArray(tool.locations) ? tool.locations : []).slice(0, 8).map(l => String(l?.path).slice(0, 400)),
        };
        const ttl = this.limits.approvalTtlMs;
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + ttl).toISOString();
        this.store.atomic(() => {
          this.store.createApproval({ id: approvalId, sessionId: id, title, choices: options, detail, createdAt, expiresAt });
          this.store.status(id, 'awaiting_approval');
          this.store.event(id, 'approval_requested', { approvalId, title, choices: options, detail, expiresAt });
        });
        return await new Promise(resolve => {
          const timer = setTimeout(() => {
            if (!connection.pending.delete(approvalId)) return;
            this.#safely(() => this.store.atomic(() => {
              this.store.resolveApproval(approvalId, null, 'expired');
              this.store.event(id, 'approval_resolved', { approvalId, decision: 'expired' });
              this.#afterApproval(connection);
            }));
            resolve(CANCELLED);
          }, ttl);
          timer.unref?.();
          connection.pending.set(approvalId, { resolve, timer, options });
        });
      });

    // Keep the ACP transport alive after session/new, while HTTP requests invoke
    // prompt/permission independently. On process death, async operations reject.
    connection.done = app.connectWith(stream, async ctx => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // No fs/terminal capability: the agent cannot ask this host to touch files or run commands.
        clientCapabilities: {},
      });
      if (initialized?.protocolVersion !== acp.PROTOCOL_VERSION) {
        // Kept on the connection: the SDK may wrap what this callback throws.
        connection.startError = new HostError(502, `agent answered with unsupported ACP protocol version ${String(initialized?.protocolVersion).slice(0, 20)}`, 'unsupported_protocol');
        throw connection.startError;
      }
      const response = await ctx.request(acp.methods.agent.session.new, {
        cwd: path, mcpServers: [],
      });
      if (connection.closed) return; // start already timed out or was closed
      connection.ctx = ctx;
      connection.agentSessionId = response.sessionId;
      connection.ready = true;
      const supportsLoad = initialized.agentCapabilities?.loadSession === true;
      this.store.atomic(() => {
        this.store.status(id, 'ready', { agentSessionId: response.sessionId, supportsLoad });
        this.store.event(id, 'connected', { protocol: initialized.protocolVersion, supportsLoad });
        for (const params of connection.early.splice(0)) {
          if (params.sessionId === response.sessionId) recordUpdate(params.update);
        }
      });
      becomeReady();
      await hold;
    }).catch(err => {
      const cause = connection.startError
        ?? new HostError(502, `ACP connection failed: ${String(err?.message || err).slice(0, 150)}`, 'acp_connection_failed');
      if (!connection.closed) this.#markFailed(connection, cause.code, cause.message);
      failReady(cause);
    });

    let startTimer;
    try {
      return await Promise.race([
        ready,
        new Promise((_, reject) => {
          startTimer = setTimeout(() => reject(new HostError(504, 'agent initialization timeout', 'init_timeout')), this.limits.initTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.#markFailed(connection, error.code || 'start_failed', error.message);
      await this.close(id).catch(() => {});
      throw error;
    } finally {
      clearTimeout(startTimer);
    }
  }

  async prompt(id, prompt) {
    const conn = this.connections.get(id);
    if (!conn || conn.closed || !conn.ctx) throw new HostError(409, 'agent process is not connected');
    if (conn.busy) throw new HostError(409, 'agent is already processing a prompt');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw new HostError(400, 'invalid prompt text');
    conn.busy = true;
    this.store.atomic(() => {
      this.store.status(id, 'running');
      this.store.event(id, 'user_message', { text: prompt });
    });
    // Intentionally await in background when invoked by HTTP handler.
    try {
      const result = await conn.ctx.request(acp.methods.agent.session.prompt, {
        sessionId: conn.agentSessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      conn.busy = false;
      if (!conn.closed) {
        this.store.atomic(() => {
          this.store.status(id, 'ready');
          this.store.event(id, 'turn_finished', { stopReason: result.stopReason });
        });
      }
      return result;
    } catch (e) {
      conn.busy = false;
      if (!conn.closed) {
        // `failed` is final: stop the agent instead of leaving a live process behind a dead session.
        this.#markFailed(conn, 'prompt_failed', String(e?.message || e));
        void this.close(id).catch(() => {});
      }
      throw e;
    }
  }

  approve(sessionId, approvalId, decision) {
    if (decision !== 'deny' && decision !== 'allow_once') throw new HostError(400, 'invalid approval decision');
    const conn = this.connections.get(sessionId);
    const pending = conn?.pending.get(approvalId);
    const record = this.store.getApproval(approvalId);
    if (!pending || !record || record.session_id !== sessionId) throw new HostError(409, 'approval not pending');
    // Only options the agent advertised for exactly one use are ever selected;
    // allow_always / reject_always are never chosen on the user's behalf.
    const selected = pending.options.find(o => o.kind === (decision === 'allow_once' ? 'allow_once' : 'reject_once'));
    if (decision === 'allow_once' && !selected) throw new HostError(409, 'agent offers no one-time permission');
    const resolved = this.store.atomic(() => {
      if (!this.store.resolveApproval(approvalId, selected?.id ?? null, decision === 'deny' ? 'denied' : 'approved')) return false;
      clearTimeout(pending.timer);
      conn.pending.delete(approvalId);
      this.store.event(sessionId, 'approval_resolved', { approvalId, decision });
      this.#afterApproval(conn);
      return true;
    });
    if (!resolved) throw new HostError(409, 'approval expired or already handled');
    // A denial without an advertised reject option is reported as `cancelled`, which never grants access.
    pending.resolve(selected ? { outcome: { outcome: 'selected', optionId: selected.id } } : CANCELLED);
    return { ok: true, decision };
  }

  async cancel(id) {
    const conn = this.connections.get(id);
    if (!conn || conn.closed) throw new HostError(409, 'agent process is not connected');
    if (!conn.busy) return { ok: true, active: false };
    this.store.event(id, 'cancel_requested', { by: 'user' });
    try {
      await conn.ctx.notify(acp.methods.agent.session.cancel, { sessionId: conn.agentSessionId });
    } catch {
      // Transport failure must not leave an approval pending for its full TTL.
      // The agent's cancellation cannot be confirmed: fail closed and tear it down.
      this.#releasePending(conn, 'cancel_transport_failed');
      this.#markFailed(conn, 'cancel_failed', 'ACP cancellation transport failed');
      void this.close(id).catch(() => {});
      throw new HostError(502, 'ACP cancellation failed; session is closing', 'cancel_failed');
    }
    // ACP: after session/cancel the client answers every pending permission request with `cancelled`.
    this.#releasePending(conn, 'turn_cancelled');
    this.#safely(() => this.#afterApproval(conn));
    return { ok: true, active: true };
  }

  close(id) {
    const conn = this.connections.get(id);
    if (!conn) return Promise.resolve();
    conn.closing ??= this.#close(conn);
    return conn.closing;
  }

  async #close(conn) {
    const { id, proc } = conn;
    conn.closed = true;
    if (conn.busy && conn.ctx && proc.pid && !hasExited(proc)) {
      // ACP v1 has no session/close in its baseline: cancel the running turn before stopping the process.
      const brief = new Promise(resolve => { setTimeout(resolve, 500).unref?.(); });
      await Promise.race([
        Promise.resolve().then(() => conn.ctx.notify(acp.methods.agent.session.cancel, { sessionId: conn.agentSessionId })).catch(() => {}),
        brief,
      ]);
    }
    this.#releasePending(conn, 'session_closed');
    this.#safely(() => {
      const current = this.store.get(id);
      if (!current || TERMINAL.has(current.status)) return;
      this.store.atomic(() => {
        this.store.status(id, 'closed');
        this.store.event(id, 'closed', { by: 'user' });
      });
    });
    conn.stop?.();
    // No pid means the process never started, so there is nothing to wait for.
    if (proc.pid && !hasExited(proc)) {
      // Orderly first: end stdin and let the agent leave on its own.
      try { proc.stdin.end(); } catch { /* pipe already closed */ }
      if (!await waitForExit(proc, this.limits.stdinGraceMs)) {
        signalTree(proc, 'SIGTERM');
        if (!await waitForExit(proc, this.limits.killGraceMs)) {
          signalTree(proc, 'SIGKILL');
          await waitForExit(proc, this.limits.killGraceMs);
        }
      }
    }
    await conn.done?.catch(() => {});
    if (this.connections.get(id) === conn) this.connections.delete(id);
  }

  async shutdown() {
    await Promise.all([...this.connections.keys()].map(id => this.close(id)));
  }

  /** Last resort for `process.on('exit')`: no agent may outlive the host. */
  killAllSync() {
    for (const conn of this.connections.values()) if (conn.proc) killTreeSync(conn.proc);
  }
}
