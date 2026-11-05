import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ok, run } from '../util/exec.js';
import { openWorkspace, closeWorkspace } from './workspace.js';

let root: string;
let org: string;
let work: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-ws-'));
  const origin = path.join(root, 'origin.git');
  await ok('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  org = path.join(root, 'org');
  await ok('git', ['clone', '-q', origin, org]);
  await fs.writeFile(path.join(org, 'agentic-loop.yaml'), 'name: t\n');
  await ok('git', ['add', '.'], { cwd: org, env });
  await ok('git', ['commit', '-q', '-m', 'init'], { cwd: org, env });
  await ok('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: org });
  await ok('git', ['config', 'user.name', 't'], { cwd: org });
  await ok('git', ['config', 'user.email', 't@x'], { cwd: org });
  work = path.join(root, 'work');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('workspace', () => {
  it('opens a worktree on the task branch, pushes what changed, and removes the worktree', async () => {
    const ws = await openWorkspace(org, work, 7);
    expect(ws.branch).toBe('agentic-loop/task-7');
    expect(ws.base).toBe('main');
    expect((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.dir })).stdout.trim()).toBe('agentic-loop/task-7');
    await fs.writeFile(path.join(ws.dir, 'notes.md'), 'hello\n');
    const closed = await closeWorkspace(org, ws, { title: 'write notes', agent: 'writer', holder: 'me@laptop', pullRequest: false });
    expect(closed.error).toBeUndefined();
    expect(closed.changed).toBe(true);
    expect(closed.pushed).toBe(true);
    const remote = await run('git', ['ls-remote', '--heads', 'origin', 'agentic-loop/task-7'], { cwd: org });
    expect(remote.stdout).toContain('refs/heads/agentic-loop/task-7');
    await expect(fs.stat(ws.dir)).rejects.toThrow();
    const main = await run('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: org });
    const head = await run('git', ['rev-parse', 'origin/main'], { cwd: org });
    expect(main.stdout.split('\t')[0]).toBe(head.stdout.trim());
  });

  it('continues from the pushed branch next time and pushes nothing when nothing changed', async () => {
    const ws = await openWorkspace(org, work, 7);
    expect(await fs.readFile(path.join(ws.dir, 'notes.md'), 'utf8')).toBe('hello\n');
    const closed = await closeWorkspace(org, ws, { title: 'write notes', agent: 'writer', holder: 'me@laptop', pullRequest: false });
    expect(closed.changed).toBe(false);
    expect(closed.pushed).toBe(false);
    expect(closed.error).toBeUndefined();
  });

  it('leaves the organization clone on its own branch', async () => {
    expect((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: org })).stdout.trim()).toBe('main');
    expect((await run('git', ['status', '--porcelain'], { cwd: org })).stdout.trim()).toBe('');
  });
});
