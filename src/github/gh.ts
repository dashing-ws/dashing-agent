import { run, ok } from '../util/exec.js';

export interface RepoRef {
  host: string;
  owner: string;
  name: string;
  url: string;
}

/** Parses an https or ssh GitHub remote URL. */
export function parseRemote(url: string): RepoRef | null {
  const u = url.trim();
  let m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (!m) m = /^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (!m) return null;
  const [, host, owner, name] = m;
  if (!host || !owner || !name) return null;
  return { host, owner, name, url: `https://${host}/${owner}/${name}` };
}

export async function ghJson<T>(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<T> {
  const out = await ok('gh', args, { cwd: opts.cwd, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  return JSON.parse(out) as T;
}

export async function gh(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return ok('gh', args, { cwd: opts.cwd, ...(opts.input !== undefined ? { input: opts.input } : {}) });
}

export async function ghTry(args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('gh', args, { cwd: opts.cwd });
}

export async function ghLogin(): Promise<string | null> {
  const r = await run('gh', ['api', 'user', '--jq', '.login']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** When GitHub's GraphQL budget resets, as a wait in milliseconds from now; undefined when unknown. */
export async function ghGraphqlResetMs(): Promise<number | undefined> {
  const r = await run('gh', ['api', 'rate_limit', '--jq', '.resources.graphql.reset'], { timeoutMs: 30_000 });
  const reset = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(reset) ? Math.max(0, reset * 1000 - Date.now()) + 15_000 : undefined;
}

/** True for GitHub's rate-limit errors, primary or secondary. */
export function isRateLimit(error: Error): boolean {
  return /rate limit/i.test(error.message);
}

/** Where the token may create repositories: the user's own account first, then the organizations it belongs to. */
export async function ghOwners(login: string): Promise<string[]> {
  const r = await run('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login'], { timeoutMs: 30_000 });
  const orgs = r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== login) : [];
  return [login, ...orgs.sort((a, b) => a.localeCompare(b))];
}

export async function ghScopes(): Promise<string[] | null> {
  const r = await run('gh', ['auth', 'status']);
  const m = /Token scopes:\s*(.+)/.exec(r.stdout + r.stderr);
  if (!m?.[1]) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
