import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../github/memory-store.js';
import { loadOrganization } from '../org/contract.js';
import { chatTools } from './chat-tools.js';
import type { Task } from '../github/task-store.js';

async function setup(): Promise<{ store: MemoryStore; filed: Task[]; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> }> {
  const { org } = await loadOrganization(fileURLToPath(new URL('../../examples/org', import.meta.url)));
  if (!org) throw new Error('example org does not load');
  const store = new MemoryStore();
  const filed: Task[] = [];
  const tools = chatTools({ store, org, node: 'me@laptop', log: () => {}, onFiled: (t) => filed.push(t) });
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = (await t.handler(args, {} as never)) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]?.text ?? '', isError: r.isError === true };
  };
  return { store, filed, call };
}

describe('chat tools', () => {
  it('files a task in Inbox and tells the Director', async () => {
    const { store, filed, call } = await setup();
    const r = await call('file_task', { title: 'Write a hello note', body: 'Create notes/hello.md with a greeting.' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Filed #1');
    const t = await store.get(1);
    expect(t?.status).toBe('Inbox');
    expect(t?.body).toContain('Filed from the chat by me@laptop');
    expect(filed.map((x) => x.number)).toEqual([1]);
  });

  it('lists open tasks, shows one in detail, and takes a note', async () => {
    const { store, call } = await setup();
    await store.create('Open one', 'x', 'Assigned', 'writer');
    await store.create('Finished one', 'y', 'Done');
    const open = JSON.parse((await call('list_tasks', {})).text) as Array<{ number: number }>;
    expect(open.map((t) => t.number)).toEqual([1]);
    const all = JSON.parse((await call('list_tasks', { all: true })).text) as Array<{ number: number }>;
    expect(all.map((t) => t.number)).toEqual([1, 2]);
    await call('comment_task', { number: 1, note: 'please hurry' });
    const detail = JSON.parse((await call('task_status', { number: 1 })).text) as { agent: string; comments: Array<{ body: string }> };
    expect(detail.agent).toBe('writer');
    expect(detail.comments[0]?.body).toContain('please hurry');
    expect((await call('task_status', { number: 9 })).isError).toBe(true);
  });

  it('knows the roster', async () => {
    const { call } = await setup();
    const roster = JSON.parse((await call('roster', {})).text) as Array<{ name: string; director: boolean }>;
    expect(roster.find((a) => a.name === 'director')?.director).toBe(true);
    expect(roster.some((a) => a.name === 'writer')).toBe(true);
  });
});
