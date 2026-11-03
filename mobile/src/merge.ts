import type { JobView, Op } from './types';

/**
 * Applies a server status to local state. Older revisions never roll the UI back,
 * and once deletion was accepted a late ready/processing answer cannot resurrect the job.
 */
export function mergeStatus(op: Op, incoming: JobView): Op {
  if (op.jobId && incoming.jobId !== op.jobId) {
    return op;
  }
  if (op.status === 'deleted') {
    return op;
  }
  if (
    op.deleteRequested &&
    incoming.status !== 'deleting' &&
    incoming.status !== 'deleted'
  ) {
    return op;
  }
  if (incoming.revision < op.revision) {
    return op;
  }
  return {
    ...op,
    outcome: 'created',
    jobId: incoming.jobId,
    status: incoming.status,
    revision: incoming.revision,
    currency: incoming.currency ?? op.currency,
    items: incoming.items ?? op.items,
    error: undefined,
  };
}
