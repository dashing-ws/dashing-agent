import { EventEmitter } from 'node:events';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckView {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: {
    description: string;
    command?: string[];
    /** Names the page must ask for before the command can run. */
    placeholders: string[];
    /** The command needs a real terminal; the page only shows it. */
    terminal: boolean;
  };
}

export interface PreflightView {
  at: string;
  ok: boolean;
  checks: CheckView[];
  /** No folder, or a folder without agentic-loop.yaml: the page offers to build one. */
  needsOrganization: boolean;
}

export interface LeaseView {
  name: string;
  holder: string;
  until: string;
  at: string;
  mine: boolean;
}

export type LoopStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'waiting';

export interface LoopView {
  name: string;
  status: LoopStatus;
  ticks: number;
  lastTickAt?: string;
  lastError?: string;
  current?: string;
}

export interface TaskView {
  number: number;
  title: string;
  status: string;
  agent?: string;
  url: string;
}

export interface AgentView {
  name: string;
  role: string;
  description: string;
  model: string;
  tools: string[];
  /** The folders in words: "reads everything, writes docs". */
  access: string;
  /** The folders it may write, in words; "nothing" when none. */
  writes: string;
  avatar?: string;
  avatarUrl?: string;
  group?: string;
  /** From the agent's file; the page picks one when it is missing. */
  color?: string;
  /** The agent's file, relative to the organization. */
  file: string;
}

export interface OrgView {
  name: string;
  director: string;
  /** One emoji, or for an image file the page's URL for it. */
  logo?: string;
  logoUrl?: string;
  agents: AgentView[];
  actions: string[];
  killSwitch: boolean;
}

export interface RepoView {
  owner: string;
  name: string;
  url: string;
  project?: number;
}

/** One repository the agents may reach: the organization's own, or a granted one from context/repos.md. */
export interface SourceView {
  repo: string;
  url: string;
  own: boolean;
  granted?: string;
  task?: number;
  note?: string;
}

/** A pre-flight fix running (or just run) from the page. */
export interface FixView {
  id: string;
  title: string;
  command: string[];
  lines: string[];
  /** A GitHub device-flow code to paste at the URL. */
  device?: { code: string; url: string };
  running: boolean;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
}

/** One agent of the library that ships with the tool, for the builder form. */
export interface LibraryView {
  name: string;
  role: string;
  description: string;
  avatar?: string;
  /** For an image avatar, the page's URL for it. */
  avatarUrl?: string;
  group?: string;
  color?: string;
  tools: string[];
  access: string;
  required: boolean;
}

/** One line of the chat with the front desk. */
export interface ChatMessage {
  role: 'you' | 'desk' | 'note';
  text: string;
  at: string;
  costUsd?: number;
  /** What the front desk did while answering (filed #3, commented on #1). */
  did?: string[];
}

/** One template of the library, for the builder form. */
export interface TemplateView {
  name: string;
  title: string;
  description: string;
  avatar?: string;
  director: string;
  agents: string[];
}

export interface LogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  loop?: string;
  text: string;
}

/** Who did something that was not an agent of the organization. */
export type HarnessActor = 'agent loop' | 'mechanical loop' | 'pre-flight' | 'page';

/**
 * One line of the activity feed: who did what, in plain words. `who` is an agent's name or a
 * harness actor; `verb` is the plain verb ("read", "wrote", "assigned", "finished"); `text` is the
 * rest of the sentence. `said` quotes the agent. `where` names the laptop when it was not this one.
 */
export interface ActivityEvent {
  id: number;
  at: string;
  who: string;
  verb: string;
  text: string;
  task?: number;
  said?: string;
  level: 'info' | 'warn' | 'error';
  /** A human must act (a result to review, a failed run to retry). */
  needs?: boolean;
  where?: string;
}

/** A plan step as the mechanical loop runs it. */
export interface StepView {
  handler: string;
  state: 'todo' | 'on' | 'done' | 'failed';
}

/** A run in progress on this laptop: an agent on a task, the Director planning, the front desk answering, or the mechanical loop on a plan. */
export interface RunView {
  id: string;
  kind: 'agent' | 'mechanical';
  /** The agent, or "mechanical loop". */
  who: string;
  task?: number;
  title?: string;
  startedAt: string;
  turns: number;
  maxTurns: number;
  toolCalls: number;
  denied: number;
  maxBudgetUsd: number;
  leaseUntil?: string;
  /** What it does right now, as a verb and its object: "writing docs/plan.md". */
  now?: string;
  /** The last thing it said. */
  said?: string;
  steps?: StepView[];
}

export interface NodeState {
  node: {
    id: string;
    user: string;
    host: string;
    folder: string;
    startedAt: string;
    port: number;
    version: string;
  };
  org: OrgView | null;
  repo: RepoView | null;
  preflight: PreflightView | null;
  leases: LeaseView[];
  loops: Record<string, LoopView>;
  tasks: TaskView[];
  /** The repositories the agents may read and open pull requests in, as merged on the default branch. */
  sources: SourceView[];
  fix: FixView | null;
  library: LibraryView[];
  templates: TemplateView[];
  /** Accounts the signed-in token may create repositories under: the user, then their organizations. */
  owners: string[];
  chat: { messages: ChatMessage[]; busy: boolean };
  /** Runs in progress on this laptop. Other laptops show through the leases and the board. */
  runs: RunView[];
  /** The activity feed, oldest first. */
  events: ActivityEvent[];
  log: LogLine[];
}

const MAX_LOG = 200;
const MAX_EVENTS = 400;

export class StateStore extends EventEmitter {
  readonly state: NodeState;

  constructor(initial: NodeState) {
    super();
    this.state = initial;
  }

  update(fn: (s: NodeState) => void): void {
    fn(this.state);
    this.emit('change', this.state);
  }

  log(level: LogLine['level'], text: string, loop?: string): void {
    const line: LogLine = { at: new Date().toISOString(), level, text, ...(loop ? { loop } : {}) };
    this.state.log.push(line);
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    const prefix = `${line.at.slice(11, 19)} ${level.padEnd(5)}${loop ? ` [${loop}]` : ''}`;
    const out = level === 'error' ? console.error : console.log;
    out(`${prefix} ${text}`);
    this.emit('change', this.state);
  }

  private nextEvent = 1;

  /** Adds one line to the activity feed and logs it. */
  event(e: Omit<ActivityEvent, 'id' | 'at' | 'level'> & { at?: string; level?: ActivityEvent['level'] }): void {
    const line: ActivityEvent = { ...e, id: this.nextEvent++, at: e.at ?? new Date().toISOString(), level: e.level ?? 'info' };
    this.state.events.push(line);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    const task = line.task ? ` #${line.task}` : '';
    this.log(line.level, `${line.verb} ${line.text}${line.said ? ` “${line.said.slice(0, 120)}”` : ''}`, `${line.who}${task}`);
  }

  /** Adds, replaces or removes a run in progress. */
  run(id: string, fn: ((r: RunView | undefined) => RunView | undefined)): void {
    this.update((s) => {
      const i = s.runs.findIndex((r) => r.id === id);
      const next = fn(i >= 0 ? s.runs[i] : undefined);
      if (next && i >= 0) s.runs[i] = next;
      else if (next) s.runs.push(next);
      else if (i >= 0) s.runs.splice(i, 1);
    });
  }

  info(text: string, loop?: string): void {
    this.log('info', text, loop);
  }

  warn(text: string, loop?: string): void {
    this.log('warn', text, loop);
  }

  error(text: string, loop?: string): void {
    this.log('error', text, loop);
  }
}
