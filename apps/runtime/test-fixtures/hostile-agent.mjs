/**
 * Misbehaving ACP agents for the runtime tests. Mode is argv[2].
 * Speaks raw newline-delimited JSON-RPC on purpose, so it can break the rules
 * the official SDK would otherwise keep for it.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const SESSION = 'hostile-session';
const text = value => ({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
} });

if (mode === 'exit-early') process.exit(3);

// Never leave on stdin EOF: the host has to stop this process itself.
if (mode === 'stubborn') setInterval(() => {}, 1_000);

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    if (mode === 'hang-init') return;
    return reply(message.id, { protocolVersion: mode === 'wrong-version' ? 2 : 1, agentCapabilities: {} });
  }
  if (message.method === 'session/new') {
    reply(message.id, { sessionId: SESSION });
    // Sent right behind the reply, before the host can have stored the session id.
    if (mode === 'early-update') send(text('early update'));
    return;
  }
  if (message.method === 'session/prompt') {
    if (mode === 'bad-bytes') {
      // A line that is not valid UTF-8, then a line that is not JSON, then a normal update.
      process.stdout.write(Buffer.concat([Buffer.from([0xff, 0xfe, 0xc3, 0x28]), Buffer.from('\n')]));
      process.stdout.write('this is not json\n');
      send(text('still connected after bad bytes'));
      return reply(message.id, { stopReason: 'end_turn' });
    }
    if (mode === 'oversize') {
      // One line far beyond the host limit, never terminated.
      process.stdout.write(Buffer.alloc(512 * 1024, 0x41));
      return;
    }
    if (mode === 'stubborn') {
      // A grandchild that would be orphaned if only the direct child were killed.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      send(text(`grandchild pid ${child.pid}`));
      return reply(message.id, { stopReason: 'end_turn' });
    }
    if (mode === 'prompt-error') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'boom' } });
    return reply(message.id, { stopReason: 'end_turn' });
  }
});
