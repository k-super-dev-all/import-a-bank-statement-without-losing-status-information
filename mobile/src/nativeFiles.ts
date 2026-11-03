import ReactNativeBlobUtil from 'react-native-blob-util';
import {
  keepLocalCopy,
  pick,
  types,
  isErrorWithCode,
  errorCodes,
  releaseSecureAccess,
} from '@react-native-documents/picker';
import type { Upload } from './api';
import { base64ToBytes, HEAD_BYTES } from './validation';
import type { Op } from './types';

const fs = ReactNativeBlobUtil.fs;
const strip = (p: string) => p.replace(/^file:\/\//, '');

export type Picked = {
  fileName: string;
  size: number | null;
  /** Private temp copy (null when rejected before copying). */
  localPath: string | null;
};

/** Returns null when the user cancels the picker. */
export async function pickFile(maxBytes: number): Promise<Picked | null> {
  let res;
  try {
    [res] = await pick({
      mode: 'open',
      type: [types.pdf, types.csv, 'application/octet-stream', 'text/plain'],
    });
  } catch (e) {
    if (
      isErrorWithCode(e) &&
      (e.code === errorCodes.IN_PROGRESS || e.code === errorCodes.OPERATION_CANCELED)
    ) {
      return null;
    }
    throw e;
  }
  try {
    const fileName = res.name ?? 'statement';
    // Size is known up-front on most providers: refuse before copying a huge file.
    if (res.size != null && res.size > maxBytes) {
      return { fileName, size: res.size, localPath: null };
    }
    const [copy] = await keepLocalCopy({
      files: [{ uri: res.uri, fileName }],
      destination: 'cachesDirectory',
    });
    if (copy.status !== 'success') {
      throw new Error('copy failed');
    }
    const localPath = strip(copy.localUri);
    const size = Number((await fs.stat(localPath)).size);
    return { fileName, size, localPath };
  } finally {
    // iOS security-scoped access is only needed until the private copy exists
    await releaseSecureAccess([res.uri]).catch(() => {});
  }
}

/** Reads only the first bytes via a 32-byte slice, never the whole file. */
export async function readHead(path: string): Promise<Uint8Array> {
  const headPath = `${path}.head`;
  try {
    await fs.slice(path, headPath, 0, HEAD_BYTES);
    return base64ToBytes(await fs.readFile(headPath, 'base64'));
  } finally {
    await fs.unlink(headPath).catch(() => {});
  }
}

export async function deleteCopy(path: string | null): Promise<void> {
  if (!path) {
    return;
  }
  try {
    await fs.unlink(path);
    // the picker puts each copy in its own uuid directory
    await fs.unlink(path.replace(/\/[^/]+$/, ''));
  } catch {}
}

/** Streams the file from disk; the body is not loaded into JS memory. */
export const upload: Upload = async (url, headers, path) => {
  const res = await ReactNativeBlobUtil.fetch(
    'POST',
    url,
    headers,
    ReactNativeBlobUtil.wrap(path),
  );
  return { status: res.info().status, body: await res.text() };
};

const OP_FILE = `${fs.dirs.DocumentDir}/import-op.json`;

export const opStore = {
  async load(): Promise<Op | null> {
    try {
      return JSON.parse(await fs.readFile(OP_FILE, 'utf8'));
    } catch {
      return null;
    }
  },
  async save(op: Op | null): Promise<void> {
    if (op === null) {
      await fs.unlink(OP_FILE).catch(() => {});
    } else {
      await fs.writeFile(OP_FILE, JSON.stringify(op), 'utf8');
    }
  },
};
