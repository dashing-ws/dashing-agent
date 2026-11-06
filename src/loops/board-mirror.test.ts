import { describe, it, expect } from 'vitest';
import { StateStore, type NodeState } from '../state.js';
import { MemoryStore } from '../github/memory-store.js';
import { mirrorBoard } from './board-mirror.js';

function state(): StateStore {
  const s: NodeState = {
    node: { id: 'me@laptop', user: 'me', host: 'laptop', folder: '/x', startedAt: '', port: 0, version: 't' },
    org: null, repo: null, preflight: null, leases: [], loops: {}, tasks: [], sources: [], fix: null, library: [], templates: [], owners: [], chat: { messages: [], busy: false }, log: [],
  };
  const st = new StateStore(s);
  st.log = () => {};
  return st;
}

describe('mirrorBoard', () => {
  it('shows a filed task, its agent and each status at once', async () => {
    const st = state();
    const store = mirrorBoard(new MemoryStore(), st);
    const task = await store.create('Hello', 'say hi');
    expect(st.state.tasks).toEqual([{ number: 1, title: 'Hello', status: 'Inbox', url: 'memory://tasks/1' }]);
    await store.setAgent(task, 'sirius');
    await store.setStatus(task, 'Assigned');
    expect(st.state.tasks[0]).toMatchObject({ status: 'Assigned', agent: 'sirius' });
    await store.setStatus(task, 'Running');
    await store.setStatus(task, 'Done');
    expect(st.state.tasks).toHaveLength(1);
    expect(st.state.tasks[0]?.status).toBe('Done');
  });

  it('replaces the list with what the board says on a read', async () => {
    const st = state();
    const inner = new MemoryStore();
    const store = mirrorBoard(inner, st);
    await store.create('One', 'x');
    await inner.create('Two', 'y', 'Review', 'vega');
    expect(st.state.tasks).toHaveLength(1);
    const tasks = await store.list();
    expect(tasks).toHaveLength(2);
    expect(st.state.tasks.map((t) => [t.number, t.status, t.agent])).toEqual([[1, 'Inbox', undefined], [2, 'Review', 'vega']]);
  });
});
