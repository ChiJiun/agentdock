/** A deterministic ACP v1 test agent, exercising the real official SDK transport. */
import * as acp from '@agentclientprotocol/sdk';
import { Writable, Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const sessions = new Map();
const app = acp.agent({ name: 'agentdock-test-agent' });
app.onRequest(acp.methods.agent.initialize, async () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: { loadSession: false },
}));
app.onRequest(acp.methods.agent.session.new, async ctx => {
  const id = randomUUID();
  sessions.set(id, { cancelled: false });
  return { sessionId: id };
});
app.onRequest(acp.methods.agent.session.prompt, async ctx => {
  const { sessionId, prompt } = ctx.params;
  const session = sessions.get(sessionId);
  if (!session) throw acp.RequestError.sessionNotFound(sessionId);
  session.cancelled = false;
  const question = prompt.filter(p => p.type === 'text').map(p => p.text).join('\n');
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `[Mock agent] Received: ${question.slice(0, 160)}. No files were changed.` } },
  });
  if (/approval/i.test(question)) {
    const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: randomUUID(), title: 'Mock read-only approval request', kind: 'read', status: 'pending' },
      options: [
        { optionId: 'allow-once', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: response.outcome.outcome === 'selected' ? 'Approved in mock. No real tool executed.' : 'Mock permission was denied.' } },
    });
  }
  return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' };
});
app.onNotification(acp.methods.agent.session.cancel, ctx => {
  sessions.get(ctx.params.sessionId) && (sessions.get(ctx.params.sessionId).cancelled = true);
});

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
await app.connectWith(stream, async () => await new Promise(resolve => {
  process.on('SIGTERM', resolve);
  process.on('SIGINT', resolve);
  process.stdin.on('end', resolve);
}));
