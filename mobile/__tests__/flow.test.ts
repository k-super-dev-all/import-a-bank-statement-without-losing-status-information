/**
 * @jest-environment node
 */
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import {
  FIXTURES,
  ROOT,
  fixtureFiles,
  makeController,
  memoryStore,
  reset,
  scenario,
  startMock,
  state,
  stopMock,
} from '../test-support/harness';
import { mergeStatus } from '../src/merge';
import { detectFormat } from '../src/validation';
import type { Op } from '../src/types';

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

beforeAll(startMock);
afterAll(stopMock);
beforeEach(async () => {
  await reset();
  await scenario('happy');
});

async function importFixture(name: string, keys: string[]) {
  const store = memoryStore();
  const files = fixtureFiles(() => path.join(FIXTURES, name));
  const c = makeController(files, store, keys);
  await c.choose();
  return { c, files, store };
}

test('happy: real bytes sent, 202 is not ready, ready shows mock data; copy removed', async () => {
  const { c, files, store } = await importFixture('statement.csv', [
    'key-happy-0001',
  ]);
  expect(c.state.candidate?.format).toBe('csv');
  await c.confirm();
  expect(c.state.op?.status).toBe('queued');
  expect(c.state.op?.items).toBeUndefined();
  expect(store.op?.key).toBe('key-happy-0001');
  expect(files.copies.size).toBe(0);
  while (c.state.op?.status !== 'ready') {
    await wait(300);
    await c.refresh();
  }
  const items = c.state.op!.items!;
  expect(items.length).toBe(2);
  expect(items.reduce((s, i) => s + i.amountMinor, 0)).toBe(15199);
  const s = await state();
  expect(s.stats.newJobs).toBe(1);
  expect(s.jobs[0].bytes).toBe(
    fs.statSync(path.join(FIXTURES, 'statement.csv')).size,
  );
});

test('PDF fixture accepted too', async () => {
  const { c } = await importFixture('statement.pdf', ['key-pdf-00001']);
  expect(c.state.candidate?.format).toBe('pdf');
});

test('key is persisted before the POST is sent', async () => {
  const store = memoryStore();
  const files = fixtureFiles(() => path.join(FIXTURES, 'statement.csv'));
  const saved: (string | undefined)[] = [];
  const origSave = store.save.bind(store);
  store.save = async op => {
    await origSave(op);
    saved.push(op?.key);
  };
  const c = makeController(files, store, ['key-persist-01']);
  await c.choose();
  expect((await state()).stats.createRequests).toBe(0);
  let requestsWhenFirstSaved = -1;
  const saveAgain = store.save;
  store.save = async op => {
    if (requestsWhenFirstSaved < 0) {
      requestsWhenFirstSaved = (await state()).stats.createRequests;
    }
    await saveAgain(op);
  };
  await c.confirm();
  expect(requestsWhenFirstSaved).toBe(0);
  expect(saved[0]).toBe('key-persist-01');
});

test('lost_ack: one job, found by key, relaunch does not resend', async () => {
  await scenario('lost_ack');
  const { c, store } = await importFixture('statement.csv', ['key-lostack-01']);
  await c.confirm();
  expect(c.state.op?.outcome).toBe('created');
  expect(c.state.op?.jobId).toMatch(/^job-demo-/);
  let s = await state();
  expect(s.stats.newJobs).toBe(1);
  expect(s.stats.createRequests).toBe(1);

  const c2 = makeController(fixtureFiles(() => ''), store);
  await c2.init();
  expect(c2.state.op?.jobId).toBe(c.state.op?.jobId);
  s = await state();
  expect(s.stats.createRequests).toBe(1);
  expect(s.stats.newJobs).toBe(1);
});

test('relaunch while sending: recovers by key, never auto-POSTs; user retry reuses key', async () => {
  const store = memoryStore();
  const files = fixtureFiles(() => path.join(FIXTURES, 'statement.csv'));
  const c = makeController(files, store, ['key-relaunch-01']);
  await c.choose();
  await store.save({
    key: 'key-relaunch-01',
    fileName: 'statement.csv',
    format: 'csv',
    size: 10,
    localPath: c.state.candidate!.localPath,
    outcome: 'sending',
    revision: 0,
    deleteRequested: false,
  });
  const c2 = makeController(files, store);
  await c2.init();
  expect(c2.state.op?.outcome).toBe('unknown');
  expect((await state()).stats.createRequests).toBe(0);
  await c2.recover(true);
  const s = await state();
  expect(s.stats.newJobs).toBe(1);
  expect(s.stats.createRequests).toBe(1);
  expect(c2.state.op?.outcome).toBe('created');
});

test('stale_status: processing/rev 2 after ready/rev 3 does not roll back', async () => {
  await scenario('stale_status');
  const { c } = await importFixture('statement.csv', ['key-stale-0001']);
  await c.confirm();
  await wait(1100);
  await c.refresh();
  expect(c.state.op?.status).toBe('ready');
  await c.refresh();
  expect(c.state.op?.status).toBe('ready');
  expect(c.state.op?.revision).toBe(3);
  expect(c.state.op?.items?.length).toBe(2);
});

test('mergeStatus: stale ignored; late ready cannot resurrect a deleting/deleted job', () => {
  const base: Op = {
    key: 'k',
    fileName: 'f',
    format: 'csv',
    size: 1,
    localPath: null,
    outcome: 'created',
    jobId: 'j',
    status: 'ready',
    revision: 3,
    deleteRequested: false,
  };
  expect(mergeStatus(base, { jobId: 'j', status: 'processing', revision: 2 })).toBe(base);
  const del: Op = { ...base, status: 'deleting', revision: 4, deleteRequested: true };
  expect(mergeStatus(del, { jobId: 'j', status: 'ready', revision: 3 })).toBe(del);
  expect(mergeStatus(del, { jobId: 'j', status: 'ready', revision: 9 })).toBe(del);
  const gone: Op = { ...del, status: 'deleted', revision: 5 };
  expect(mergeStatus(gone, { jobId: 'j', status: 'ready', revision: 9 })).toBe(gone);
});

test('delete_failure: 503 never claims deletion; retry with same key reaches deleted', async () => {
  const { c } = await importFixture('statement.csv', [
    'key-del-000001',
    'delete-key-0001',
  ]);
  await c.confirm();
  await wait(1100);
  await c.refresh();
  await scenario('delete_failure');
  await c.remove();
  expect(c.state.notice).toMatch(/NOT confirmed/);
  expect(c.state.op?.status).toBe('ready');
  const key = c.state.op?.deleteKey;
  await scenario('happy');
  await c.remove();
  expect(c.state.op?.deleteKey).toBe(key);
  expect(c.state.op?.status).toBe('deleting');
  await wait(1100);
  await c.refresh();
  expect(c.state.op?.status).toBe('deleted');
  expect((await state()).stats.deleteRequests).toBe(2);
});

test('spoofed.pdf and oversize.csv are rejected before any POST', async () => {
  const over = path.join(FIXTURES, 'oversize.csv');
  if (!fs.existsSync(over)) {
    execSync('node make-oversize.mjs', { cwd: ROOT });
  }
  const before = (await state()).stats.createRequests;
  for (const name of ['spoofed.pdf', 'oversize.csv']) {
    const { c, files } = await importFixture(name, ['key-reject-0001']);
    expect(c.state.candidate).toBeNull();
    expect(c.state.notice).toBeTruthy();
    expect(files.copies.size).toBe(0);
    await c.confirm();
  }
  expect((await state()).stats.createRequests).toBe(before);
});

test('content sniffing ignores names', () => {
  const t = (s: string) => new Uint8Array(Buffer.from(s));
  expect(detectFormat(t('%PDF-1.4'))).toBe('pdf');
  expect(detectFormat(t('date,description,amount\n1'))).toBe('csv');
  expect(detectFormat(t('this is not a pdf'))).toBeNull();
});
