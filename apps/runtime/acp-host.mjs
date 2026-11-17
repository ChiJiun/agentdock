import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { childEnvironment, ensureInside } from './adapters.mjs';

const MAX_PROMPT = 12_000;
const EXPIRES_MS = 90_000;

/**
 * A real ACP v1 client wrapping existing external coding-agent binaries.
 * The mock fixture uses this exact transport; no model or shell-based prompt parsing.
 *
 * This development runtime is intentionally separate from the future Tauri/Rust host.
 * Browser requests choose a named, locally configured adapter, never a shell command.
 */
export class AcpHost {
  constructor({ store, roots, adapters }) {
    this.store = store;
    this.roots = roots;
    this.adapters = new Map(adapters.map(a => [a.id, a]));
    this.connections = new Map();
  }

  async start({ adapterId, cwd }) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error('unknown adapter');
    const path = ensureInside(cwd, this.roots);
    const id = randomUUID();
    this.store.create({ id, adapter: adapter.id, cwd: path });

    const proc = spawn(adapter.bin, adapter.args, {
      cwd: path, env: childEnvironment(adapter.authEnv), shell: false,
      windowsHide: true, stdio: ['pipe','pipe','pipe'],
    });
    const connection = {
      id, proc, ctx: null, agentSessionId: null, busy: false,
      stop: null, closed: false, pending: new Map(), done: null,
    };
    this.connections.set(id, connection);

    let readyResolve;
    let readyReject;
    let completed = false;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const becomeReady = () => { completed = true; readyResolve(this.store.get(id)); };
    const failReady = err => { if (!completed) { completed = true; readyReject(err); } };
    const hold = new Promise(resolve => { connection.stop = resolve; });

    const releasePending = () => {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ outcome: { outcome: 'cancelled' } });
      }
      connection.pending.clear();
    };

    proc.stderr.on('data', chunk => {
      // Stderr may contain credentials; intentionally do not persist or expose it.
      void chunk;
    });
    proc.on('error', err => {
      failReady(new Error(`Could not launch configured agent: ${err.code || err.name}`));
    });
    proc.on('exit', (code, signal) => {
      connection.closed = true;
      releasePending();
      if (connection.stop) connection.stop();
      const old = this.store.get(id);
      if (old && !['closed','failed'].includes(old.status)) {
        this.store.status(id, 'interrupted');
        this.store.event(id, 'process_exit', { exitCode: code, signal });
      }
      failReady(new Error('Agent exited before initialization'));
    });

    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const app = acp.client({ name: 'agentdock-dev-host' })
      .onNotification(acp.methods.client.session.update, ctx => {
        const update = ctx.params?.update;
        if (!update || ctx.params.sessionId !== connection.agentSessionId) return;
        // Restrict output length and redact secrets in durable store.
        this.store.event(id, 'agent_update', { update });
      })
      .onRequest(acp.methods.client.session.requestPermission, async ctx => {
        const request = ctx.params;
        const approvalId = randomUUID();
        const options = (request.options || []).map(o => ({
          id: String(o.optionId), kind: String(o.kind), name: String(o.name),
        })).slice(0, 12);
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + EXPIRES_MS).toISOString();
        this.store.createApproval({ id: approvalId, sessionId: id, title: String(request.toolCall?.title || 'Tool access requested').slice(0, 200), choices: options, createdAt, expiresAt });
        this.store.status(id, 'awaiting_approval');
        this.store.event(id, 'approval_requested', { approvalId, title: request.toolCall?.title, choices: options });
        return await new Promise(resolve => {
          const timer = setTimeout(() => {
            if (!connection.pending.has(approvalId)) return;
            connection.pending.delete(approvalId);
            this.store.resolveApproval(approvalId, null, 'expired');
            this.store.event(id, 'approval_resolved', { approvalId, decision: 'expired' });
            this.store.status(id, 'running');
            resolve({ outcome: { outcome: 'cancelled' } });
          }, EXPIRES_MS);
          timer.unref?.();
          connection.pending.set(approvalId, { resolve, timer, options });
        });
      });

    // Keep the ACP transport alive after session/new, while HTTP requests invoke
    // prompt/permission independently. On process death, async operations reject.
    connection.done = app.connectWith(stream, async ctx => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const response = await ctx.request(acp.methods.agent.session.new, {
        cwd: path, mcpServers: [],
      });
      connection.ctx = ctx;
      connection.agentSessionId = response.sessionId;
      this.store.status(id, 'ready', {
        agentSessionId: response.sessionId,
        supportsLoad: initialized.agentCapabilities?.loadSession === true,
      });
      this.store.event(id, 'connected', {
        protocol: initialized.protocolVersion,
        supportsLoad: initialized.agentCapabilities?.loadSession === true,
      });
      becomeReady();
      await hold;
    }).catch(err => {
      const old = this.store.get(id);
      if (!connection.closed && old && old.status !== 'closed') {
        this.store.status(id, 'failed');
        this.store.event(id, 'error', { code: 'acp_connection_failed', message: String(err.message || err).slice(0, 500) });
      }
      failReady(new Error(`ACP connection failed: ${String(err.message || err).slice(0, 150)}`));
    });

    let startTimer;
    try {
      return await Promise.race([
        ready,
        new Promise((_, reject) => { startTimer = setTimeout(() => reject(new Error('agent initialization timeout')), 15_000); }),
      ]);
    } catch (error) {
      await this.close(id).catch(() => {});
      throw error;
    } finally {
      clearTimeout(startTimer);
    }
  }

  async prompt(id, prompt) {
    const conn = this.connections.get(id);
    if (!conn || conn.closed || !conn.ctx) throw new Error('agent process is not connected');
    if (conn.busy) throw new Error('agent is already processing a prompt');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw new Error('invalid prompt text');
    conn.busy = true;
    this.store.status(id, 'running');
    this.store.event(id, 'user_message', { text: prompt });
    // Intentionally await in background when invoked by HTTP handler.
    try {
      const result = await conn.ctx.request(acp.methods.agent.session.prompt, {
        sessionId: conn.agentSessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      if (!conn.closed) {
        this.store.status(id, 'ready');
        this.store.event(id, 'turn_finished', { stopReason: result.stopReason });
      }
      return result;
    } catch (e) {
      if (!conn.closed) {
        this.store.status(id, 'failed');
        this.store.event(id, 'error', { code: 'prompt_failed', message: String(e.message || e).slice(0, 500) });
      }
      throw e;
    } finally {
      conn.busy = false;
    }
  }

  approve(sessionId, approvalId, decision) {
    const conn = this.connections.get(sessionId);
    const pending = conn?.pending.get(approvalId);
    const record = this.store.getApproval(approvalId);
    if (!pending || !record || record.session_id !== sessionId) throw new Error('approval not pending');
    if (decision !== 'deny' && decision !== 'allow_once') throw new Error('invalid approval decision');
    const selected = decision === 'allow_once'
      ? pending.options.find(o => o.kind === 'allow_once')
      : undefined;
    if (decision === 'allow_once' && !selected) throw new Error('agent offers no one-time permission');
    if (!this.store.resolveApproval(approvalId, selected?.id ?? null, decision === 'deny' ? 'denied' : 'approved')) throw new Error('approval expired or already handled');
    clearTimeout(pending.timer);
    conn.pending.delete(approvalId);
    this.store.status(sessionId, 'running');
    this.store.event(sessionId, 'approval_resolved', { approvalId, decision });
    pending.resolve({ outcome: selected
      ? { outcome: 'selected', optionId: selected.id }
      : { outcome: 'cancelled' } });
    return { ok: true, decision };
  }

  async cancel(id) {
    const conn = this.connections.get(id);
    if (!conn || conn.closed) throw new Error('agent process is not connected');
    if (!conn.busy) return { ok: true, active: false };
    await conn.ctx.notify(acp.methods.agent.session.cancel, { sessionId: conn.agentSessionId });
    this.store.event(id, 'cancel_requested', { by: 'user' });
    return { ok: true, active: true };
  }

  async close(id) {
    const conn = this.connections.get(id);
    if (!conn) return;
    const alreadyExited = conn.proc.exitCode !== null || conn.proc.signalCode !== null;
    let exitWait = Promise.resolve();
    if (!alreadyExited) {
      exitWait = new Promise(resolveExit => {
        const timer = setTimeout(() => { conn.proc.kill('SIGKILL'); resolveExit(); }, 3_000);
        timer.unref?.();
        conn.proc.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
    }
    if (!conn.closed) {
      conn.closed = true;
      for (const p of conn.pending.values()) { clearTimeout(p.timer); p.resolve({ outcome: { outcome: 'cancelled' } }); }
      conn.pending.clear();
      conn.stop();
      if (!alreadyExited) conn.proc.kill('SIGTERM');
      this.store.status(id, 'closed');
      this.store.event(id, 'closed', { by: 'user' });
    }
    await exitWait;
    await conn.done?.catch(() => {});
    this.connections.delete(id);
  }
  async shutdown() {
    await Promise.all([...this.connections.keys()].map(id => this.close(id)));
  }
}
