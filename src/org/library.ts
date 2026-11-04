import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { isAvatarFile, parseAgentText, parseFrontMatter, type AgentSpec } from './contract.js';

/**
 * The agent library: ready agents that ship with dashing-agent, one Markdown file each under
 * `library/agents/`, in the same format as an organization's own agent files. Starting an
 * organization copies the chosen files into it; from then on the organization owns them.
 */

export interface LibraryAgent extends AgentSpec {
  /** The file as shipped, copied verbatim into a new organization. */
  text: string;
  /** The default Director: checked first in the builder. */
  required: boolean;
  /** For an image avatar, its absolute path in the library; copied into a new organization at `avatar`. */
  avatarFile?: string;
}

export const LIBRARY_ROOT = fileURLToPath(new URL('../../library/', import.meta.url));
export const LIBRARY_DIR = fileURLToPath(new URL('../../library/agents/', import.meta.url));
export const TEMPLATES_DIR = fileURLToPath(new URL('../../library/templates/', import.meta.url));

/** A template: a named set of library agents with a director, one click in the builder. */
export interface OrgTemplate {
  name: string;
  title: string;
  description: string;
  avatar?: string;
  director: string;
  agents: string[];
}

export async function loadTemplates(library: LibraryAgent[], dir: string = TEMPLATES_DIR): Promise<OrgTemplate[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const known = new Set(library.map((a) => a.name));
  const out: OrgTemplate[] = [];
  for (const file of files) {
    const raw = YAML.parse(await fs.readFile(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    const name = typeof raw.name === 'string' && raw.name ? raw.name : file.replace(/\.yaml$/, '');
    const agents = Array.isArray(raw.agents) ? raw.agents.filter((a): a is string => typeof a === 'string') : [];
    const director = typeof raw.director === 'string' && raw.director ? raw.director : 'director';
    const unknown = agents.filter((a) => !known.has(a));
    if (unknown.length) throw new Error(`template ${name} names agents the library lacks: ${unknown.join(', ')}`);
    if (!agents.includes(director)) throw new Error(`template ${name}: the director ${director} is not among its agents`);
    out.push({
      name,
      title: typeof raw.title === 'string' ? raw.title : name,
      description: typeof raw.description === 'string' ? raw.description : '',
      ...(typeof raw.avatar === 'string' && raw.avatar ? { avatar: raw.avatar } : {}),
      director,
      agents,
    });
  }
  return out;
}

export async function loadLibrary(dir: string = LIBRARY_DIR): Promise<LibraryAgent[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const out: LibraryAgent[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), 'utf8');
    const problems: string[] = [];
    const spec = parseAgentText(text, `library/agents/${file}`, file.replace(/\.md$/, ''), problems);
    if (!spec || problems.length) throw new Error(`the agent library is broken: ${problems.join('; ')}`);
    const { data } = parseFrontMatter(text);
    const item: LibraryAgent = { ...spec, text, required: data.required === true };
    if (isAvatarFile(spec.avatar)) {
      const avatarFile = path.join(path.dirname(dir), spec.avatar);
      try {
        await fs.access(avatarFile);
        item.avatarFile = avatarFile;
      } catch {
        throw new Error(`the agent library is broken: ${spec.name} names avatar ${spec.avatar}, which is missing`);
      }
    }
    out.push(item);
  }
  return out.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}
