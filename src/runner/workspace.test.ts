import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ok, run } from '../util/exec.js';
import { openWorkspace, openRepoWorkspace, closeWorkspace, branchFor } from './workspace.js';

let root: string;
let org: string;
let work: string;
let serviceOrigin: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

/** A bare repository with one commit on main and a clone of it at `clone`. */
async function makeRepo(bare: string, clone: string, file: string): Promise<void> {
  await ok('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  await ok('git', ['clone', '-q', bare, clone]);
  await fs.writeFile(path.join(clone, file), 'first\n');
  await ok('git', ['add', '.'], { cwd: clone, env });
  await ok('git', ['commit', '-q', '-m', 'init'], { cwd: clone, env });
  await ok('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: clone });
  await ok('git', ['config', 'user.name', 't'], { cwd: clone });
  await ok('git', ['config', 'user.email', 't@x'], { cwd: clone });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-ws-'));
  org = path.join(root, 'org');
  await makeRepo(path.join(root, 'origin.git'), org, 'agentic-loop.yaml');
  serviceOrigin = path.join(root, 'service.git');
  await makeRepo(serviceOrigin, path.join(root, 'service-seed'), 'pom.xml');
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
    expect(ws.cloneDir).toBe(org);
    expect((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.dir })).stdout.trim()).toBe('agentic-loop/task-7');
    await fs.writeFile(path.join(ws.dir, 'notes.md'), 'hello\n');
    const closed = await closeWorkspace(ws, { title: 'write notes', agent: 'writer', holder: 'me@laptop', pullRequest: false });
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
    expect(ws.note).toBeUndefined();
    const closed = await closeWorkspace(ws, { title: 'write notes', agent: 'writer', holder: 'me@laptop', pullRequest: false });
    expect(closed.changed).toBe(false);
    expect(closed.pushed).toBe(false);
    expect(closed.error).toBeUndefined();
  });

  it('merges what reached main since the last run into the task branch', async () => {
    await fs.writeFile(path.join(org, 'context.md'), 'granted\n');
    await ok('git', ['add', '.'], { cwd: org, env });
    await ok('git', ['commit', '-q', '-m', 'a grant'], { cwd: org, env });
    await ok('git', ['push', '-q'], { cwd: org });
    const ws = await openWorkspace(org, work, 7);
    expect(await fs.readFile(path.join(ws.dir, 'context.md'), 'utf8')).toBe('granted\n');
    expect(await fs.readFile(path.join(ws.dir, 'notes.md'), 'utf8')).toBe('hello\n');
    expect(ws.note).toBeUndefined();
    const closed = await closeWorkspace(ws, { title: 'write notes', agent: 'writer', holder: 'me@laptop', pullRequest: false });
    expect(closed.error).toBeUndefined();
    expect(closed.pushed).toBe(true);
  });

  it('leaves the organization clone on its own branch', async () => {
    expect((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: org })).stdout.trim()).toBe('main');
    expect((await run('git', ['status', '--porcelain'], { cwd: org })).stdout.trim()).toBe('');
  });

  it('clones a granted repository once and works in it on a branch named for the organization', async () => {
    const reposRoot = path.join(root, 'repos');
    const o = { repo: 'acme/service', reposRoot, workRoot: work, orgName: 'crew', task: 7, cloneUrl: serviceOrigin };
    const ws = await openRepoWorkspace(o);
    expect(ws.branch).toBe(branchFor(7, 'crew'));
    expect(ws.branch).toBe('agentic-loop/crew/task-7');
    expect(ws.repo).toBe('acme/service');
    expect(ws.cloneDir).toBe(path.join(reposRoot, 'acme', 'service'));
    expect(ws.dir).toBe(path.join(work, 'task-7-service'));
    expect(await fs.readFile(path.join(ws.dir, 'pom.xml'), 'utf8')).toBe('first\n');
    await ok('git', ['config', 'user.name', 't'], { cwd: ws.cloneDir });
    await ok('git', ['config', 'user.email', 't@x'], { cwd: ws.cloneDir });
    await fs.writeFile(path.join(ws.dir, 'pom.xml'), 'upgraded\n');
    const closed = await closeWorkspace(ws, { title: 'upgrade', agent: 'alnilam', holder: 'me@laptop', pullRequest: false, taskUrl: 'https://example/7' });
    expect(closed.error).toBeUndefined();
    expect(closed.pushed).toBe(true);
    const remote = await run('git', ['ls-remote', '--heads', serviceOrigin, 'agentic-loop/crew/task-7']);
    expect(remote.stdout).toContain('refs/heads/agentic-loop/crew/task-7');
    const main = await run('git', ['ls-remote', serviceOrigin, 'refs/heads/main']);
    const seed = await run('git', ['rev-parse', 'origin/main'], { cwd: ws.cloneDir });
    expect(main.stdout.split('\t')[0]).toBe(seed.stdout.trim());
    const again = await openRepoWorkspace(o);
    expect(await fs.readFile(path.join(again.dir, 'pom.xml'), 'utf8')).toBe('upgraded\n');
    await closeWorkspace(again, { title: 'upgrade', agent: 'alnilam', holder: 'me@laptop', pullRequest: false });
  });
});
