import path from 'node:path';
import { run } from '../util/exec.js';
import { isKillSwitchOn, type Organization } from '../org/contract.js';
import type { Task, TaskStatus, TaskStore } from '../github/task-store.js';
import type { GitRefLease, Lease } from '../lease/git-ref-lease.js';
import type { StateStore } from '../state.js';
import { runAgent } from '../runner/agent-runner.js';
import { workerTools, directorTools, type ToolEvent } from '../runner/ledger-tools.js';
import { githubTools } from '../runner/github-tools.js';
import { readGrants, type Grant } from '../runner/grants.js';
import { openWorkspace, openRepoWorkspace, closeWorkspace, defaultBranch, type Workspace, type CloseResult } from '../runner/workspace.js';
import type { Loop } from './loop.js';
import { trackRun, clock } from './run-tracker.js';
import { PullRequestWatch } from './pr-watch.js';
import { minutes } from '../util/ids.js';
import type { SourceView } from '../state.js';

/** States a closed issue may keep. */
const FINAL = new Set<TaskStatus>(['Done', 'Rejected', 'Failed']);

export interface AgentLoopDeps {
  orgDir: string;
  reload: () => Promise<Organization | undefined>;
  store: TaskStore;
  lease: GitRefLease;
  state: StateStore;
  /** Who this laptop is, for leases and comments: login@host. */
  holder: string;
  auditDir: string;
  /** Where task worktrees go (outside the organization folder). */
  workRoot: string;
  /** Where clones of granted repositories go, one per owner/name. */
  reposRoot: string;
  /** The organization's own repository, owner/name. */
  own: string;
  /** The signed-in GitHub login, for the context curator's account list. */
  login?: string;
  /** Agents this laptop may run; empty means all. */
  only: string[];
}

/**
 * The agent loop: pull, check the kill switch, take or renew the Director lease and plan if it is
 * ours, then claim one Assigned task with a lease and run its agent. One run per tick.
 */
export class AgentLoop {
  private lastPlanAt = 0;
  private directorHeldBy: string | undefined;
  private pullWarned = false;
  /** Tasks with a run in progress in this process. A lease held by this laptop reads as free to it, so this guards the same node. */
  private readonly active = new Set<number>();
  /** The task leases seen last time, by name, to tell a new claim on another laptop. */
  private seenLeases = new Map<string, string>();
  /** The organization's default branch, read once. */
  private base: string | undefined;
  /** The granted repositories as merged on the default branch, read every tick. */
  private granted: Grant[] = [];
  private readonly prs: PullRequestWatch;
  loop: Loop | undefined;

  constructor(private readonly d: AgentLoopDeps) {
    this.prs = new PullRequestWatch(d.store, d.own);
  }

  /** The granted repositories as of the last tick, for the front desk. */
  get grants(): Grant[] {
    return this.granted;
  }

  /** A task was just filed on this laptop: plan on the next tick, and run it now. */
  requestPlanning(): void {
    this.lastPlanAt = 0;
    void this.loop?.runOnce();
  }

  readonly tick = async (): Promise<void> => {
    const { state, store, lease, holder } = this.d;
    const log = (t: string): void => state.info(t, 'agent');

    const pulled = await run('git', ['pull', '-q', '--ff-only'], { cwd: this.d.orgDir, timeoutMs: 60_000 });
    if (pulled.code !== 0) {
      const reason = pulled.stderr.trim().split('\n')[0] ?? 'unknown';
      if (/no tracking information|no such ref was fetched/i.test(reason)) {
        if (!this.pullWarned) state.warn(`cannot pull the organization (${reason}); running on the local copy`, 'agent');
        this.pullWarned = true;
      } else {
        state.warn(`git pull failed: ${reason}; skipping this tick`, 'agent');
        return;
      }
    }

    const org = await this.d.reload();
    if (!org) {
      state.warn('the organization files no longer load; skipping this tick', 'agent');
      return;
    }
    if (await isKillSwitchOn(org.dir, org.config.paths.control)) {
      const was = state.state.org?.killSwitch;
      state.update((s) => {
        if (s.org) s.org.killSwitch = true;
      });
      if (!was) state.event({ who: 'agent loop', verb: 'stopped', text: `the kill switch is on (${org.config.paths.control}/kill) · nothing runs until the file is removed`, level: 'warn', needs: true });
      state.warn(`kill switch is on (${org.config.paths.control}/kill); not running anything`, 'agent');
      return;
    }
    if (state.state.org?.killSwitch) state.event({ who: 'agent loop', verb: 'resumed', text: 'the kill switch is off again' });
    state.update((s) => {
      if (s.org) s.org.killSwitch = false;
    });

    // The grants, as merged on the default branch: the fence for the GitHub tools and work_in.
    this.base ??= await defaultBranch(this.d.orgDir);
    const read = await readGrants(this.d.orgDir, this.base);
    this.granted = read.grants;
    state.update((s) => {
      s.sources = sourcesView(this.d.own, read.grants);
    });

    const tasks = await store.list();
    // An issue closed on GitHub (a merged pull request, a person) is done, whatever the board says.
    for (const t of tasks) {
      if (t.closed && !FINAL.has(t.status)) {
        log(`#${t.number} is closed on GitHub; marking it Done`);
        await store.setStatus(t, 'Done');
        await store.comment(t, `**Done.** The issue was closed on GitHub, so the board now says Done.\n\n<sub>${holder}</sub>`);
        state.event({ who: 'agent loop', verb: 'marked', text: `#${t.number} Done · the issue was closed on GitHub`, task: t.number });
      }
    }
    // A task in Review whose pull requests in granted repositories are all merged is done too.
    for (const t of tasks) {
      if (t.status !== 'Review' || t.closed) continue;
      let merged: 'merged' | 'open' | 'none';
      try {
        merged = await this.prs.status(t);
      } catch (e) {
        state.warn(`could not check the pull requests of #${t.number}: ${(e as Error).message.split('\n')[0]}`, 'agent');
        continue;
      }
      if (merged !== 'merged') continue;
      log(`#${t.number}: every pull request it opened is merged; marking it Done`);
      await store.setStatus(t, 'Done');
      await store.comment(t, `**Done.** Every pull request this task opened in a granted repository is merged.\n\n<sub>${holder}</sub>`);
      state.event({ who: 'agent loop', verb: 'marked', text: `#${t.number} Done · its pull requests are merged`, task: t.number });
      this.prs.forget(t.number);
    }

    // The Director: one laptop at a time.
    const inbox = tasks.filter((t) => t.status === 'Inbox');
    const director = await lease.acquire('director', holder, minutes(org.config.lease.directorMinutes));
    if (director.ok) {
      if (this.directorHeldBy !== holder) {
        log('this laptop is the Director now');
        state.event({ who: 'agent loop', verb: 'took', text: `the Director lease · ${org.director.name} plans from this laptop` });
      }
      this.directorHeldBy = holder;
      const due = Date.now() - this.lastPlanAt >= minutes(org.config.lease.planEveryMinutes);
      if (inbox.length && due) {
        await this.plan(org, inbox);
        this.lastPlanAt = Date.now();
      }
    } else if (director.heldBy) {
      if (this.directorHeldBy !== director.heldBy.holder) {
        log(`the Director runs on ${director.heldBy.holder} until ${director.heldBy.until.slice(11, 16)} UTC`);
        state.event({ who: 'agent loop', verb: 'sees', text: `the Director on ${director.heldBy.holder} until ${clock(director.heldBy.until)}`, where: director.heldBy.holder });
      }
      this.directorHeldBy = director.heldBy.holder;
    } else if (director.error) {
      state.warn(`director lease: ${director.error}`, 'agent');
    }
    await this.publishLeases(tasks);

    // One task, one agent, one run.
    const runnable = new Set(this.d.only.length ? this.d.only : org.agents.map((a) => a.name));
    const candidates = tasks.filter((t) => t.status === 'Assigned' && t.agent && runnable.has(t.agent) && org.agents.some((a) => a.name === t.agent));
    for (const task of candidates) {
      if (this.active.has(task.number)) continue;
      const name = `task-${task.number}`;
      const claim = await lease.acquire(name, holder, minutes(org.config.lease.taskMinutes));
      if (!claim.ok) continue;
      this.active.add(task.number);
      this.seenLeases.set(name, holder);
      await this.publishLeases(tasks);
      try {
        await this.work(org, task, claim.lease?.until);
      } finally {
        this.active.delete(task.number);
        await lease.release(name, holder);
        await this.publishLeases(tasks);
      }
      break;
    }
  };

  private async plan(org: Organization, inbox: Task[]): Promise<void> {
    const { state, store, holder } = this.d;
    const who = org.director.name;
    const log = (t: string): void => state.info(t, 'director');
    this.loop?.setCurrent(`Director: ${inbox.length} task${inbox.length === 1 ? '' : 's'} in the inbox`);
    const watch = trackRun(state, { id: 'director', who, title: 'the inbox', cwd: org.dir });
    const event: ToolEvent = (e) => state.event({ who, ...e });
    const ctx = { inbox: [...inbox], store, org, node: holder, log, event };
    const tools = directorTools(ctx);
    const prompt = [
      `There ${inbox.length === 1 ? 'is 1 task' : `are ${inbox.length} tasks`} in the inbox. For each one, call assign_task with the best agent for it, or reject_task if it is not for this organization. Read the task with list_inbox first.`,
      grantsLine(this.d.own, this.granted),
      'A task on a repository that is not granted goes to the agent anyway, with the note that a person must grant the repository at the front desk first; the context curator records grants.',
      'Do not do the work yourself. When every task has been assigned or rejected, stop.',
    ].join('\n');
    state.event({ who, verb: 'started', text: `a planning pass · ${inbox.length} task${inbox.length === 1 ? '' : 's'} in the inbox` });
    const out = await runAgent({
      agent: org.director, org, prompt, cwd: org.dir, node: holder, tools, log,
      label: 'director planning pass',
      auditFile: path.join(this.d.auditDir, 'director', `${stamp()}-${safe(holder)}.jsonl`),
      observer: watch,
    });
    const left = ctx.inbox.length;
    state.event({
      who, verb: out.outcome === 'success' ? 'finished' : 'stopped',
      text: `the planning pass${out.outcome === 'success' ? '' : ` (${out.outcome})`} · ${left ? `${left} still in the inbox` : 'the inbox is empty'} · ${numbers(out)}`,
      ...(out.outcome === 'success' ? {} : { level: 'warn' as const }),
    });
    this.loop?.setCurrent(undefined);
  }

  private async work(org: Organization, task: Task, leaseUntil: string | undefined): Promise<void> {
    const { state, store, holder, lease } = this.d;
    const agent = org.agents.find((a) => a.name === task.agent)!;
    const log = (t: string): void => state.info(t, agent.name);
    this.loop?.setCurrent(`${agent.name} on #${task.number} ${task.title}`);
    state.event({ who: 'agent loop', verb: 'claimed', text: `#${task.number} for ${agent.name}${leaseUntil ? ` · lease until ${clock(leaseUntil)}` : ''}`, task: task.number });
    let finalStatus: TaskStatus | undefined;
    await store.setStatus(task, 'Running');
    await store.comment(task, `**Claimed** by ${agent.name} on ${holder}.`);
    let ws: Workspace;
    try {
      ws = await openWorkspace(org.dir, this.d.workRoot, task.number);
    } catch (e) {
      const why = (e as Error).message.split('\n')[0];
      state.warn(`cannot open a workspace for #${task.number}: ${why}`, agent.name);
      await store.comment(task, `**Run could not start:** no workspace (${why}).\n\nMove the task back to **Assigned** to try again.`);
      await store.setStatus(task, 'Failed');
      state.event({ who: agent.name, verb: 'failed:', text: `no workspace (${why}) · move #${task.number} back to Assigned to retry`, task: task.number, level: 'error', needs: true });
      return;
    }
    const workNote = `You work in ${ws.dir}, a checkout of the organization repository on the branch ${ws.branch}. Files you create or change there are committed and pushed by the harness when you finish, as a pull request on this task. You do not commit or push yourself.${ws.note ? ` Note: ${ws.note}.` : ''}`;
    const watch = trackRun(state, { id: `task-${task.number}`, who: agent.name, task: task.number, title: task.title, cwd: ws.dir, ...(leaseUntil ? { leaseUntil } : {}) });
    const github = agent.harnessTools.includes('github');
    const grants = this.granted;
    let repoWs: Workspace | undefined;
    const openRepo = async (repo: string): Promise<{ dir: string; branch: string; note?: string }> => {
      if (repoWs) throw new Error(`already working in ${repoWs.repo}`);
      repoWs = await openRepoWorkspace({ repo, reposRoot: this.d.reposRoot, workRoot: this.d.workRoot, orgName: org.config.name, task: task.number });
      return { dir: repoWs.dir, branch: repoWs.branch, ...(repoWs.note ? { note: repoWs.note } : {}) };
    };
    const tools = workerTools({
      task, store, agent, org, node: holder, cwd: ws.dir, log, onFinal: (s) => (finalStatus = s), event: (e) => state.event({ who: agent.name, ...e }),
      own: this.d.own, grants, ...(github ? { openRepo } : {}),
    });
    const servers = github ? { github: githubTools({ own: this.d.own, grants, ...(this.d.login ? { login: this.d.login } : {}), account: agent.harnessTools.includes('github-account'), log }) } : undefined;
    const notes = github
      ? [
          `${grantsLine(this.d.own, grants)} Read a granted repository with the github tools (read_repo_file, list_repo_tree, search_repo, list_pull_requests, read_pull_request). To change files in one, call work_in once with its owner/name and use your file tools in the folder it returns; the harness opens the pull request there. Nothing else on GitHub is reachable; a person grants a repository at the front desk.`,
        ]
      : [];
    const abort = new AbortController();
    const renew = setInterval(() => {
      void lease.renew(`task-${task.number}`, holder, minutes(org.config.lease.taskMinutes)).then((r) => {
        if (!r.ok) {
          state.warn(`lost the lease on #${task.number} (${r.heldBy ? `now ${r.heldBy.holder}` : r.error}); stopping the run`, agent.name);
          state.event({ who: agent.name, verb: 'lost', text: `the lease on #${task.number}${r.heldBy ? ` to ${r.heldBy.holder}` : ''} · the run stops`, task: task.number, level: 'warn' });
          abort.abort();
        } else if (r.lease) {
          watch.renewed(r.lease.until);
        }
      });
    }, minutes(org.config.lease.renewMinutes));
    const auditFile = path.join(this.d.auditDir, `task-${task.number}`, `${stamp()}-${safe(holder)}.jsonl`);
    const prompt = [
      `Task #${task.number}: ${task.title}`,
      '',
      task.body || '(no description)',
      '',
      'Call read_task to see the comments so far. Do the work this task asks of you within your tools. Leave progress with post_update. End with propose_plan when something must be executed in the world, or finish when the result is a text or files.',
    ].join('\n');
    let outcome;
    try {
      outcome = await runAgent({
        agent, org, prompt, cwd: ws.dir, node: holder, tools, auditFile, log, abort, label: `#${task.number}`, workNote, notes, observer: watch,
        ...(servers ? { servers } : {}), roots: () => (repoWs ? [repoWs.dir] : []),
      });
    } finally {
      clearInterval(renew);
    }
    const closed = await closeWorkspace(ws, { title: task.title, agent: agent.name, holder, pullRequest: true });
    if (closed.error) state.warn(`workspace for #${task.number}: ${closed.error}`, agent.name);
    let changes = changesLine('Changes', ws, closed);
    if (closed.pushed) log(`pushed ${ws.branch}${closed.prUrl ? ` and opened ${closed.prUrl}` : ''}`);
    let pushed = closed.pushed ? ` · pushed ${ws.branch}${closed.prUrl ? ` and opened ${prWords(closed.prUrl)}` : ''}` : '';
    if (repoWs) {
      const repoClosed = await closeWorkspace(repoWs, { title: task.title, agent: agent.name, holder, pullRequest: true, taskUrl: task.url });
      if (repoClosed.error) state.warn(`workspace of ${repoWs.repo} for #${task.number}: ${repoClosed.error}`, agent.name);
      changes += changesLine(`Changes in ${repoWs.repo}`, repoWs, repoClosed);
      if (repoClosed.pushed) log(`pushed ${repoWs.branch} to ${repoWs.repo}${repoClosed.prUrl ? ` and opened ${repoClosed.prUrl}` : ''}`);
      if (repoClosed.prUrl) this.prs.remember(task.number, repoClosed.prUrl);
      if (repoClosed.pushed) pushed += ` · pushed ${repoWs.branch} to ${repoWs.repo}${repoClosed.prUrl ? ` and opened ${prWords(repoClosed.prUrl)}` : ''}`;
    }
    const audit = path.relative(this.d.auditDir, auditFile);
    const tail = `${changes}\n\n<sub>${outcome.outcome}, ${outcome.turns} turns, ${(outcome.durationMs / 1000).toFixed(0)}s, ~$${outcome.costUsd.toFixed(2)}, ${outcome.toolCalls} tool calls (${outcome.denied} denied). Audit: ${audit} on ${holder}</sub>`;
    let status: TaskStatus;
    if (finalStatus) {
      await store.comment(task, `**Run finished.**${tail}`);
      status = finalStatus;
    } else if (outcome.outcome === 'success') {
      await store.comment(task, `**Result:** ${outcome.text || '(no text)'}${tail}`);
      await store.setStatus(task, 'Review');
      status = 'Review';
    } else {
      await store.comment(task, `**Run ended early (${outcome.outcome}).** ${outcome.text}${tail}\n\nMove the task back to **Assigned** to try again.`);
      await store.setStatus(task, 'Failed');
      status = 'Failed';
    }
    if (status === 'Failed') {
      state.event({ who: agent.name, verb: 'failed:', text: `${outcome.outcome === 'error' ? outcome.text.split('\n')[0] : `the run ended early (${outcome.outcome})`}${pushed} · move #${task.number} back to Assigned to retry · ${numbers(outcome)}`, task: task.number, level: 'error', needs: true });
    } else {
      state.event({ who: agent.name, verb: 'finished', text: `· the task is ${status}${pushed} · ${numbers(outcome)}`, task: task.number, ...(status === 'Review' ? { needs: true } : {}) });
    }
  }

  /** Publishes the leases to the page and tells the feed about claims on other laptops. */
  private async publishLeases(tasks: Task[]): Promise<void> {
    try {
      const leases = await this.d.lease.list();
      this.noticeRemote(leases, tasks);
      this.d.state.update((s) => {
        s.leases = leases.map((l) => ({ name: l.name, holder: l.holder, until: l.until, at: l.at, mine: l.holder === this.d.holder }));
      });
    } catch (e) {
      this.d.state.warn(`could not list leases: ${(e as Error).message}`, 'agent');
    }
  }

  private noticeRemote(leases: Lease[], tasks: Task[]): void {
    const now = new Map<string, string>();
    for (const l of leases) {
      if (!l.name.startsWith('task-') || Date.parse(l.until) < Date.now()) continue;
      now.set(l.name, l.holder);
      if (l.holder === this.d.holder || this.seenLeases.get(l.name) === l.holder) continue;
      const number = Number(l.name.slice(5));
      const task = tasks.find((t) => t.number === number);
      this.d.state.event({ who: task?.agent ?? 'agent loop', verb: 'claimed', text: `#${number} on ${l.holder} · lease until ${clock(l.until)}`, task: number, where: l.holder });
    }
    this.seenLeases = now;
  }
}

/** The **Changes** line of the result comment for one checkout; empty when nothing happened. */
function changesLine(label: string, ws: Workspace, closed: CloseResult): string {
  if (closed.changed || closed.pushed) {
    return `\n\n**${label}:** ${closed.commit ? `commit ${closed.commit} ` : ''}on branch \`${ws.branch}\`${ws.repo ? ` of ${ws.repo}` : ''}${closed.prUrl ? `, pull request ${closed.prUrl}` : ''}${closed.error ? ` (${closed.error})` : ''}`;
  }
  return closed.error ? `\n\n**${label}:** ${closed.error}` : '';
}

/** One sentence on what the agents may reach beyond their own repository. */
function grantsLine(own: string, grants: Grant[]): string {
  return grants.length
    ? `Repositories granted to this organization beyond its own (${own}): ${grants.map((g) => g.repo).join(', ')}.`
    : `No repository beyond the organization's own (${own}) is granted yet.`;
}

function sourcesView(own: string, grants: Grant[]): SourceView[] {
  return [
    { repo: own, url: `https://github.com/${own}`, own: true },
    ...grants.map((g) => ({ repo: g.repo, url: `https://github.com/${g.repo}`, own: false, ...(g.granted ? { granted: g.granted } : {}), ...(g.task ? { task: g.task } : {}), ...(g.note ? { note: g.note } : {}) })),
  ];
}

function numbers(out: { turns: number; durationMs: number; costUsd: number; toolCalls: number; denied: number }): string {
  const mins = Math.round(out.durationMs / 60_000);
  return `${out.turns} turns · ${mins < 1 ? `${Math.round(out.durationMs / 1000)} s` : `${mins} min`} · ~$${out.costUsd.toFixed(2)} · ${out.toolCalls} calls${out.denied ? `, ${out.denied} denied` : ''}`;
}

function prWords(url: string): string {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `pull request #${m[1]}` : url;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
