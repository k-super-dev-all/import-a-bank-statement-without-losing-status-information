import { MAX_BYTES } from './config';

export type FileFormat = 'pdf' | 'csv';

export const HEAD_BYTES = 32;

/** Content sniffing mirrors what the server accepts; extension and MIME are never consulted. */
export function detectFormat(head: Uint8Array): FileFormat | null {
  const text = (n: number) =>
    String.fromCharCode(...Array.from(head.subarray(0, n)));
  if (text(5) === '%PDF-') {
    return 'pdf';
  }
  if (text(24).replace(/\r/g, '').startsWith('date,description,amount\n')) {
    return 'csv';
  }
  return null;
}

export type Rejection = 'too_large' | 'empty' | 'not_pdf_or_csv';

export function rejectionMessage(r: Rejection): string {
  switch (r) {
    case 'too_large':
      return 'This file is larger than 10 MiB and was not sent.';
    case 'empty':
      return 'This file is empty and was not sent.';
    default:
      return 'The contents are not a PDF or a bank CSV, so it was not sent.';
  }
}

export function checkSize(size: number): Rejection | null {
  if (size > MAX_BYTES) {
    return 'too_large';
  }
  return size <= 0 ? 'empty' : null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of b64) {
    const v = chars.indexOf(c);
    if (v < 0) {
      continue;
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
