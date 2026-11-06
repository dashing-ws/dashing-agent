import fs from 'node:fs/promises';
import path from 'node:path';
import { run, ok } from '../util/exec.js';

/**
 * Where an agent works: a git worktree of a clone on a branch of its own. The organization's
 * clone gives the branch `agentic-loop/task-<n>`; a granted repository is cloned under the
 * repos root and gives `agentic-loop/<organization>/task-<n>`, so two organizations on one
 * repository never collide. The agent reads and edits files there. When the run ends the
 * harness, never the agent, commits what changed, pushes the branch and opens a pull request:
 * one that closes the task in the organization's repository, one that references it in a
 * granted one. No default branch is ever pushed to from a run.
 */

export interface Workspace {
  dir: string;
  branch: string;
  base: string;
  task: number;
  /** The clone the worktree belongs to: the organization's, or a granted repository's under the repos root. */
  cloneDir: string;
  /** owner/name when this is a granted repository's checkout. */
  repo?: string;
  /** What happened when the default branch was merged into an existing task branch; empty when nothing to say. */
  note?: string;
}

export interface CloseOptions {
  title: string;
  agent: string;
  holder: string;
  /** Open (or find) a pull request on GitHub after pushing. Off in tests against a bare repo. */
  pullRequest: boolean;
  /** The task's URL in the organization, for a pull request in a granted repository to point back at. */
  taskUrl?: string;
}

export interface CloseResult {
  changed: boolean;
  commit?: string;
  pushed: boolean;
  prUrl?: string;
  error?: string;
}

const BRANCH_PREFIX = 'agentic-loop/';

/** The task branch: `agentic-loop/task-<n>` at home, `agentic-loop/<organization>/task-<n>` in a granted repository. */
export function branchFor(task: number, orgName?: string): string {
  return orgName ? `${BRANCH_PREFIX}${orgName}/task-${task}` : `${BRANCH_PREFIX}task-${task}`;
}

export async function defaultBranch(cloneDir: string): Promise<string> {
  const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: cloneDir });
  if (head.code === 0) return head.stdout.trim().replace(/^origin\//, '');
  const remote = await run('git', ['remote', 'show', 'origin'], { cwd: cloneDir, timeoutMs: 30_000 });
  const m = /HEAD branch: (\S+)/.exec(remote.stdout);
  if (m?.[1] && m[1] !== '(unknown)') return m[1];
  const current = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cloneDir });
  return current.stdout.trim() || 'main';
}

/**
 * Makes a worktree on the task branch. A leftover worktree from an earlier run is replaced; the
 * branch is kept and the default branch merged into it, so what reached main since the last run
 * (a grant, a merged file) is visible. A merge that conflicts is abandoned and noted.
 */
async function openIn(cloneDir: string, dir: string, branch: string, task: number, repo?: string): Promise<Workspace> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await run('git', ['worktree', 'remove', '--force', dir], { cwd: cloneDir });
  await run('git', ['worktree', 'prune'], { cwd: cloneDir });
  await fs.rm(dir, { recursive: true, force: true });
  await ok('git', ['fetch', '-q', 'origin'], { cwd: cloneDir, timeoutMs: 120_000 });
  const base = await defaultBranch(cloneDir);
  if (branch === base) throw new Error(`refusing to work on the default branch ${base}`);
  const existing = await run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { cwd: cloneDir });
  const start = existing.code === 0 ? `origin/${branch}` : `origin/${base}`;
  await ok('git', ['worktree', 'add', '-q', '-B', branch, dir, start], { cwd: cloneDir });
  const ws: Workspace = { dir, branch, base, task, cloneDir, ...(repo ? { repo } : {}) };
  if (existing.code === 0) {
    const merge = await run('git', ['merge', '-q', '--no-edit', `origin/${base}`], { cwd: dir });
    if (merge.code !== 0) {
      await run('git', ['merge', '--abort'], { cwd: dir });
      ws.note = `${base} could not be merged into ${branch} (conflicts); the branch is as the last run left it`;
    }
  }
  return ws;
}

/** The organization's own checkout for a task. */
export async function openWorkspace(orgDir: string, root: string, task: number): Promise<Workspace> {
  return openIn(orgDir, path.join(root, `task-${task}`), branchFor(task), task);
}

export interface RepoWorkspaceOptions {
  /** owner/name of the granted repository. */
  repo: string;
  /** Where clones of granted repositories live; the clone goes under <reposRoot>/<owner>/<name>. */
  reposRoot: string;
  /** Where worktrees go; the worktree is <workRoot>/task-<n>-<name>. */
  workRoot: string;
  orgName: string;
  task: number;
  /** What to clone from. Default: GitHub through gh. Tests give a local bare repository. */
  cloneUrl?: string;
}

/** A granted repository's checkout for a task: cloned once under the repos root, then a worktree per task. */
export async function openRepoWorkspace(o: RepoWorkspaceOptions): Promise<Workspace> {
  const [owner, name] = o.repo.split('/');
  if (!owner || !name) throw new Error(`"${o.repo}" is not owner/name`);
  const cloneDir = path.join(o.reposRoot, owner, name);
  const there = await run('git', ['rev-parse', '--git-dir'], { cwd: cloneDir });
  if (there.code !== 0) {
    await fs.rm(cloneDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(cloneDir), { recursive: true });
    if (o.cloneUrl) await ok('git', ['clone', '-q', o.cloneUrl, cloneDir], { timeoutMs: 600_000 });
    else await ok('gh', ['repo', 'clone', o.repo, cloneDir, '--', '-q'], { timeoutMs: 600_000 });
  }
  return openIn(cloneDir, path.join(o.workRoot, `task-${o.task}-${name}`), branchFor(o.task, o.orgName), o.task, o.repo);
}

/** Commits what the run changed, pushes the branch, opens the pull request, removes the worktree. */
export async function closeWorkspace(ws: Workspace, opts: CloseOptions): Promise<CloseResult> {
  const result: CloseResult = { changed: false, pushed: false };
  try {
    await ok('git', ['add', '-A'], { cwd: ws.dir });
    const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: ws.dir });
    result.changed = staged.code !== 0;
    if (result.changed) {
      const message = `task #${ws.task}: ${opts.title}\n\nBy ${opts.agent} on ${opts.holder} through Agentic Loop.`;
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
        const body = ws.repo
          ? `For task #${ws.task} of the organization${opts.taskUrl ? `: ${opts.taskUrl}` : ''}.\n\nOpened by Agentic Loop for ${opts.agent} on ${opts.holder}. Review the diff on the task before merging.`
          : `Closes #${ws.task}.\n\nOpened by Agentic Loop for ${opts.agent} on ${opts.holder}. Review the diff on the task before merging.`;
        const created = await run('gh', ['pr', 'create', '--head', ws.branch, '--base', ws.base, '--title', `task #${ws.task}: ${opts.title}`.slice(0, 200), '--body', body], { cwd: ws.dir, timeoutMs: 60_000 });
        if (created.code === 0) result.prUrl = created.stdout.trim().split('\n').pop();
        else result.error = `pull request: ${created.stderr.trim().split('\n')[0]}`;
      }
    }
  } catch (e) {
    result.error = (e as Error).message.split('\n')[0];
  } finally {
    await run('git', ['worktree', 'remove', '--force', ws.dir], { cwd: ws.cloneDir });
    await run('git', ['worktree', 'prune'], { cwd: ws.cloneDir });
  }
  return result;
}
