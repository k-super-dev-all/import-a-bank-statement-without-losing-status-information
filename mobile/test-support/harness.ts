import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApi, type Upload } from '../src/api';
import { ImportController, type Files, type Store } from '../src/controller';
import type { Op } from '../src/types';

export const ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURES = path.join(ROOT, 'fixtures');
export const PORT = 8799;
export const BASE = `http://127.0.0.1:${PORT}`;

export function request(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: Buffer | string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

export const fetchImpl = async (
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) => {
  const r = await request(init.method ?? 'GET', url, init.headers);
  return { status: r.status, text: async () => r.body };
};

/** Stand-in for the native streaming upload: same HTTP request, bytes from disk. */
export const nodeUpload: Upload = (url, headers, file) =>
  request('POST', url, headers, fs.readFileSync(file));

export const state = async () =>
  JSON.parse((await request('GET', `${BASE}/__test/state`)).body);
export const scenario = (mode: string) =>
  request('POST', `${BASE}/__test/scenario`, {}, JSON.stringify({ mode }));
export const reset = () => request('POST', `${BASE}/__test/reset`);

let server: ChildProcess;
export async function startMock() {
  server = spawn('node', ['mock-server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await request('GET', `${BASE}/health`);
      break;
    } catch {
      await new Promise<void>(r => setTimeout(r, 100));
    }
  }
  await reset();
}
export const stopMock = () => server?.kill();

export function memoryStore(): Store & { op: Op | null } {
  const s = {
    op: null as Op | null,
    async load() {
      return s.op ? JSON.parse(JSON.stringify(s.op)) : null;
    },
    async save(op: Op | null) {
      s.op = op ? JSON.parse(JSON.stringify(op)) : null;
    },
  };
  return s;
}

/** Fake file gateway that "picks" fixture files and tracks private temp copies. */
export function fixtureFiles(fixture: () => string) {
  const copies = new Set<string>();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const files: Files & { copies: Set<string> } = {
    copies,
    async pick() {
      const src = fixture();
      const size = fs.statSync(src).size;
      const dest = path.join(tmp, path.basename(src));
      fs.copyFileSync(src, dest);
      copies.add(dest);
      return { fileName: path.basename(src), size, localPath: dest };
    },
    async readHead(p) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(32);
      const n = fs.readSync(fd, buf, 0, 32, 0);
      fs.closeSync(fd);
      return new Uint8Array(buf.subarray(0, n));
    },
    async deleteCopy(p) {
      if (p) {
        copies.delete(p);
        fs.rmSync(p, { force: true });
      }
    },
  };
  return files;
}

export function makeController(files: Files, store: Store, keys: string[] = []) {
  let n = 0;
  return new ImportController(
    createApi(nodeUpload, fetchImpl, BASE),
    files,
    store,
    () => keys[n++] ?? `generated-key-${n}`,
  );
}
