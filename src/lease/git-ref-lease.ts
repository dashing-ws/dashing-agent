import { run, ok } from '../util/exec.js';

/**
 * A lease is a git ref on the shared remote that points to a small commit whose message is JSON.
 * Taking, renewing and releasing a lease are compare-and-swap pushes:
 * `git push --force-with-lease=<ref>:<expected>` is rejected by the server when another laptop
 * moved the ref first. The server is the only judge, so any number of laptops can race safely.
 * An expired lease needs no cleanup: whoever reads it next may take it over.
 */

export interface Lease {
  name: string;
  holder: string;
  /** ISO time after which anyone may take the lease. */
  until: string;
  /** ISO time the lease was taken or renewed. */
  at: string;
  note?: string;
}

export interface AcquireResult {
  ok: boolean;
  lease?: Lease;
  heldBy?: Lease;
  error?: string;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class GitRefLease {
  constructor(
    private readonly repoDir: string,
    private readonly remote = 'origin',
    private readonly namespace = 'refs/agentic-loop/leases',
  ) {}

  ref(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`bad lease name "${name}"`);
    return `${this.namespace}/${name}`;
  }

  /** Reads the lease from the remote. Returns null when no ref exists. */
  async read(name: string): Promise<{ sha: string; lease: Lease } | null> {
    const ref = this.ref(name);
    const r = await run('git', ['ls-remote', '--exit-code', this.remote, ref], { cwd: this.repoDir });
    if (r.code === 2) return null;
    if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim()}`);
    const sha = r.stdout.trim().split(/\s+/)[0];
    if (!sha) return null;
    const lease = await this.readCommit(sha, ref);
    return lease ? { sha, lease } : null;
  }

  /** Lists every lease in the namespace, expired ones included. */
  async list(): Promise<Lease[]> {
    const r = await run('git', ['ls-remote', this.remote, `${this.namespace}/*`], { cwd: this.repoDir });
    if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim()}`);
    const pairs = r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter((p): p is [string, string] => p.length >= 2);
    const out: Lease[] = [];
    for (const [sha, ref] of pairs) {
      const lease = await this.readCommit(sha, ref);
      if (lease) out.push(lease);
    }
    return out;
  }

  /** Takes the lease when it is free, expired, or already mine. */
  async acquire(name: string, holder: string, ttlMs: number, note?: string): Promise<AcquireResult> {
    const current = await this.read(name);
    if (current && current.lease.holder !== holder && !isExpired(current.lease)) {
      return { ok: false, heldBy: current.lease };
    }
    return this.swap(name, holder, ttlMs, current?.sha ?? '', note);
  }

  /** Extends a lease I hold. Fails when someone else holds it now. */
  async renew(name: string, holder: string, ttlMs: number, note?: string): Promise<AcquireResult> {
    const current = await this.read(name);
    if (!current) return { ok: false, error: 'lease is gone' };
    if (current.lease.holder !== holder) return { ok: false, heldBy: current.lease };
    return this.swap(name, holder, ttlMs, current.sha, note);
  }

  /** Deletes a lease I hold. Returns false when it was not mine any more. */
  async release(name: string, holder: string): Promise<boolean> {
    const current = await this.read(name);
    if (!current) return true;
    if (current.lease.holder !== holder) return false;
    const ref = this.ref(name);
    const r = await run('git', ['push', '-q', `--force-with-lease=${ref}:${current.sha}`, this.remote, `:${ref}`], {
      cwd: this.repoDir,
    });
    return r.code === 0;
  }

  private async swap(name: string, holder: string, ttlMs: number, expectedSha: string, note?: string): Promise<AcquireResult> {
    const ref = this.ref(name);
    const now = new Date();
    const lease: Lease = {
      name,
      holder,
      until: new Date(now.getTime() + ttlMs).toISOString(),
      at: now.toISOString(),
      ...(note ? { note } : {}),
    };
    const sha = (await ok('git', ['commit-tree', EMPTY_TREE, '-m', JSON.stringify(lease)], { cwd: this.repoDir, env: commitEnv() })).trim();
    const r = await run('git', ['push', '-q', `--force-with-lease=${ref}:${expectedSha}`, this.remote, `${sha}:${ref}`], {
      cwd: this.repoDir,
    });
    if (r.code === 0) return { ok: true, lease };
    const lost = /stale info|rejected|fetch first|failed to push/i.test(r.stderr);
    if (!lost) return { ok: false, error: r.stderr.trim() };
    const winner = await this.read(name);
    return winner ? { ok: false, heldBy: winner.lease } : { ok: false, error: 'lost the race; the ref changed and is now gone' };
  }

  private async readCommit(sha: string, ref: string): Promise<Lease | null> {
    const have = await run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: this.repoDir });
    if (have.code !== 0) {
      const f = await run('git', ['fetch', '-q', this.remote, ref], { cwd: this.repoDir });
      if (f.code !== 0) throw new Error(`git fetch ${ref} failed: ${f.stderr.trim()}`);
    }
    const msg = await ok('git', ['log', '-1', '--format=%B', sha], { cwd: this.repoDir });
    try {
      const parsed = JSON.parse(msg.trim()) as Partial<Lease>;
      if (typeof parsed.holder !== 'string' || typeof parsed.until !== 'string') return null;
      return {
        name: typeof parsed.name === 'string' ? parsed.name : ref.slice(ref.lastIndexOf('/') + 1),
        holder: parsed.holder,
        until: parsed.until,
        at: typeof parsed.at === 'string' ? parsed.at : parsed.until,
        ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
      };
    } catch {
      return null;
    }
  }
}

export function isExpired(lease: Lease, now = Date.now()): boolean {
  const until = Date.parse(lease.until);
  return !Number.isFinite(until) || until <= now;
}

function commitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'agentic-loop',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'agentic-loop@localhost',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'agentic-loop',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'agentic-loop@localhost',
  };
}
