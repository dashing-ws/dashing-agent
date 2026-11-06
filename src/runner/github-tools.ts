import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { run } from '../util/exec.js';
import { GRANTS_FILE, findGrant, parseRepo, type Grant } from './grants.js';

/**
 * The GitHub tools: how an agent reads a repository beyond its checkout. Served in-process as the
 * MCP server `github` to an agent whose spec lists `github`. Every call goes through `gh`, and
 * every call names a repository that must be the organization's own or granted in
 * `context/repos.md` as merged on the default branch; anything else is refused before gh runs.
 * `list_account_repos` is the one tool of `github-account`: the person's own repositories, for
 * the context curator to answer "what is not in your context yet".
 */

type Tool = SdkMcpToolDefinition<any>;

function asTools(tools: unknown[]): Tool[] {
  return tools as Tool[];
}

function text(s: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

export interface GitHubToolContext {
  /** The organization's own repository, owner/name: always readable. */
  own: string;
  grants: Grant[];
  /** The signed-in login, whose repositories `list_account_repos` lists. */
  login?: string;
  /** Serve `list_account_repos` too (the agent's spec lists `github-account`). */
  account: boolean;
  log: (t: string) => void;
}

const FILE_MAX = 120_000;
const DIFF_MAX = 60_000;
const TREE_MAX = 3000;

/** The reason a repository may not be read, or undefined when it may. */
export function refusal(ctx: Pick<GitHubToolContext, 'own' | 'grants'>, repo: string): string | undefined {
  const parsed = parseRepo(repo);
  if (!parsed) return `"${repo}" is not a repository name; write it as owner/name`;
  const key = `${parsed.owner}/${parsed.name}`;
  if (key.toLowerCase() === ctx.own.toLowerCase() || findGrant(ctx.grants, key)) return undefined;
  return `${key} is not granted to this organization. A person grants it at the front desk ("add ${key} to your context"); the context curator records it in ${GRANTS_FILE}, and a human merges that. Granted now: ${ctx.grants.length ? ctx.grants.map((g) => g.repo).join(', ') : 'nothing beyond ' + ctx.own}.`;
}

function canonical(repo: string): string {
  const p = parseRepo(repo)!;
  return `${p.owner}/${p.name}`;
}

export function githubTools(ctx: GitHubToolContext): Tool[] {
  const defaults = new Map<string, string>();
  const defaultBranch = async (repo: string): Promise<string> => {
    const known = defaults.get(repo);
    if (known) return known;
    const r = await run('gh', ['api', `repos/${repo}`, '--jq', '.default_branch'], { timeoutMs: 30_000 });
    const branch = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : 'main';
    defaults.set(repo, branch);
    return branch;
  };
  const tools: unknown[] = [
    tool('list_granted_repos', 'The repositories this organization may read and open pull requests in: its own, then the granted ones from context/repos.md with when and by which task each was granted.', {}, async () => {
      const rows = [
        { repo: ctx.own, url: `https://github.com/${ctx.own}`, note: 'this organization' },
        ...ctx.grants.map((g) => ({ repo: g.repo, url: `https://github.com/${g.repo}`, ...(g.granted ? { granted: g.granted } : {}), ...(g.task ? { task: g.task } : {}), ...(g.note ? { note: g.note } : {}) })),
      ];
      return text(JSON.stringify(rows, null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('read_repo_file', 'Read one file of a granted repository at a ref (its default branch unless you give one).', {
      repo: z.string().min(3).max(140).describe('owner/name'),
      path: z.string().min(1).max(500).describe('the file, relative to the repository root'),
      ref: z.string().min(1).max(200).optional().describe('a branch, tag or commit; default: the default branch'),
    }, async ({ repo, path: file, ref }) => {
      const no = refusal(ctx, repo);
      if (no) return text(no, true);
      const nwo = canonical(repo);
      const clean = file.replace(/^\/+/, '');
      const at = ref ?? (await defaultBranch(nwo));
      ctx.log(`read ${nwo}:${clean}@${at}`);
      const r = await run('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${nwo}/contents/${clean.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(at)}`], { timeoutMs: 60_000 });
      if (r.code !== 0) return text(/404/.test(r.stderr) ? `${nwo} has no file ${clean} at ${at}` : `gh: ${r.stderr.trim().split('\n')[0]}`, true);
      return text(clip(r.stdout, FILE_MAX));
    }, { annotations: { readOnlyHint: true } }),

    tool('list_repo_tree', 'The files of a granted repository at a ref, as paths, under a folder when you give one.', {
      repo: z.string().min(3).max(140).describe('owner/name'),
      path: z.string().max(500).optional().describe('a folder to list under; default: the whole tree'),
      ref: z.string().min(1).max(200).optional(),
    }, async ({ repo, path: under, ref }) => {
      const no = refusal(ctx, repo);
      if (no) return text(no, true);
      const nwo = canonical(repo);
      const at = ref ?? (await defaultBranch(nwo));
      const prefix = (under ?? '').replace(/^\/+|\/+$/g, '');
      ctx.log(`list ${nwo}${prefix ? `/${prefix}` : ''}@${at}`);
      const r = await run('gh', ['api', `repos/${nwo}/git/trees/${encodeURIComponent(at)}?recursive=1`, '--jq', '.tree[] | select(.type == "blob") | .path'], { timeoutMs: 60_000 });
      if (r.code !== 0) return text(`gh: ${r.stderr.trim().split('\n')[0]}`, true);
      const all = r.stdout.split('\n').filter((p) => p && (!prefix || p === prefix || p.startsWith(`${prefix}/`)));
      const shown = all.slice(0, TREE_MAX);
      return text(`${shown.join('\n')}${all.length > TREE_MAX ? `\n… ${all.length - TREE_MAX} more files; give a folder` : ''}` || `nothing under ${prefix || '/'} at ${at}`);
    }, { annotations: { readOnlyHint: true } }),

    tool('search_repo', 'Search the code of a granted repository (GitHub code search on its default branch). Returns the matching files with a fragment each.', {
      repo: z.string().min(3).max(140).describe('owner/name'),
      query: z.string().min(1).max(200).describe('words or a GitHub code-search query, for example "spring-boot path:pom.xml"'),
    }, async ({ repo, query }) => {
      const no = refusal(ctx, repo);
      if (no) return text(no, true);
      const nwo = canonical(repo);
      ctx.log(`search ${nwo} for ${query}`);
      const q = encodeURIComponent(`${query} repo:${nwo}`);
      const r = await run('gh', ['api', '-H', 'Accept: application/vnd.github.text-match+json', `search/code?q=${q}&per_page=30`, '--jq', '.items[] | {path, matches: [.text_matches[]?.fragment]}'], { timeoutMs: 60_000 });
      if (r.code !== 0) return text(`gh: ${r.stderr.trim().split('\n')[0]}`, true);
      return text(clip(r.stdout.trim(), FILE_MAX) || `nothing in ${nwo} matches "${query}"`);
    }, { annotations: { readOnlyHint: true } }),

    tool('list_pull_requests', 'The pull requests of a granted repository.', {
      repo: z.string().min(3).max(140).describe('owner/name'),
      state: z.enum(['open', 'closed', 'merged', 'all']).optional().describe('default: open'),
    }, async ({ repo, state }) => {
      const no = refusal(ctx, repo);
      if (no) return text(no, true);
      const nwo = canonical(repo);
      ctx.log(`pull requests of ${nwo}`);
      const r = await run('gh', ['pr', 'list', '-R', nwo, '--state', state ?? 'open', '--limit', '30', '--json', 'number,title,state,headRefName,url,author,updatedAt'], { timeoutMs: 60_000 });
      if (r.code !== 0) return text(`gh: ${r.stderr.trim().split('\n')[0]}`, true);
      return text(r.stdout.trim() || '[]');
    }, { annotations: { readOnlyHint: true } }),

    tool('read_pull_request', 'One pull request of a granted repository: its description, files and diff.', {
      repo: z.string().min(3).max(140).describe('owner/name'),
      number: z.number().int().positive(),
    }, async ({ repo, number }) => {
      const no = refusal(ctx, repo);
      if (no) return text(no, true);
      const nwo = canonical(repo);
      ctx.log(`read ${nwo}#${number}`);
      const view = await run('gh', ['pr', 'view', String(number), '-R', nwo, '--json', 'number,title,body,state,url,headRefName,baseRefName,author,additions,deletions,mergeStateStatus,files'], { timeoutMs: 60_000 });
      if (view.code !== 0) return text(`gh: ${view.stderr.trim().split('\n')[0]}`, true);
      const diff = await run('gh', ['pr', 'diff', String(number), '-R', nwo], { timeoutMs: 60_000 });
      return text(`${view.stdout.trim()}\n\n--- diff ---\n${diff.code === 0 ? clip(diff.stdout, DIFF_MAX) : `(diff unavailable: ${diff.stderr.trim().split('\n')[0]})`}`);
    }, { annotations: { readOnlyHint: true } }),
  ];
  if (ctx.account) {
    tools.push(tool('list_account_repos', "The repositories of the person's own GitHub account, each marked granted or not. For the context curator, to answer what is not in the context yet. Nothing is granted by listing.", {}, async () => {
      if (!ctx.login) return text('the signed-in login is unknown on this laptop', true);
      ctx.log(`list the repositories of ${ctx.login}`);
      const r = await run('gh', ['repo', 'list', ctx.login, '--limit', '300', '--json', 'nameWithOwner,description,isArchived,isPrivate,pushedAt,primaryLanguage'], { timeoutMs: 60_000 });
      if (r.code !== 0) return text(`gh: ${r.stderr.trim().split('\n')[0]}`, true);
      const rows = (JSON.parse(r.stdout || '[]') as Array<{ nameWithOwner: string; description?: string; isArchived?: boolean; isPrivate?: boolean; pushedAt?: string; primaryLanguage?: { name?: string } | null }>)
        .map((x) => ({
          repo: x.nameWithOwner,
          granted: x.nameWithOwner.toLowerCase() === ctx.own.toLowerCase() || !!findGrant(ctx.grants, x.nameWithOwner),
          ...(x.description ? { description: x.description } : {}),
          ...(x.primaryLanguage?.name ? { language: x.primaryLanguage.name } : {}),
          ...(x.isArchived ? { archived: true } : {}),
          ...(x.isPrivate ? { private: true } : {}),
          ...(x.pushedAt ? { pushedAt: x.pushedAt } : {}),
        }));
      return text(JSON.stringify(rows, null, 2));
    }, { annotations: { readOnlyHint: true } }));
  }
  return asTools(tools);
}
