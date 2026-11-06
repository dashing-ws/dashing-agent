import { run } from '../util/exec.js';

/**
 * The repositories the agents may read and open pull requests in, beyond the organization's own.
 * One row per repository in `context/repos.md`, kept by the context curator and merged by a human.
 * The harness reads the file as it is on origin's default branch; a working copy does not count,
 * so an agent that adds a row in its own branch gains nothing until a person merges it.
 */

export const GRANTS_FILE = 'context/repos.md';
export const GRANTS_DIR = 'context/repos';

export interface Grant {
  /** owner/name as GitHub writes it. */
  repo: string;
  owner: string;
  name: string;
  /** When the person granted it, as written in the row. */
  granted?: string;
  /** The task that recorded the grant. */
  task?: number;
  /** What the repository is, in the words of the row. */
  note?: string;
}

export interface GrantsRead {
  grants: Grant[];
  /** Rows that did not parse, so pre-flight can say so. */
  problems: string[];
}

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

/** owner/name from "owner/name", a GitHub URL, or a Markdown link to one; undefined otherwise. */
export function parseRepo(s: string): { owner: string; name: string } | undefined {
  let v = s.trim().replace(/^`|`$/g, '');
  const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(v);
  if (link) v = link[1]!.trim();
  v = v.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  const m = REPO_RE.exec(v);
  if (!m) return undefined;
  return { owner: m[1]!, name: m[2]! };
}

/** The rows of the Markdown table whose first cell names a repository. Anything else in the file is ignored. */
export function parseGrants(text: string): GrantsRead {
  const grants: Grant[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
    const first = cells[0] ?? '';
    if (!first || /^:?-+:?$/.test(first) || /^repositor(y|ies)$/i.test(first)) continue;
    const repo = parseRepo(first);
    if (!repo) {
      problems.push(`row "${first}" does not name a repository as owner/name`);
      continue;
    }
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    if (seen.has(key)) {
      problems.push(`${repo.owner}/${repo.name} is listed twice`);
      continue;
    }
    seen.add(key);
    const granted = (cells[1] ?? '').trim();
    const taskCell = (cells[2] ?? '').trim();
    const task = /^#?(\d+)$/.exec(taskCell)?.[1];
    const note = (cells[3] ?? '').trim();
    grants.push({
      repo: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      name: repo.name,
      ...(granted ? { granted } : {}),
      ...(task ? { task: Number(task) } : {}),
      ...(note ? { note } : {}),
    });
  }
  return { grants, problems };
}

/** The starter file: the header and an empty table, for `init` and for the curator to fill. */
export function starterGrantsFile(): string {
  return [
    '# Repositories',
    '',
    'The repositories the agents may read and open pull requests in, beyond this one. A person grants one at the front desk ("add owner/name to your context"); the context curator adds its row here and a page under `context/repos/<name>.md`; a human merges the pull request. Taking a repository back is the same path. Agentic Loop reads this file as merged on the default branch.',
    '',
    '| Repository | Granted | Task | What it is |',
    '| --- | --- | --- | --- |',
    '',
  ].join('\n');
}

/** The grants as merged on origin's default branch. No file means no grants. */
export async function readGrants(orgDir: string, base: string): Promise<GrantsRead> {
  const r = await run('git', ['show', `origin/${base}:${GRANTS_FILE}`], { cwd: orgDir });
  return r.code === 0 ? parseGrants(r.stdout) : { grants: [], problems: [] };
}

export function findGrant(grants: Grant[], repo: string): Grant | undefined {
  const key = repo.trim().toLowerCase();
  return grants.find((g) => g.repo.toLowerCase() === key);
}
