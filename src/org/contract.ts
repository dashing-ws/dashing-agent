import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeFolder, isUnrestricted, type Access } from '../runner/access.js';

/**
 * The organization contract: what a folder must contain for dashing-agent to run it.
 *
 *   dashing.yaml                 name, director, GitHub project, paths, lease and budget settings
 *   agents/<name>.md             one agent: YAML front matter (role, model, tools) + the system prompt
 *   actions/<name>/manifest.yaml a script the mechanical loop may run, with typed parameters
 *   actions/<name>/run.sh        the script itself
 *   control/kill                 present means stop everything
 *
 * Only dashing.yaml has a fixed place. The three folders are the defaults; an organization that
 * keeps its files elsewhere names them under `paths:` in dashing.yaml. dashing-agent reads these
 * files and never writes them (except `init`, which writes starters, and `setup`, which writes the
 * Project number back).
 */

export interface LeaseConfig {
  directorMinutes: number;
  taskMinutes: number;
  renewMinutes: number;
  planEveryMinutes: number;
}

export interface BudgetConfig {
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMinutes: number;
}

export interface LoopConfig {
  agentSeconds: number;
  mechanicalSeconds: number;
}

/** Where the organization keeps its files, relative to the folder. */
export interface PathsConfig {
  agents: string;
  actions: string;
  control: string;
}

export interface OrgConfig {
  name: string;
  director: string;
  github: { project?: number };
  paths: PathsConfig;
  model: string;
  lease: LeaseConfig;
  budgets: BudgetConfig;
  loops: LoopConfig;
}

export interface AgentSpec {
  name: string;
  role: string;
  description: string;
  /** One emoji, or the path of an image file inside the organization (avatars/<name>.png). */
  avatar?: string;
  /** A free label that groups agents on the page: change, production, assurance. */
  group?: string;
  /** The agent's color on the page, a hex like #3987e5; agents of one group share a hue. Without one the page picks. */
  color?: string;
  model?: string;
  /** Built-in Claude Code tools the agent may use (Read, Glob, Grep, Bash, Write, Edit, WebFetch, WebSearch). */
  tools: string[];
  /** Folders of the checkout the agent may read and write. Default: read everything, write nothing. */
  access: Access;
  /** The system prompt: the Markdown body of the spec file. */
  prompt: string;
  file: string;
}

export interface ActionParam {
  type: 'string' | 'integer' | 'boolean';
  pattern?: string;
  minimum?: number;
  maximum?: number;
  required?: boolean;
  description?: string;
}

export interface ActionManifest {
  name: string;
  description: string;
  params: Record<string, ActionParam>;
  timeoutMinutes: number;
  dir: string;
}

export interface Organization {
  dir: string;
  config: OrgConfig;
  agents: AgentSpec[];
  director: AgentSpec;
  actions: ActionManifest[];
}

export interface OrgLoad {
  org?: Organization;
  problems: string[];
}

export const CONFIG_FILE = 'dashing.yaml';
export const AGENTS_DIR = 'agents';
export const ACTIONS_DIR = 'actions';
export const CONTROL_DIR = 'control';
export const KILL_FILE = 'kill';

const BUILTIN_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task', 'LS',
]);

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const DEFAULTS: Omit<OrgConfig, 'name' | 'director'> = {
  github: {},
  paths: { agents: AGENTS_DIR, actions: ACTIONS_DIR, control: CONTROL_DIR },
  model: 'claude-opus-5-5',
  lease: { directorMinutes: 20, taskMinutes: 30, renewMinutes: 5, planEveryMinutes: 10 },
  budgets: { maxTurns: 40, maxBudgetUsd: 15, timeoutMinutes: 30 },
  loops: { agentSeconds: 60, mechanicalSeconds: 120 },
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** A relative folder inside the organization: no leading slash, no `..`, forward slashes. */
function relDir(v: unknown, fallback: string, key: string, problems: string[]): string {
  if (v === undefined) return fallback;
  const raw = typeof v === 'string' ? v.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : '';
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) {
    problems.push(`${CONFIG_FILE}: paths.${key} must be a folder inside the organization, like "${fallback}"`);
    return fallback;
  }
  return raw;
}

export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = asRecord(YAML.parse(m[1] ?? ''));
  return { data, body: (m[2] ?? '').trim() };
}

export function parseConfig(text: string, problems: string[]): OrgConfig | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(YAML.parse(text));
  } catch (e) {
    problems.push(`${CONFIG_FILE}: ${(e as Error).message}`);
    return undefined;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const director = typeof raw.director === 'string' ? raw.director.trim() : '';
  if (!name) problems.push(`${CONFIG_FILE}: "name" is missing`);
  if (!director) problems.push(`${CONFIG_FILE}: "director" is missing (the agent that reads the inbox and assigns work)`);
  const gh = asRecord(raw.github);
  const paths = asRecord(raw.paths);
  const lease = asRecord(raw.lease);
  const budgets = asRecord(raw.budgets);
  const loops = asRecord(raw.loops);
  const project = typeof gh.project === 'number' ? gh.project : undefined;
  return {
    name,
    director,
    github: project !== undefined ? { project } : {},
    paths: {
      agents: relDir(paths.agents, DEFAULTS.paths.agents, 'agents', problems),
      actions: relDir(paths.actions, DEFAULTS.paths.actions, 'actions', problems),
      control: relDir(paths.control, DEFAULTS.paths.control, 'control', problems),
    },
    model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULTS.model,
    lease: {
      directorMinutes: num(lease.director_minutes, DEFAULTS.lease.directorMinutes),
      taskMinutes: num(lease.task_minutes, DEFAULTS.lease.taskMinutes),
      renewMinutes: num(lease.renew_minutes, DEFAULTS.lease.renewMinutes),
      planEveryMinutes: num(lease.plan_every_minutes, DEFAULTS.lease.planEveryMinutes),
    },
    budgets: {
      maxTurns: num(budgets.max_turns, DEFAULTS.budgets.maxTurns),
      maxBudgetUsd: num(budgets.max_budget_usd, DEFAULTS.budgets.maxBudgetUsd),
      timeoutMinutes: num(budgets.timeout_minutes, DEFAULTS.budgets.timeoutMinutes),
    },
    loops: {
      agentSeconds: num(loops.agent_seconds, DEFAULTS.loops.agentSeconds),
      mechanicalSeconds: num(loops.mechanical_seconds, DEFAULTS.loops.mechanicalSeconds),
    },
  };
}

/** `access: { read: [folders], write: [folders] }` in an agent's front matter. Writing implies reading. */
function parseAccess(raw: unknown, where: string, problems: string[]): Access {
  const rec = asRecord(raw);
  const list = (key: 'read' | 'write', fallback: string[]): string[] => {
    if (rec[key] === undefined) return fallback;
    const items = Array.isArray(rec[key]) ? rec[key] : [rec[key]];
    const out: string[] = [];
    for (const item of items) {
      const f = normalizeFolder(item);
      if (f === undefined) problems.push(`${where}: access.${key} entry ${JSON.stringify(item)} must be a folder inside the repository, like "docs" or "."`);
      else if (!out.includes(f)) out.push(f);
    }
    return out;
  };
  return { read: list('read', ['']), write: list('write', []) };
}

/** Parses one agent file. `label` names it in problems and becomes `file`; `fallbackName` is the file name without .md. */
export function parseAgentText(text: string, label: string, fallbackName: string, problems: string[]): AgentSpec | undefined {
  const { data, body } = parseFrontMatter(text);
  const name = typeof data.name === 'string' && data.name ? data.name : fallbackName;
  if (!NAME_RE.test(name)) {
    problems.push(`${label}: agent name "${name}" must be lowercase letters, digits and dashes`);
    return undefined;
  }
  const tools = Array.isArray(data.tools) ? data.tools.filter((t): t is string => typeof t === 'string') : [];
  const unknown = tools.filter((t) => !BUILTIN_TOOLS.has(t));
  if (unknown.length) problems.push(`${label}: unknown tools ${unknown.join(', ')}`);
  const access = parseAccess(data.access, label, problems);
  if (tools.includes('Bash') && !isUnrestricted(access)) {
    problems.push(`${label}: Bash reaches every file, so an agent with Bash must say so: access: { read: [.], write: [.] }`);
  }
  if (!body) problems.push(`${label}: the body (the system prompt) is empty`);
  const color = typeof data.color === 'string' ? data.color.trim() : '';
  if (color && !COLOR_RE.test(color)) problems.push(`${label}: color "${color}" must be a hex color like #3987e5`);
  return {
    name,
    role: typeof data.role === 'string' ? data.role : name,
    description: typeof data.description === 'string' ? data.description : '',
    ...(typeof data.avatar === 'string' && data.avatar.trim() ? { avatar: data.avatar.trim() } : {}),
    ...(typeof data.group === 'string' && data.group.trim() ? { group: data.group.trim() } : {}),
    ...(color && COLOR_RE.test(color) ? { color: color.toLowerCase() } : {}),
    ...(typeof data.model === 'string' && data.model ? { model: data.model } : {}),
    tools: tools.filter((t) => BUILTIN_TOOLS.has(t)),
    access,
    prompt: body,
    file: label,
  };
}

async function loadAgents(dir: string, rel: string, problems: string[]): Promise<AgentSpec[]> {
  const agentsDir = path.join(dir, rel);
  if (!(await exists(agentsDir))) {
    problems.push(`${rel}/ is missing: add one Markdown file per agent`);
    return [];
  }
  const files = (await fs.readdir(agentsDir)).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();
  const agents: AgentSpec[] = [];
  for (const file of files) {
    const full = path.join(agentsDir, file);
    const spec = parseAgentText(await fs.readFile(full, 'utf8'), `${rel}/${file}`, file.replace(/\.md$/, ''), problems);
    if (spec) agents.push({ ...spec, file: path.relative(dir, full) });
  }
  if (!agents.length) problems.push(`${rel}/ has no agent files`);
  return agents;
}

async function loadActions(dir: string, rel: string, problems: string[]): Promise<ActionManifest[]> {
  const actionsDir = path.join(dir, rel);
  if (!(await exists(actionsDir))) return [];
  const out: ActionManifest[] = [];
  const walk = async (sub: string): Promise<void> => {
    const abs = path.join(actionsDir, sub);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const manifest = entries.find((e) => e.isFile() && e.name === 'manifest.yaml');
    if (manifest) {
      const text = await fs.readFile(path.join(abs, 'manifest.yaml'), 'utf8');
      const raw = asRecord(YAML.parse(text));
      const name = typeof raw.name === 'string' && raw.name ? raw.name : sub.split(path.sep).join('/');
      if (!(await exists(path.join(abs, 'run.sh')))) problems.push(`${rel}/${sub}: run.sh is missing`);
      const params: Record<string, ActionParam> = {};
      for (const [k, v] of Object.entries(asRecord(raw.params))) {
        const p = asRecord(v);
        const type = p.type === 'integer' || p.type === 'boolean' ? p.type : 'string';
        params[k] = {
          type,
          ...(typeof p.pattern === 'string' ? { pattern: p.pattern } : {}),
          ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}),
          ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}),
          ...(typeof p.description === 'string' ? { description: p.description } : {}),
          required: p.required !== false,
        };
      }
      out.push({
        name,
        description: typeof raw.description === 'string' ? raw.description : '',
        params,
        timeoutMinutes: num(raw.timeout_minutes, 10),
        dir: abs,
      });
      return;
    }
    for (const e of entries) if (e.isDirectory()) await walk(path.join(sub, e.name));
  };
  await walk('');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** True when an avatar names an image file inside the organization rather than an emoji. */
export function isAvatarFile(avatar: string | undefined): avatar is string {
  if (!avatar) return false;
  const a = avatar.replace(/\\/g, '/');
  return /\.(png|jpe?g|gif|svg|webp)$/i.test(a) && !a.startsWith('/') && !a.split('/').includes('..');
}

export async function loadOrganization(dir: string): Promise<OrgLoad> {
  const problems: string[] = [];
  const configPath = path.join(dir, CONFIG_FILE);
  if (!(await exists(configPath))) {
    problems.push(`${CONFIG_FILE} is missing`);
    return { problems };
  }
  const config = parseConfig(await fs.readFile(configPath, 'utf8'), problems);
  if (!config) return { problems };
  const agents = await loadAgents(dir, config.paths.agents, problems);
  const actions = await loadActions(dir, config.paths.actions, problems);
  const director = agents.find((a) => a.name === config.director);
  if (config.director && !director) {
    problems.push(`${CONFIG_FILE}: director "${config.director}" has no file ${config.paths.agents}/${config.director}.md`);
  }
  if (!(await exists(path.join(dir, config.paths.control)))) {
    problems.push(`${config.paths.control}/ is missing (an empty folder; "${config.paths.control}/${KILL_FILE}" stops every node)`);
  }
  if (problems.length || !director) return { problems };
  return { org: { dir, config, agents, director, actions }, problems };
}

/** True when `<control>/kill` exists. `control` is the organization's control folder (default `control`). */
export async function isKillSwitchOn(dir: string, control: string = CONTROL_DIR): Promise<boolean> {
  return exists(path.join(dir, control, KILL_FILE));
}
