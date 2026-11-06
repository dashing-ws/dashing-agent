import path from 'node:path';

/**
 * What an agent may touch: folders of its checkout it may read, and folders it may write.
 * Enforced in the PreToolUse hook on every built-in file tool. Paths outside the checkouts and
 * the `.git` folder are always denied. A run has one checkout, the organization's, and gains a
 * second when the agent calls `work_in` on a granted repository; the same folders apply in each.
 * Bash cannot be limited this way, so an agent with Bash must be given everything (the loader
 * refuses anything else).
 */

export interface Access {
  /** Folders the agent may read, relative to its checkout. '' means the whole checkout. */
  read: string[];
  /** Folders the agent may create and edit files in. Writing implies reading. */
  write: string[];
}

export const ALL = '';

export const DEFAULT_ACCESS: Access = { read: [ALL], write: [] };

/** Tool name -> the input field that holds the path, and whether the call reads or writes. */
const FILE_TOOLS: Record<string, { field: string; mode: 'read' | 'write'; optional?: boolean }> = {
  Read: { field: 'file_path', mode: 'read' },
  Glob: { field: 'path', mode: 'read', optional: true },
  Grep: { field: 'path', mode: 'read', optional: true },
  LS: { field: 'path', mode: 'read', optional: true },
  Write: { field: 'file_path', mode: 'write' },
  Edit: { field: 'file_path', mode: 'write' },
  MultiEdit: { field: 'file_path', mode: 'write' },
  NotebookEdit: { field: 'notebook_path', mode: 'write' },
};

/** Normalizes one folder entry; `undefined` when it leaves the checkout. '.', '/', '*' and '**' mean everything. */
export function normalizeFolder(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const raw = v.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (raw === '' || raw === '.' || raw === '/' || raw === '*' || raw === '**') return ALL;
  if (raw.startsWith('/') || raw.split('/').includes('..') || /[*?[\]]/.test(raw)) return undefined;
  return raw;
}

export function hasAll(list: string[]): boolean {
  return list.includes(ALL);
}

export function isUnrestricted(a: Access): boolean {
  return hasAll(a.read) && hasAll(a.write);
}

export function describeAccess(a: Access): string {
  const show = (l: string[]): string => (hasAll(l) ? 'everything' : l.length ? l.map((f) => `${f}/`).join(', ') : 'nothing');
  return `read ${show(a.write.length && !hasAll(a.read) ? [...new Set([...a.read, ...a.write])] : a.read)}, write ${show(a.write)}`;
}

function inside(rel: string, folders: string[]): boolean {
  return folders.some((f) => f === ALL || rel === f || rel.startsWith(`${f}/`));
}

export type AccessVerdict = { ok: true } | { ok: false; reason: string };

/** The folder of `roots` that holds `abs`, or undefined when none does. */
function rootOf(abs: string, roots: string[]): string | undefined {
  return roots.find((r) => {
    const rel = path.relative(r, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * Decides one tool call. Tools without a path (web, todo, ledger tools) pass. Relative paths
 * resolve against `cwd`; `roots` are the other checkouts of the run (a granted repository).
 */
export function checkAccess(tool: string, input: unknown, cwd: string, access: Access, roots: string[] = []): AccessVerdict {
  const spec = FILE_TOOLS[tool];
  if (!spec) return { ok: true };
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const given = args[spec.field];
  if (typeof given !== 'string' || !given.trim()) {
    if (!spec.optional) return { ok: false, reason: `${tool} needs ${spec.field}` };
  }
  const target = typeof given === 'string' && given.trim() ? given : cwd;
  const abs = path.resolve(cwd, target);
  const root = rootOf(abs, [cwd, ...roots]);
  if (!root) {
    const fromCwd = path.relative(cwd, abs).split(path.sep).join('/');
    return { ok: false, reason: `${fromCwd || target} is outside your checkout${roots.length ? 's' : ''}` };
  }
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel === '.git' || rel.startsWith('.git/')) return { ok: false, reason: '.git is off limits' };
  if (tool === 'Glob' && typeof args.pattern === 'string' && args.pattern.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'a glob pattern may not climb with ..' };
  }
  const allowed = spec.mode === 'write' ? access.write : [...access.read, ...access.write];
  if (!inside(rel, allowed)) {
    const list = allowed.length ? (hasAll(allowed) ? 'everything' : allowed.map((f) => `${f}/`).join(', ')) : 'nothing';
    return { ok: false, reason: `you may ${spec.mode} ${list}; ${rel || '.'} is not in it` };
  }
  return { ok: true };
}
