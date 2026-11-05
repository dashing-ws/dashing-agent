import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../util/exec.js';
import { loadLibrary, loadTemplates, type LibraryAgent } from './library.js';
import { initOrganization, setupProject } from '../setup.js';
import { CONFIG_FILE, findConfigFile, isAvatarFile, parseAgentText, parseConfig } from './contract.js';

/**
 * Builds a new organization from the page: a folder, the chosen agents from the library, a git
 * repository with one commit, and a GitHub repository to push it to. Pre-flight takes it from
 * there (the Project, the tracking branch).
 */

export interface BuildInput {
  folder: string;
  name: string;
  /** owner/name on GitHub. Empty means no remote yet. An existing empty repository is used as is. */
  repo?: string;
  private?: boolean;
  director?: string;
  agents?: string[];
  /** A library template whose agents (and director) are added to the choice. */
  template?: string;
  /** Another organization to copy agents from: a folder on this laptop, or owner/name on GitHub. */
  from?: string;
}

export interface BuildResult {
  folder: string;
  written: string[];
  remote?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}

interface Imported {
  agent: LibraryAgent;
}

/**
 * Reads the agents of another organization: a folder on this laptop or owner/name on GitHub
 * (cloned shallow into a temporary folder). With a agentic-loop.yaml the organization's own agents path
 * is honored; without one, agents/ is read. Avatar image files come along.
 */
export async function importAgents(source: string, log: (line: string) => void): Promise<Imported[]> {
  let dir: string;
  let cleanup: string | undefined;
  if (REPO_RE.test(source) && !source.startsWith('.') && !source.includes('~')) {
    cleanup = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-from-'));
    dir = path.join(cleanup, 'repo');
    const clone = await run('gh', ['repo', 'clone', source, dir, '--', '--depth', '1', '-q'], { timeoutMs: 120_000 });
    if (clone.code !== 0) throw new Error(`cannot clone ${source}: ${firstLine(clone.stderr)}`);
    log(`cloned ${source}`);
  } else {
    dir = path.resolve(expandHome(source));
  }
  try {
    let agentsRel = 'agents';
    const configFile = await findConfigFile(dir);
    if (configFile) {
      const cfg = parseConfig(await fs.readFile(path.join(dir, configFile), 'utf8'), [], configFile);
      if (cfg) agentsRel = cfg.paths.agents;
    }
    const agentsDir = path.join(dir, agentsRel);
    let files: string[];
    try {
      files = (await fs.readdir(agentsDir)).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();
    } catch {
      throw new Error(`${source} has no ${agentsRel}/ folder to copy agents from`);
    }
    const out: Imported[] = [];
    const problems: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(path.join(agentsDir, file), 'utf8');
      const spec = parseAgentText(text, `${source}:${agentsRel}/${file}`, file.replace(/\.md$/, ''), problems);
      if (!spec) continue;
      const item: Imported = { agent: { ...spec, text, required: false } };
      if (isAvatarFile(spec.avatar)) {
        const from = path.join(dir, spec.avatar);
        try {
          if ((await fs.stat(from)).isFile()) item.agent.avatarFile = from;
        } catch {
          problems.push(`${spec.name}: avatar ${spec.avatar} is missing`);
        }
      }
      out.push(item);
    }
    if (problems.length) throw new Error(`agents from ${source} do not load: ${problems.join('; ')}`);
    if (!out.length) throw new Error(`${source} has no agent files`);
    return out;
  } finally {
    if (cleanup) await fs.rm(cleanup, { recursive: true, force: true });
  }
}

export async function buildOrganization(input: BuildInput, log: (line: string) => void): Promise<BuildResult> {
  const name = (input.name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error('the name must be lowercase letters, digits and dashes, like "marketing"');
  if (!input.folder?.trim()) throw new Error('the folder is missing');
  const folder = path.resolve(expandHome(input.folder.trim()));
  const repo = (input.repo ?? '').trim();
  if (repo && !REPO_RE.test(repo)) throw new Error('the repository must be written as owner/name');

  const library = await loadLibrary();
  const template = input.template ? (await loadTemplates(library)).find((t) => t.name === input.template) : undefined;
  if (input.template && !template) throw new Error(`there is no template ${input.template}`);
  const director = input.director?.trim() || template?.director || library.find((a) => a.required)?.name || 'director';
  const names = new Set([director, ...(input.agents ?? []), ...(template?.agents ?? [])]);
  const imported = input.from?.trim() ? await importAgents(input.from.trim(), log) : [];
  for (const a of imported) names.delete(a.agent.name);
  const agents: LibraryAgent[] = [...library.filter((a) => names.has(a.name)), ...imported.map((i) => i.agent)];
  const missing = [...names].filter((n) => !agents.some((a) => a.name === n));
  if (missing.length) throw new Error(`not in the library: ${missing.join(', ')}`);
  if (!agents.some((a) => a.name === director)) throw new Error(`the director ${director} is not among the chosen agents`);

  const existing = await findConfigFile(folder);
  if (existing) throw new Error(`${folder} already holds an organization (${existing} exists)`);
  await fs.mkdir(folder, { recursive: true });
  log(`folder ${folder}`);
  const written = await initOrganization(folder, { name, director, agents });
  log(written.length ? `wrote ${written.length} files: ${written.join(', ')}` : 'the starter files were already there');
  if (imported.length) log(`copied ${imported.length} agent${imported.length === 1 ? '' : 's'} from ${input.from}: ${imported.map((i) => i.agent.name).join(', ')}`);

  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: folder });
  const isRepo = top.code === 0 && path.resolve(top.stdout.trim()) === folder;
  if (!isRepo) {
    const init = await run('git', ['init', '-q', '-b', 'main'], { cwd: folder });
    if (init.code !== 0) throw new Error(`git init: ${firstLine(init.stderr)}`);
    log('git repository created');
  }
  await run('git', ['add', '-A'], { cwd: folder });
  const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: folder });
  if (staged.code !== 0) {
    const commit = await run('git', ['commit', '-q', '-m', `organization ${name}`], { cwd: folder });
    if (commit.code !== 0) throw new Error(`git commit: ${firstLine(commit.stderr)}`);
    log('committed the organization files');
  }

  const result: BuildResult = { folder, written };
  const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: folder });
  if (origin.code === 0) {
    result.remote = origin.stdout.trim();
    log(`origin is ${result.remote}`);
  } else if (!repo) {
    log('no GitHub repository named; pre-flight will ask for one, and for the Project after it');
    return result;
  } else {
    const existing = await run('gh', ['repo', 'view', repo, '--json', 'url', '--jq', '.url'], { timeoutMs: 30_000 });
    if (existing.code === 0) {
      const url = existing.stdout.trim();
      await run('git', ['remote', 'add', 'origin', url], { cwd: folder });
      const push = await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: folder, timeoutMs: 120_000 });
      if (push.code !== 0) throw new Error(`push to ${repo}: ${firstLine(push.stderr)}`);
      log(`pushed to the existing repository ${url}`);
      result.remote = url;
    } else {
      const create = await run('gh', ['repo', 'create', repo, input.private === false ? '--public' : '--private', '--source', folder, '--push'], { timeoutMs: 120_000 });
      if (create.code !== 0) throw new Error(`gh repo create: ${firstLine(create.stderr)}`);
      result.remote = create.stdout.trim().split('\n').pop() ?? repo;
      log(`created ${result.remote} and pushed`);
    }
  }

  // The Project is part of the organization: create it now, and push the number so every laptop has it.
  try {
    await setupProject(folder, log);
    const changed = await run('git', ['status', '--porcelain', '--', CONFIG_FILE], { cwd: folder });
    if (changed.stdout.trim()) {
      await run('git', ['add', '--', CONFIG_FILE], { cwd: folder });
      const commit = await run('git', ['commit', '-q', '-m', 'project number'], { cwd: folder });
      if (commit.code !== 0) throw new Error(`git commit: ${firstLine(commit.stderr)}`);
      const push = await run('git', ['push', '-q'], { cwd: folder, timeoutMs: 120_000 });
      if (push.code !== 0) throw new Error(`git push: ${firstLine(push.stderr)}`);
      log('committed and pushed the project number');
    }
  } catch (e) {
    log(`project: ${firstLine((e as Error).message)}; pre-flight will offer to create it`);
  }
  return result;
}
