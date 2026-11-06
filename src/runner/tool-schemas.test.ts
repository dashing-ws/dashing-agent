import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MemoryStore } from '../github/memory-store.js';
import { loadOrganization } from '../org/contract.js';
import { workerTools, directorTools } from './ledger-tools.js';
import { chatTools } from './chat-tools.js';

/**
 * The zod inside Agent SDK 0.3.284 and older cannot convert a record made by zod 4.6 to JSON schema,
 * and one tool it cannot convert hides every tool of the in-process server from the agent. The
 * laptops that cannot move past that SDK run the same tool schemas as everyone else, so no tool
 * schema may contain a record.
 */
function zodTypes(node: unknown, out: Set<string>, seen = new Set<unknown>()): Set<string> {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (def) {
    if (typeof def.type === 'string') out.add(def.type);
    for (const v of Object.values(def)) zodTypes(v, out, seen);
    return out;
  }
  for (const v of Array.isArray(node) ? node : Object.values(node as object)) zodTypes(v, out, seen);
  return out;
}

describe('tool schemas', () => {
  it('the walker sees a record when there is one', () => {
    expect(zodTypes({ a: z.array(z.object({ b: z.record(z.string(), z.unknown()) })) }, new Set())).toContain('record');
  });

  it('no worker, Director or chat tool uses a record', async () => {
    const { org } = await loadOrganization(fileURLToPath(new URL('../../examples/org', import.meta.url)));
    if (!org) throw new Error('example org does not load');
    const store = new MemoryStore();
    const task = await store.create('t', 'x', 'Running', 'writer');
    const writer = org.agents.find((a) => a.name === 'writer')!;
    const tools = [
      ...workerTools({ task, store, agent: writer, org, node: 'me@laptop', cwd: '/tmp', log: () => {}, onFinal: () => {} }),
      ...directorTools({ inbox: [task], store, org, node: 'me@laptop', log: () => {} }),
      ...chatTools({ store, org, node: 'me@laptop', log: () => {} }),
    ];
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) expect([...zodTypes(t.inputSchema, new Set())], t.name).not.toContain('record');
  });
});
