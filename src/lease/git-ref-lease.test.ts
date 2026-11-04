import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ok } from '../util/exec.js';
import { GitRefLease, isExpired } from './git-ref-lease.js';

let root: string;
let a: GitRefLease;
let b: GitRefLease;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dashing-lease-'));
  const origin = path.join(root, 'origin.git');
  await ok('git', ['init', '-q', '--bare', origin]);
  await ok('git', ['clone', '-q', origin, path.join(root, 'a')]);
  await ok('git', ['clone', '-q', origin, path.join(root, 'b')]);
  a = new GitRefLease(path.join(root, 'a'));
  b = new GitRefLease(path.join(root, 'b'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('GitRefLease', () => {
  it('starts empty', async () => {
    expect(await a.read('director')).toBeNull();
    expect(await a.list()).toEqual([]);
  });

  it('lets one laptop take a free lease and refuses the other', async () => {
    const first = await a.acquire('director', 'alice@laptop-a', 60_000);
    expect(first.ok).toBe(true);
    const second = await b.acquire('director', 'bob@laptop-b', 60_000);
    expect(second.ok).toBe(false);
    expect(second.heldBy?.holder).toBe('alice@laptop-a');
    const seen = await b.read('director');
    expect(seen?.lease.holder).toBe('alice@laptop-a');
    expect(isExpired(seen!.lease)).toBe(false);
  });

  it('renews only for the holder', async () => {
    expect((await a.renew('director', 'alice@laptop-a', 60_000)).ok).toBe(true);
    const r = await b.renew('director', 'bob@laptop-b', 60_000);
    expect(r.ok).toBe(false);
    expect(r.heldBy?.holder).toBe('alice@laptop-a');
  });

  it('releases only for the holder', async () => {
    expect(await b.release('director', 'bob@laptop-b')).toBe(false);
    expect(await a.release('director', 'alice@laptop-a')).toBe(true);
    expect(await b.read('director')).toBeNull();
    const taken = await b.acquire('director', 'bob@laptop-b', 60_000);
    expect(taken.ok).toBe(true);
  });

  it('lets anyone take over an expired lease', async () => {
    const short = await b.acquire('task-7', 'bob@laptop-b', -1);
    expect(short.ok).toBe(true);
    expect(isExpired(short.lease!)).toBe(true);
    const takeover = await a.acquire('task-7', 'alice@laptop-a', 60_000);
    expect(takeover.ok).toBe(true);
    expect((await b.read('task-7'))?.lease.holder).toBe('alice@laptop-a');
  });

  it('rejects a stale compare-and-swap', async () => {
    // b believes it still holds task-7 from before the takeover and tries to renew.
    const r = await b.renew('task-7', 'bob@laptop-b', 60_000);
    expect(r.ok).toBe(false);
    expect(r.heldBy?.holder).toBe('alice@laptop-a');
  });

  it('lists every lease', async () => {
    const names = (await a.list()).map((l) => l.name).sort();
    expect(names).toEqual(['director', 'task-7']);
  });

  it('rejects bad names', () => {
    expect(() => a.ref('Bad Name')).toThrow();
  });
});
