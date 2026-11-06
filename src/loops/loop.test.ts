import { describe, it, expect } from 'vitest';
import { StateStore, type NodeState } from '../state.js';
import { Loop } from './loop.js';

function store(): StateStore {
  const s: NodeState = {
    node: { id: 'me@laptop', user: 'me', host: 'laptop', folder: '/x', startedAt: '', port: 0, version: 't' },
    org: null, repo: null, preflight: null, leases: [], loops: {}, tasks: [], sources: [], fix: null, library: [], templates: [], owners: [], chat: { messages: [], busy: false }, log: [],
  };
  const st = new StateStore(s);
  st.log = () => {};
  return st;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Loop', () => {
  it('ticks on its interval and never overlaps', async () => {
    const st = store();
    let ticks = 0;
    const loop = new Loop('t', 30, async () => {
      ticks += 1;
      await sleep(20);
    }, st);
    loop.start();
    await sleep(140);
    loop.stop();
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(ticks).toBeLessThanOrEqual(3);
    expect(st.state.loops.t?.status).toBe('stopped');
  });

  it('holds off after a failed tick when the backoff says so', async () => {
    const st = store();
    let ticks = 0;
    const loop = new Loop('t', 20, async () => {
      ticks += 1;
      throw new Error('API rate limit exceeded for user ID 1');
    }, st, async (e) => (/rate limit/i.test(e.message) ? 300 : undefined));
    loop.start();
    await sleep(150);
    expect(ticks).toBe(1);
    expect(st.state.loops.t?.status).toBe('waiting');
    expect(st.state.loops.t?.lastError).toMatch(/waiting until/);
    loop.stop();
  });

  it('keeps the usual interval for other errors', async () => {
    const st = store();
    let ticks = 0;
    const loop = new Loop('t', 20, async () => {
      ticks += 1;
      throw new Error('boom');
    }, st, async () => undefined);
    loop.start();
    await sleep(110);
    loop.stop();
    expect(ticks).toBeGreaterThanOrEqual(3);
  });
});

describe('Loop overlap', () => {
  it('runOnce during a running tick does not start a second one, and the timer does not either', async () => {
    const st = store();
    let running = 0;
    let overlaps = 0;
    let ticks = 0;
    const loop = new Loop('t', 20, async () => {
      ticks += 1;
      running += 1;
      if (running > 1) overlaps += 1;
      await sleep(60);
      running -= 1;
    }, st);
    loop.start();
    await sleep(5);
    await loop.runOnce();
    await loop.runOnce();
    await sleep(150);
    loop.stop();
    expect(overlaps).toBe(0);
    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});
