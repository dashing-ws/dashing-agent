import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../github/memory-store.js';
import { loadOrganization, type Organization } from '../org/contract.js';
import { workerTools } from './ledger-tools.js';

let dir: string;
let org: Organization;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-ledger-'));
  await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fs.mkdir(path.join(dir, 'secret'), { recursive: true });
  await fs.writeFile(path.join(dir, 'notes', 'a.md'), 'a');
  await fs.writeFile(path.join(dir, 'secret', 'b.md'), 'b');
  const load = await loadOrganization(fileURLToPath(new URL('../../examples/org', import.meta.url)));
  if (!load.org) throw new Error('example org does not load');
  org = load.org;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('remove_file', () => {
  async function call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const store = new MemoryStore();
    const task = await store.create('t', 'x', 'Running', 'writer');
    const writer = org.agents.find((a) => a.name === 'writer')!;
    const tools = workerTools({ task, store, agent: writer, org, node: 'me@laptop', cwd: dir, log: () => {}, onFinal: () => {} });
    const t = tools.find((x) => x.name === 'remove_file')!;
    const r = (await t.handler(args, {} as never)) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]?.text ?? '', isError: r.isError === true };
  }

  it('deletes a file inside the write folders', async () => {
    const r = await call({ path: 'notes/a.md' });
    expect(r.isError).toBe(false);
    await expect(fs.stat(path.join(dir, 'notes', 'a.md'))).rejects.toThrow();
  });

  it('refuses a file outside them, and says why', async () => {
    const r = await call({ path: 'secret/b.md' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/you may write notes\//);
    await expect(fs.stat(path.join(dir, 'secret', 'b.md'))).resolves.toBeTruthy();
  });

  it('refuses what is not a file', async () => {
    expect((await call({ path: 'notes' })).isError).toBe(true);
    expect((await call({ path: 'notes/missing.md' })).isError).toBe(true);
    expect((await call({ path: '../outside.md' })).isError).toBe(true);
  });
});
