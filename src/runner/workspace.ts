import fs from 'node:fs/promises';
import path from 'node:path';
import { run, ok } from '../util/exec.js';

/**
 * Where an agent works: a git worktree of the organization's clone on a branch of its own,
 * `dashing/task-<n>`. The agent reads and edits files there. When the run ends the harness,
 * never the agent, commits what changed, pushes the branch and opens a pull request on the
 * task. The default branch is never pushed to from a run.
 */

export interface Workspace {
  dir: string;
  branch: string;
  base: string;
  task: number;
}

export interface CloseOptions {
  title: string;
  agent: string;
  holder: string;
  /** Open (or find) a pull request on GitHub after pushing. Off in tests against a bare repo. */
  pullRequest: boolean;
}

export interface CloseResult {
  changed: boolean;
  commit?: string;
  pushed: boolean;
  prUrl?: string;
  error?: string;
}

const BRANCH_PREFIX = 'dashing/task-';

export function branchFor(task: number): string {
  return `${BRANCH_PREFIX}${task}`;
}

async function defaultBranch(orgDir: string): Promise<string> {
  const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: orgDir });
  if (head.code === 0) return head.stdout.trim().replace(/^origin\//, '');
  const remote = await run('git', ['remote', 'show', 'origin'], { cwd: orgDir, timeoutMs: 30_000 });
  const m = /HEAD branch: (\S+)/.exec(remote.stdout);
  if (m?.[1] && m[1] !== '(unknown)') return m[1];
  const current = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: orgDir });
  return current.stdout.trim() || 'main';
}

/** Makes the worktree for a task. A leftover worktree from an earlier run is replaced; the branch is kept. */
export async function openWorkspace(orgDir: string, root: string, task: number): Promise<Workspace> {
  const branch = branchFor(task);
  const dir = path.join(root, `task-${task}`);
  await fs.mkdir(root, { recursive: true });
  await run('git', ['worktree', 'remove', '--force', dir], { cwd: orgDir });
  await run('git', ['worktree', 'prune'], { cwd: orgDir });
  await fs.rm(dir, { recursive: true, force: true });
  await ok('git', ['fetch', '-q', 'origin'], { cwd: orgDir, timeoutMs: 120_000 });
  const base = await defaultBranch(orgDir);
  if (branch === base) throw new Error(`refusing to work on the default branch ${base}`);
  const existing = await run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { cwd: orgDir });
  const start = existing.code === 0 ? `origin/${branch}` : `origin/${base}`;
  await ok('git', ['worktree', 'add', '-q', '-B', branch, dir, start], { cwd: orgDir });
  return { dir, branch, base, task };
}

/** Commits what the run changed, pushes the branch, opens the pull request, removes the worktree. */
export async function closeWorkspace(orgDir: string, ws: Workspace, opts: CloseOptions): Promise<CloseResult> {
  const result: CloseResult = { changed: false, pushed: false };
  try {
    await ok('git', ['add', '-A'], { cwd: ws.dir });
    const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: ws.dir });
    result.changed = staged.code !== 0;
    if (result.changed) {
      const message = `task #${ws.task}: ${opts.title}\n\nBy ${opts.agent} on ${opts.holder} through dashing-agent.`;
      await ok('git', ['commit', '-q', '-m', message], { cwd: ws.dir });
      result.commit = (await ok('git', ['rev-parse', '--short', 'HEAD'], { cwd: ws.dir })).trim();
    }
    const ahead = Number((await ok('git', ['rev-list', '--count', `origin/${ws.base}..HEAD`], { cwd: ws.dir })).trim());
    const onRemote = await run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${ws.branch}`], { cwd: ws.dir });
    const remoteSha = onRemote.code === 0 ? onRemote.stdout.trim() : '';
    const localSha = (await ok('git', ['rev-parse', 'HEAD'], { cwd: ws.dir })).trim();
    if (ahead > 0 && remoteSha !== localSha) {
      await ok('git', ['push', '-q', '-u', `--force-with-lease=refs/heads/${ws.branch}:${remoteSha}`, 'origin', `HEAD:refs/heads/${ws.branch}`], { cwd: ws.dir, timeoutMs: 120_000 });
      result.pushed = true;
    }
    if (ahead > 0 && opts.pullRequest) {
      const open = await run('gh', ['pr', 'list', '--head', ws.branch, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd: ws.dir });
      const found = open.code === 0 ? (JSON.parse(open.stdout || '[]') as { url: string }[])[0] : undefined;
      if (found) {
        result.prUrl = found.url;
      } else {
        const body = `Closes #${ws.task}.\n\nOpened by dashing-agent for ${opts.agent} on ${opts.holder}. Review the diff on the task before merging.`;
        const created = await run('gh', ['pr', 'create', '--head', ws.branch, '--base', ws.base, '--title', `task #${ws.task}: ${opts.title}`.slice(0, 200), '--body', body], { cwd: ws.dir, timeoutMs: 60_000 });
        if (created.code === 0) result.prUrl = created.stdout.trim().split('\n').pop();
        else result.error = `pull request: ${created.stderr.trim().split('\n')[0]}`;
      }
    }
  } catch (e) {
    result.error = (e as Error).message.split('\n')[0];
  } finally {
    await run('git', ['worktree', 'remove', '--force', ws.dir], { cwd: orgDir });
    await run('git', ['worktree', 'prune'], { cwd: orgDir });
  }
  return result;
}
