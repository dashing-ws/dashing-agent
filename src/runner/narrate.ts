import path from 'node:path';

/**
 * Turns a tool call into plain words for the activity feed: a past-tense verb and its object
 * ("read docs/plan.md"), plus the same in progress for the live card ("reading docs/plan.md").
 * Ledger tools that announce themselves (post_update, assign_task, ...) return nothing here;
 * their own code reports what they did with more detail.
 */

export interface ToolWords {
  verb: string;
  text: string;
  now: string;
}

const QUIET = new Set(['post_update', 'remove_file', 'propose_plan', 'finish', 'assign_task', 'reject_task', 'file_task', 'comment_task']);

function str(input: unknown, key: string): string {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
}

function short(s: string, max = 90): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A path as the agent sees it: relative to its checkout when inside it. */
export function relPath(p: string, cwd: string): string {
  if (!p) return '';
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

export function describeToolCall(name: string, input: unknown, cwd: string): ToolWords | undefined {
  const file = relPath(str(input, 'file_path') || str(input, 'path') || str(input, 'notebook_path'), cwd);
  switch (name) {
    case 'Read':
      return { verb: 'read', text: file, now: `reading ${file}` };
    case 'Write':
      return { verb: 'wrote', text: file, now: `writing ${file}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'edited', text: file, now: `editing ${file}` };
    case 'LS':
      return { verb: 'listed', text: file || '.', now: `listing ${file || '.'}` };
    case 'Glob': {
      const what = `files like ${str(input, 'pattern')}${file ? ` in ${file}` : ''}`;
      return { verb: 'looked for', text: what, now: `looking for ${what}` };
    }
    case 'Grep': {
      const what = `“${short(str(input, 'pattern'), 60)}”${file ? ` in ${file}` : ''}`;
      return { verb: 'searched for', text: what, now: `searching for ${what}` };
    }
    case 'Bash': {
      const cmd = short(str(input, 'command'));
      return { verb: 'ran', text: cmd, now: `running ${cmd}` };
    }
    case 'WebFetch': {
      const url = str(input, 'url').replace(/^https?:\/\//, '');
      return { verb: 'fetched', text: short(url, 80), now: `fetching ${short(url, 80)}` };
    }
    case 'WebSearch': {
      const q = `the web for “${short(str(input, 'query'), 60)}”`;
      return { verb: 'searched', text: q, now: `searching ${q}` };
    }
    case 'TodoWrite':
      return { verb: 'planned', text: 'its next steps', now: 'planning its next steps' };
    case 'Task':
      return { verb: 'started', text: 'a helper agent', now: 'waiting for a helper agent' };
    default:
      break;
  }
  const m = /^mcp__ledger__(.+)$/.exec(name);
  if (m) {
    const t = m[1]!;
    if (QUIET.has(t)) return undefined;
    switch (t) {
      case 'read_task':
        return { verb: 'read', text: 'the task', now: 'reading the task' };
      case 'list_inbox':
        return { verb: 'read', text: 'the inbox', now: 'reading the inbox' };
      case 'roster':
        return { verb: 'read', text: 'the roster', now: 'reading the roster' };
      case 'list_tasks':
        return { verb: 'read', text: 'the board', now: 'reading the board' };
      case 'task_status': {
        const n = input && typeof input === 'object' ? (input as { number?: unknown }).number : undefined;
        const which = typeof n === 'number' ? `#${n}` : 'a task';
        return { verb: 'read', text: which, now: `reading ${which}` };
      }
      default:
        return { verb: 'called', text: t, now: `calling ${t}` };
    }
  }
  return { verb: 'called', text: name, now: `calling ${name}` };
}

/** The words for a denied call: what was tried, so the line reads "denied: write to policy/x.md". */
export function describeDenied(name: string, input: unknown, cwd: string): string {
  const file = relPath(str(input, 'file_path') || str(input, 'path') || str(input, 'notebook_path'), cwd);
  switch (name) {
    case 'Read':
      return `read ${file}`;
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `write to ${file}`;
    case 'Bash':
      return `run ${short(str(input, 'command'), 60)}`;
    case 'Glob':
    case 'Grep':
    case 'LS':
      return `search ${file || 'outside its folders'}`;
    default:
      return `use ${name.replace(/^mcp__ledger__/, '')}`;
  }
}
