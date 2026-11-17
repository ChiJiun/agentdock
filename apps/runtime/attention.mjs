/**
 * Deterministic Session Sentinel over durable ACP events. Classification
 * never asks a model, executes tools, or fabricates a Task completion claim.
 *
 * IDs include source event cursors so a new meaningful event creates a new
 * notification; dismissals are persisted and do not approve ACP permissions.
 */
const priority = { decision: 0, review: 1, background: 2, completed: 3, idle: 4 };

export function deriveAttention(store, { includeDismissed = false } = {}) {
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
    const approvals = session.status === 'awaiting_approval'
      ? store.pendingApprovals(session.id) : [];
    if (approvals.length) {
      for (const approval of approvals) {
        items.push({
          ...common, id: `approval:${approval.id}`,
          type: 'decision', key: 'approval_pending', approvalId: approval.id,
          evidenceCursor: cursor,
        });
      }
      continue;
    }
    if (session.status === 'failed' || session.status === 'interrupted') {
      items.push({
        ...common, id: `attention:${session.id}:review:${cursor}`,
        type: 'review', key: session.status === 'failed' ? 'agent_failed' : 'agent_interrupted',
      });
    } else if (session.status === 'running') {
      items.push({
        ...common, id: `attention:${session.id}:progress:${cursor}`,
        type: 'background', key: 'agent_running',
      });
    } else if (session.status === 'ready' && event?.kind === 'turn_finished') {
      items.push({
        ...common, id: `attention:${session.id}:complete:${cursor}`,
        type: 'completed', key: 'turn_finished',
      });
    }
  }
  const output = includeDismissed ? items : items.filter(item => !store.wasDismissed(item.id));
  return output
    .sort((a,b) => (priority[a.type] - priority[b.type]) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100);
}

export function decisionRequiredCount(items) {
  return items.filter(item => item.type === 'decision' || item.type === 'review').length;
}
