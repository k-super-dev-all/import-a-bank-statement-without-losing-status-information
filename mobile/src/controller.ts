import { HttpError, NetworkError, type Api } from './api';
import { mergeStatus } from './merge';
import type { JobView, Op } from './types';
import {
  checkSize,
  detectFormat,
  rejectionMessage,
  type FileFormat,
} from './validation';

export type Candidate = {
  fileName: string;
  size: number;
  format: FileFormat;
  localPath: string;
};

export type Files = {
  pick(): Promise<{
    fileName: string;
    size: number | null;
    localPath: string | null;
  } | null>;
  readHead(path: string): Promise<Uint8Array>;
  deleteCopy(path: string | null): Promise<void>;
};

export type Store = {
  load(): Promise<Op | null>;
  save(op: Op | null): Promise<void>;
};

export type ViewState = {
  candidate: Candidate | null;
  op: Op | null;
  notice: string | null;
  busy: boolean;
};

export const newKey = () =>
  Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0'),
  ).join('');

const PENDING = ['queued', 'processing', 'deleting'];
const OFFLINE = 'Connection problem. Will retry.';

export class ImportController {
  state: ViewState = { candidate: null, op: null, notice: null, busy: false };
  private listeners = new Set<() => void>();

  constructor(
    private api: Api,
    private files: Files,
    private store: Store,
    private makeKey: () => string = newKey,
  ) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<ViewState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(l => l());
  }

  private async setOp(op: Op | null) {
    await this.store.save(op);
    this.set({ op });
  }

  get needsPolling() {
    const op = this.state.op;
    return !!op && op.outcome === 'created' && PENDING.includes(op.status!);
  }

  /** Restores persisted state. Never re-sends the file on its own. */
  async init() {
    let op = await this.store.load();
    if (!op) {
      return;
    }
    if (op.outcome === 'sending') {
      op = { ...op, outcome: 'unknown' };
    }
    await this.setOp(op);
    if (op.outcome === 'unknown') {
      await this.recover(false);
    } else {
      await this.refresh();
    }
  }

  async choose() {
    this.set({ notice: null, busy: true });
    try {
      const picked = await this.files.pick();
      if (!picked) {
        return;
      }
      if (picked.localPath === null) {
        this.set({ notice: rejectionMessage('too_large') });
        return;
      }
      const size = picked.size ?? 0;
      const sizeProblem = checkSize(size);
      if (sizeProblem) {
        await this.files.deleteCopy(picked.localPath);
        this.set({ notice: rejectionMessage(sizeProblem) });
        return;
      }
      const format = detectFormat(await this.files.readHead(picked.localPath));
      if (!format) {
        await this.files.deleteCopy(picked.localPath);
        this.set({ notice: rejectionMessage('not_pdf_or_csv') });
        return;
      }
      this.set({
        candidate: {
          fileName: picked.fileName,
          size,
          format,
          localPath: picked.localPath,
        },
      });
    } catch {
      this.set({ notice: 'Could not read that file.' });
    } finally {
      this.set({ busy: false });
    }
  }

  async cancelCandidate() {
    await this.files.deleteCopy(this.state.candidate?.localPath ?? null);
    this.set({ candidate: null });
  }

  /** Key and state are persisted before the first byte is sent. */
  async confirm() {
    const c = this.state.candidate;
    if (!c || this.state.op) {
      return;
    }
    const op: Op = {
      key: this.makeKey(),
      fileName: c.fileName,
      format: c.format,
      size: c.size,
      localPath: c.localPath,
      outcome: 'sending',
      revision: 0,
      deleteRequested: false,
    };
    this.set({ candidate: null, notice: null });
    await this.setOp(op);
    await this.send();
  }

  private async send() {
    const op = this.state.op!;
    this.set({ busy: true });
    try {
      const job = await this.api.create(op.key, op.fileName, op.localPath!);
      await this.adopt(job);
    } catch (e) {
      if (e instanceof HttpError) {
        await this.fail(
          e.status === 415
            ? 'The server rejected the file contents.'
            : `The server refused the import (HTTP ${e.status}).`,
        );
      } else {
        // Unknown outcome: the job may exist. Ask by key; do not blindly resend.
        await this.setOp({ ...this.state.op!, outcome: 'unknown' });
        await this.recover(false);
      }
    } finally {
      this.set({ busy: false });
    }
  }

  private async fail(message: string) {
    await this.files.deleteCopy(this.state.op!.localPath);
    await this.setOp(null);
    this.set({ notice: message });
  }

  private async adopt(job: JobView) {
    const op = mergeStatus(this.state.op!, job);
    await this.files.deleteCopy(op.localPath);
    await this.setOp({ ...op, localPath: null });
  }

  /** GET by key; if not found and `resend`, retry the POST with the same key and bytes. */
  async recover(resend = true) {
    const op = this.state.op;
    if (!op || op.outcome === 'created') {
      return;
    }
    this.set({ busy: true });
    try {
      const job = await this.api.getByKey(op.key);
      if (job) {
        await this.adopt(job);
      } else if (resend && op.localPath) {
        await this.setOp({ ...op, outcome: 'sending' });
        await this.send();
      } else if (resend) {
        await this.setOp({
          ...op,
          error: 'The local copy is gone. Discard and pick the file again.',
        });
      }
    } catch {
      // still offline: stay in the unknown state
    } finally {
      this.set({ busy: false });
    }
  }

  async refresh() {
    const op = this.state.op;
    if (!op?.jobId) {
      return;
    }
    try {
      const job = await this.api.getJob(op.jobId);
      const next = mergeStatus(this.state.op!, job);
      if (next !== this.state.op) {
        await this.setOp(next);
      }
      if (this.state.notice === OFFLINE) {
        this.set({ notice: null });
      }
    } catch {
      this.set({ notice: OFFLINE });
    }
  }

  async remove() {
    let op = this.state.op;
    if (!op?.jobId) {
      return;
    }
    if (!op.deleteKey) {
      op = { ...op, deleteKey: this.makeKey() };
      await this.setOp(op);
    }
    this.set({ busy: true, notice: null });
    try {
      const job = await this.api.deleteJob(op.jobId!, op.deleteKey!);
      const merged = mergeStatus(
        { ...this.state.op!, deleteRequested: true },
        job,
      );
      await this.setOp({ ...merged, deleteRequested: true });
    } catch (e) {
      const why = e instanceof NetworkError ? 'no connection' : (e as HttpError).status;
      this.set({
        notice: `Delete failed (${why}). The server data is NOT confirmed deleted. Retry.`,
      });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Clears the finished (deleted) or abandoned operation. */
  async dismiss() {
    const op = this.state.op;
    if (!op) {
      return;
    }
    await this.files.deleteCopy(op.localPath);
    await this.setOp(null);
    this.set({ notice: null });
  }
}
