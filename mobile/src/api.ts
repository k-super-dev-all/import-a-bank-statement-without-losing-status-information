import { BASE_URL } from './config';
import type { JobView } from './types';

export class NetworkError extends Error {}
export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

export type Upload = (
  url: string,
  headers: Record<string, string>,
  path: string,
) => Promise<{ status: number; body: string }>;

export type Api = {
  create(key: string, fileName: string, path: string): Promise<JobView>;
  getByKey(key: string): Promise<JobView | null>;
  getJob(jobId: string): Promise<JobView>;
  deleteJob(jobId: string, key: string): Promise<JobView>;
};

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

export function createApi(
  upload: Upload,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  base = BASE_URL,
): Api {
  const request = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ) => {
    try {
      const res = await fetchImpl(base + path, { method, headers });
      return { status: res.status, body: await res.text() };
    } catch {
      throw new NetworkError();
    }
  };
  const parse = (r: { status: number; body: string }): JobView => {
    if (r.status < 200 || r.status >= 300) {
      throw new HttpError(r.status);
    }
    return JSON.parse(r.body);
  };

  return {
    async create(key, fileName, path) {
      let r;
      try {
        r = await upload(
          `${base}/imports`,
          {
            'Content-Type': 'application/octet-stream',
            'Idempotency-Key': key,
            // header values must be latin1-safe
            'X-File-Name': encodeURIComponent(fileName).slice(0, 255),
          },
          path,
        );
      } catch {
        throw new NetworkError();
      }
      return parse(r);
    },
    async getByKey(key) {
      const r = await request('GET', `/imports/by-key/${encodeURIComponent(key)}`);
      return r.status === 404 ? null : parse(r);
    },
    async getJob(jobId) {
      return parse(await request('GET', `/imports/${jobId}`));
    },
    async deleteJob(jobId, key) {
      return parse(
        await request('DELETE', `/imports/${jobId}`, { 'Idempotency-Key': key }),
      );
    },
  };
}
