import { describe, it, expect } from 'vitest';
import { githubTools, refusal } from './github-tools.js';
import { parseGrants } from './grants.js';

const { grants } = parseGrants('| strokine/dashing-crypto-api | 2026-11-06 | #7 | the API |\n');
const ctx = { own: 'strokine/dashing-crypto-agents', grants, login: 'strokine', account: false, log: () => {} };

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const call = (name: string, args: Record<string, unknown>, account = false): Promise<{ content: Array<{ text: string }>; isError?: boolean }> => {
  const t = githubTools({ ...ctx, account }).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (t.handler as Handler)(args, {});
};

describe('refusal', () => {
  it('lets the own and the granted repositories through, whatever the case', () => {
    expect(refusal(ctx, 'strokine/dashing-crypto-agents')).toBeUndefined();
    expect(refusal(ctx, 'Strokine/Dashing-Crypto-API')).toBeUndefined();
    expect(refusal(ctx, 'https://github.com/strokine/dashing-crypto-api')).toBeUndefined();
  });

  it('refuses everything else and says how to grant it', () => {
    expect(refusal(ctx, 'strokine/gemid-pro')).toContain('strokine/gemid-pro is not granted');
    expect(refusal(ctx, 'strokine/gemid-pro')).toContain('add strokine/gemid-pro to your context');
    expect(refusal(ctx, 'not a repo')).toContain('owner/name');
  });
});

describe('githubTools', () => {
  it('serves the account list only when asked, and lists what is granted without gh', async () => {
    expect(githubTools({ ...ctx, account: false }).map((t) => t.name)).toEqual(['list_granted_repos', 'read_repo_file', 'list_repo_tree', 'search_repo', 'list_pull_requests', 'read_pull_request']);
    expect(githubTools({ ...ctx, account: true }).map((t) => t.name)).toContain('list_account_repos');
    const rows = JSON.parse((await call('list_granted_repos', {})).content[0]!.text) as Array<{ repo: string; task?: number }>;
    expect(rows.map((r) => r.repo)).toEqual(['strokine/dashing-crypto-agents', 'strokine/dashing-crypto-api']);
    expect(rows[1]!.task).toBe(7);
  });

  it('refuses a repository that is not granted before gh runs', async () => {
    for (const [name, args] of [
      ['read_repo_file', { repo: 'strokine/gemid-pro', path: 'pom.xml' }],
      ['list_repo_tree', { repo: 'strokine/gemid-pro' }],
      ['search_repo', { repo: 'strokine/gemid-pro', query: 'spring' }],
      ['list_pull_requests', { repo: 'strokine/gemid-pro' }],
      ['read_pull_request', { repo: 'strokine/gemid-pro', number: 1 }],
    ] as const) {
      const out = await call(name, { ...args });
      expect(out.isError, name).toBe(true);
      expect(out.content[0]!.text, name).toContain('is not granted');
    }
  });
});
