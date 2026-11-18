/**
 * Deterministic Session Sentinel over durable ACP events. Classification
 * never asks a model, executes tools, or fabricates a Task completion claim.
 *
 * The three kinds follow docs/ux/states-and-indicators.md section 4:
 *   reply      — the agent is blocked on the human (pending ACP permission).
 *                Never hidden by "mark reviewed"; it clears only when the
 *                approval is resolved or expires.
 *   review     — a result the user has not viewed yet (failed, interrupted,
 *                or a finished turn). Cleared by viewing the session or by
 *                "mark reviewed"; a later event makes it reappear.
 *   background — work in progress. Never counted, never dismissible.
 *
 * Items carry only identifiers, status and template keys. Event payloads
 * (prompts, tool titles, agent output, error text) are never copied in, so a
 * summary cannot leak credentials or grow with agent output.
 */
const order = { reply: 0, review: 1, background: 2 };
const LIVE_APPROVAL_STATES = new Set(['awaiting_approval', 'running']);
// A view taken while the session was idle or terminal covers a later
// restart-interruption at the same cursor (nothing ran in between). A view
// taken while it was running does not: the interruption lost work.
const SETTLED_VIEW_STATES = new Set(['ready', 'failed', 'interrupted', 'closed']);

function reviewKey(session, turn) {
  if (session.status === 'failed') return 'agent_failed';
  if (session.status === 'interrupted') return 'agent_interrupted';
  // UX section 2: cancelled is a result to review until viewed, like completed.
  // The newest turn is used (not the newest event), so a trailing bookkeeping
  // event such as cancel_requested cannot make a finished turn disappear.
  if (session.status === 'ready' && turn?.afterPrompt) {
    return turn.stopReason === 'cancelled' ? 'turn_cancelled' : 'turn_finished';
  }
  return null;
}

export function isViewed(view, cursor) {
  return !!view && view.cursor >= cursor && SETTLED_VIEW_STATES.has(view.status);
}

export function deriveAttention(store, { includeViewed = false } = {}) {
  const items = [];
  for (const session of store.list()) {
    const event = store.latestEvent(session.id);
    const cursor = event?.seq ?? 0;
    const common = {
      sessionId: session.id,
      adapter: session.adapter,
      cwd: session.cwd,
      status: session.status,
      evidenceCursor: cursor,
      updatedAt: session.updated_at,
    };
    // The host can resolve one approval (status -> running) while another is
    // still pending, so pending approvals are checked for every live state.
    const approvals = LIVE_APPROVAL_STATES.has(session.status)
      ? store.pendingApprovals(session.id) : [];
    for (const approval of approvals) {
      items.push({
        ...common, id: `approval:${approval.id}`,
        type: 'reply', key: 'approval_pending', approvalId: approval.id,
        updatedAt: approval.created_at,
      });
    }
    if (approvals.length) continue;
    const key = reviewKey(session, store.latestTurn(session.id));
    if (key) {
      if (includeViewed || !isViewed(store.attentionView(session.id), cursor)) {
        items.push({ ...common, id: `attention:${session.id}:review:${cursor}`, type: 'review', key });
      }
    } else if (['starting', 'running', 'awaiting_approval'].includes(session.status)) {
      items.push({ ...common, id: `attention:${session.id}:background`, type: 'background', key: 'agent_running' });
    }
  }
  return items.sort((a, b) => (order[a.type] - order[b.type])
    // Needs reply: longest-waiting first. Others: most recent first.
    || (a.type === 'reply' ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt)));
}

export function attentionCounts(items) {
  const counts = { reply: 0, review: 0, background: 0 };
  for (const item of items) counts[item.type] += 1;
  return counts;
}
