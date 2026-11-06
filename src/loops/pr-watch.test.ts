import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../github/memory-store.js';
import { PullRequestWatch, foreignPullRequests } from './pr-watch.js';

const own = 'strokine/dashing-crypto-agents';

describe('foreignPullRequests', () => {
  it('finds the pull requests the harness named, outside the organization repository', () => {
    const comments = [
      { author: 'x', at: '', body: '**Run finished.**\n\n**Changes:** commit 1 on branch `agentic-loop/task-5`, pull request https://github.com/strokine/dashing-crypto-agents/pull/6' },
      { author: 'x', at: '', body: '**Changes:** commit 2 on branch `agentic-loop/crew/task-5` of strokine/dashing-crypto-api, pull request https://github.com/strokine/dashing-crypto-api/pull/12' },
      { author: 'x', at: '', body: 'again: pull request https://github.com/strokine/dashing-crypto-api/pull/12' },
    ];
    expect(foreignPullRequests(comments, own)).toEqual(['https://github.com/strokine/dashing-crypto-api/pull/12']);
  });
});

describe('PullRequestWatch', () => {
  it('says none, open, then merged as the pull requests move', async () => {
    const store = new MemoryStore();
    const task = await store.create('t', 'b', 'Review');
    const states = new Map<string, 'merged' | 'open'>();
    const watch = new PullRequestWatch(store, own, async (url) => states.get(url) ?? 'open');
    expect(await watch.status(task)).toBe('none');
    await store.comment(task, 'pull request https://github.com/strokine/dashing-crypto-api/pull/12');
    watch.forget(task.number);
    expect(await watch.status(task)).toBe('open');
    states.set('https://github.com/strokine/dashing-crypto-api/pull/12', 'merged');
    expect(await watch.status(task)).toBe('merged');
  });

  it('reads the comments again before saying merged, so a second pull request is not missed', async () => {
    const store = new MemoryStore();
    const task = await store.create('t', 'b', 'Review');
    const states = new Map<string, 'merged' | 'open'>([['https://github.com/a/b/pull/1', 'merged']]);
    const watch = new PullRequestWatch(store, own, async (url) => states.get(url) ?? 'open');
    watch.remember(task.number, 'https://github.com/a/b/pull/1');
    await store.comment(task, 'pull request https://github.com/a/b/pull/2');
    expect(await watch.status(task)).toBe('open');
    states.set('https://github.com/a/b/pull/2', 'merged');
    expect(await watch.status(task)).toBe('merged');
  });

  it('never watches the organization repository itself', () => {
    const watch = new PullRequestWatch(new MemoryStore(), own, async () => 'open');
    watch.remember(1, 'https://github.com/strokine/dashing-crypto-agents/pull/6');
    expect(watch['known'].get(1)).toBeUndefined();
  });
});
