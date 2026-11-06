import { run } from '../util/exec.js';
import type { Comment, Task, TaskStore } from '../github/task-store.js';

/**
 * A task is Done when the pull requests its results name are merged. In the organization's own
 * repository the pull request closes the issue and the loop sees that. In a granted repository the
 * pull request only points at the task, so the loop watches it: the result comments name each
 * pull request, and `gh pr view` says when it is merged.
 */

const PR_RE = /pull request (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)/g;

/** The pull requests named in the harness's result comments that live outside `own` (owner/name). */
export function foreignPullRequests(comments: Comment[], own: string): string[] {
  const urls = new Set<string>();
  const ownPrefix = `https://github.com/${own.toLowerCase()}/pull/`;
  for (const c of comments) {
    for (const m of c.body.matchAll(PR_RE)) {
      const url = m[1]!;
      if (!url.toLowerCase().startsWith(ownPrefix)) urls.add(url);
    }
  }
  return [...urls];
}

export type PullRequestState = 'merged' | 'open' | 'closed' | 'unknown';

export class PullRequestWatch {
  /** The foreign pull requests of each task, from its comments; read once, added to by this laptop's runs. */
  private readonly known = new Map<number, string[]>();

  constructor(private readonly store: TaskStore, private readonly own: string, private readonly view: (url: string) => Promise<PullRequestState> = viewState) {}

  /** A run on this laptop opened or found this pull request on the task. */
  remember(task: number, url: string): void {
    if (url.toLowerCase().startsWith(`https://github.com/${this.own.toLowerCase()}/pull/`)) return;
    const list = this.known.get(task) ?? [];
    if (!list.includes(url)) list.push(url);
    this.known.set(task, list);
  }

  /** Forget a task's pull requests, so they are read again from its comments. */
  forget(task: number): void {
    this.known.delete(task);
  }

  /** The task's foreign pull requests, read from its comments the first time. */
  async urls(task: Task): Promise<string[]> {
    const cached = this.known.get(task.number);
    if (cached) return cached;
    const urls = foreignPullRequests(await this.store.comments(task), this.own);
    this.known.set(task.number, urls);
    return urls;
  }

  /**
   * 'merged' when the task names pull requests in other repositories and every one is merged;
   * 'none' when it names none; 'open' otherwise. Before saying merged it reads the comments
   * again, so a pull request added by another laptop is not missed.
   */
  async status(task: Task): Promise<'merged' | 'open' | 'none'> {
    let urls = await this.urls(task);
    if (!urls.length) return 'none';
    const states = await Promise.all(urls.map((u) => this.view(u)));
    if (!states.every((s) => s === 'merged')) return 'open';
    this.forget(task.number);
    urls = await this.urls(task);
    const again = await Promise.all(urls.map((u) => this.view(u)));
    return again.every((s) => s === 'merged') ? 'merged' : 'open';
  }
}

async function viewState(url: string): Promise<PullRequestState> {
  const r = await run('gh', ['pr', 'view', url, '--json', 'state', '--jq', '.state'], { timeoutMs: 30_000 });
  if (r.code !== 0) return 'unknown';
  const s = r.stdout.trim();
  return s === 'MERGED' ? 'merged' : s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : 'unknown';
}
