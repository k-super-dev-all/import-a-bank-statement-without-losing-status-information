import type { FileFormat } from './validation';

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'ready'
  | 'deleting'
  | 'deleted';

export type RecurringItem = {
  id: string;
  merchant: string;
  amountMinor: number;
  cadence: string;
  lastSeen: string;
};

export type JobView = {
  jobId: string;
  status: JobStatus;
  revision: number;
  currency?: string;
  items?: RecurringItem[];
};

/** Minimal operation state persisted before the first POST. */
export type Op = {
  key: string;
  fileName: string;
  format: FileFormat;
  size: number;
  /** Private temp copy; null once the job exists or the flow ended. */
  localPath: string | null;
  /** sending: POST in flight; unknown: outcome of POST not known; created: job id known. */
  outcome: 'sending' | 'unknown' | 'created';
  jobId?: string;
  status?: JobStatus;
  revision: number;
  currency?: string;
  items?: RecurringItem[];
  deleteKey?: string;
  deleteRequested: boolean;
  error?: string;
};
