import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runPreflight, formatReport, applyFixes, placeholders, type PreflightReport } from './preflight/index.js';
import { Fixer } from './preflight/fixer.js';
import { describeAccess, hasAll } from './runner/access.js';
import { expandHome } from './org/builder.js';
import { CONFIG_FILE } from './org/contract.js';
import fs from 'node:fs/promises';
import { StateStore, type NodeState } from './state.js';
import { startUi } from './ui/server.js';
import { Loop } from './loops/loop.js';
import { AgentLoop } from './loops/agent-loop.js';
import { MechanicalLoop } from './loops/mechanical-loop.js';
import { GitRefLease } from './lease/git-ref-lease.js';
import { GitHubProjectStore } from './github/task-store.js';
import { loadOrganization, type Organization, type AgentSpec as Spec } from './org/contract.js';
import { initOrganization, setupProject } from './setup.js';
import { loadLibrary, loadTemplates } from './org/library.js';
import { isAvatarFile } from './org/contract.js';
import { buildOrganization } from './org/builder.js';
import { FrontDesk } from './runner/front-desk.js';
import type { TaskStore } from './github/task-store.js';
import type { AgentSpec } from './org/contract.js';
import { hostName, osUser } from './util/ids.js';
import { ghOwners, ghGraphqlResetMs, isRateLimit } from './github/gh.js';
import { VERSION } from './runner/agent-runner.js';
import { pathToFileURL } from 'node:url';

const HELP = `dashing-agent ${VERSION}: run an organization of AI agents from a GitHub repository, on this laptop.

Usage
  dashing-agent [<folder>] [--port 4848] [--no-open] [--fix] [--only a,b] run: pre-flight, UI, both loops; no folder: build one on the page
  dashing-agent check <folder> [--fix]                                     run the pre-flight and exit
  dashing-agent init <folder>                                              write the starter organization files
  dashing-agent setup <folder>                                             create or repair the GitHub Project

The folder is a clone of the organization's GitHub repository. Pre-flight tells you what is missing and how to fix it;
--fix runs the fixes in order in this terminal. --only limits the agents this laptop runs.`;

interface Args {
  command: 'run' | 'check' | 'init' | 'setup' | 'help';
  folder?: string;
  port: number;
  open: boolean;
  fix: boolean;
  only: string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'run', port: 4848, open: true, fix: false, only: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') args.command = 'help';
    else if (a === '--port') args.port = Number(argv[++i] ?? '4848');
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
    else if (a === '--no-open') args.open = false;
    else if (a === '--fix') args.fix = true;
    else if (a === '--only') args.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--only=')) args.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else rest.push(a);
  }
  if (args.command !== 'help') {
    if (rest[0] === 'check' || rest[0] === 'init' || rest[0] === 'setup') {
      args.command = rest[0];
      rest.shift();
    }
    if (rest[0]) args.folder = rest[0];
  }
  return args;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === 'help' || (!args.folder && args.command !== 'run')) {
    console.log(HELP);
    process.exitCode = args.command === 'help' ? 0 : 2;
    return;
  }
  const folder = args.folder ? path.resolve(args.folder) : '';

  if (args.command === 'init' || args.command === 'setup') {
    await ownCommand([args.command, folder], (t) => console.log(t));
    return;
  }

  let report = await runPreflight({ folder });
  console.log(formatReport(report));
  if (!report.ok && args.fix) {
    const fixed = await applyFixes(report, (a) => ownCommand(a, (t) => console.log(t)));
    if (fixed) {
      report = await runPreflight({ folder });
      console.log(`\nAfter the fixes:\n${formatReport(report)}`);
    }
  }
  if (args.command === 'check') {
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  await runNode(folder, args, report);
}

/** The tool's own commands that pre-flight fixes call: `init <folder>` and `setup <folder>`. */
async function ownCommand(argv: string[], log: (text: string) => void): Promise<void> {
  const [command, folderArg] = argv;
  if (!folderArg) throw new Error(`${command ?? 'command'} needs a folder`);
  const folder = path.resolve(folderArg);
  if (command === 'init') {
    const written = await initOrganization(folder);
    log(written.length ? `Wrote:\n  ${written.join('\n  ')}\nEdit them, commit, push, then run: dashing-agent setup ${folder}` : 'Every starter file already exists; nothing written.');
    return;
  }
  if (command === 'setup') {
    await setupProject(folder, log);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

async function runNode(initialFolder: string, args: Args, first: PreflightReport): Promise<void> {
  let folder = initialFolder;
  const user = first.login ?? osUser();
  const holder = `${user}@${hostName()}`;
  const shipped = await loadLibrary();
  const library = shipped.map((a) => ({
    name: a.name, role: a.role, description: a.description,
    ...(a.avatar ? (a.avatarFile ? { avatarUrl: `/library/${a.avatar}` } : { avatar: a.avatar }) : {}),
    ...(a.group ? { group: a.group } : {}),
    ...(a.color ? { color: a.color } : {}),
    tools: a.tools, access: describeAccess(a.access), required: a.required,
  }));
  const isDesk = (a: AgentSpec): boolean => a.role.trim().toLowerCase() === 'front desk' || a.name === 'front-desk';
  const libraryDesk = shipped.find(isDesk);
  const templates = await loadTemplates(shipped);
  const initial: NodeState = {
    node: { id: holder, user, host: hostName(), folder, startedAt: new Date().toISOString(), port: args.port, version: VERSION },
    org: null,
    repo: null,
    preflight: null,
    leases: [],
    loops: {},
    tasks: [],
    fix: null,
    library,
    templates,
    owners: [],
    chat: { messages: [], busy: false },
    runs: [],
    events: [],
    log: [],
  };
  const state = new StateStore(initial);
  const auditDir = path.join(os.homedir(), '.dashing-agent', 'audit');
  let lastReport: PreflightReport = first;

  let ownersFor = '';
  let lastOutcome = '';
  const publish = (r: PreflightReport): void => {
    const failing = r.checks.filter((c) => c.status === 'fail');
    const outcome = r.ok ? 'ok' : failing.map((c) => c.id).join(',') || 'pending';
    if (outcome !== lastOutcome) {
      lastOutcome = outcome;
      if (r.ok) state.event({ who: 'pre-flight', verb: 'passed', text: `${r.checks.length} checks · everything is ready to run` });
      else if (failing.length) state.event({ who: 'pre-flight', verb: 'failed:', text: `${failing.map((c) => c.title).join(', ')} · the loops wait`, level: 'warn', needs: true });
    }
    if (r.login && ownersFor !== r.login) {
      ownersFor = r.login;
      void ghOwners(r.login).then((owners) => state.update((s) => {
        s.owners = owners;
      }));
    }
    state.update((s) => {
      s.preflight = {
        at: r.at,
        ok: r.ok,
        needsOrganization: r.needsOrganization,
        checks: r.checks.map((c) => ({
          id: c.id, title: c.title, status: c.status, detail: c.detail,
          ...(c.fix ? { fix: { description: c.fix.description, ...(c.fix.command ? { command: c.fix.command } : {}), placeholders: placeholders(c.fix.command), terminal: c.fix.terminal === true } } : {}),
        })),
      };
      s.repo = r.repo ? { owner: r.repo.owner, name: r.repo.name, url: r.repo.url, ...(r.project ? { project: r.project } : {}) } : null;
      s.org = r.org ? orgView(r.org, r.killSwitch) : null;
    });
  };
  publish(first);
  lastReport = first;

  let agentLoop: Loop | undefined;
  let mechanicalLoop: Loop | undefined;
  let agentImpl: AgentLoop | undefined;
  let store: TaskStore | undefined;
  let desk: FrontDesk | undefined;
  let started = false;

  const startLoops = (r: PreflightReport): void => {
    if (started || !r.ok || !r.org || !r.repo || !r.project) return;
    started = true;
    const org = r.org;
    const workRoot = path.join(os.homedir(), '.dashing-agent', 'work', path.basename(folder));
    const ghStore = new GitHubProjectStore({ owner: r.repo.owner, repo: r.repo.name, project: r.project, cwd: folder });
    store = ghStore;
    const lease = new GitRefLease(folder);
    let current: Organization = org;
    const reload = async (): Promise<Organization | undefined> => {
      const load = await loadOrganization(folder);
      if (load.org) {
        current = load.org;
        state.update((s) => {
          s.org = orgView(current, s.org?.killSwitch ?? false);
        });
      }
      return load.org ?? undefined;
    };
    const agent = new AgentLoop({ orgDir: folder, reload, store: ghStore, lease, state, holder, auditDir, workRoot, only: args.only });
    const mechanical = new MechanicalLoop({ reload, store: ghStore, lease, state, holder });
    agentImpl = agent;
    const deskAgent = (): AgentSpec => {
      const own = current.agents.find(isDesk);
      if (own) return own;
      if (!libraryDesk) throw new Error('the agent library has no front desk');
      return libraryDesk;
    };
    desk = new FrontDesk({ state, store: ghStore, org: () => current, agent: deskAgent, node: holder, auditDir, onFiled: () => agent.requestPlanning() });
    const backoff = async (e: Error): Promise<number | undefined> => (isRateLimit(e) ? ((await ghGraphqlResetMs()) ?? 5 * 60_000) : undefined);
    agentLoop = new Loop('agent', org.config.loops.agentSeconds * 1000, agent.tick, state, backoff);
    mechanicalLoop = new Loop('mechanical', org.config.loops.mechanicalSeconds * 1000, mechanical.tick, state, backoff);
    agent.loop = agentLoop;
    mechanical.loop = mechanicalLoop;
    agentLoop.start();
    mechanicalLoop.start();
    state.info(`loops started as ${holder}; audit files go to ${auditDir}`);
  };

  const recheck = async (): Promise<void> => {
    const r = await runPreflight({ folder });
    lastReport = r;
    publish(r);
    startLoops(r);
    if (!r.ok) state.warn('pre-flight still fails; the loops wait. Fix the ✗ lines on the page or re-check.');
  };
  const fixer = new Fixer(state, ownCommand, recheck);

  const ui = await startUi(state, args.port, {
    pause: (name) => (name === 'agent' ? agentLoop : mechanicalLoop)?.pause(),
    resume: (name) => (name === 'agent' ? agentLoop : mechanicalLoop)?.resume(),
    preflight: recheck,
    fix: (id, values) => {
      const check = lastReport.checks.find((c) => c.id === id);
      return check ? fixer.start(check, values) : `no check "${id}"`;
    },
    cancelFix: () => fixer.cancel(),
    useFolder: async (given) => {
      if (started) return 'this node already runs an organization; start another dashing-agent for a second one';
      if (!given) return 'say which folder';
      const abs = path.resolve(expandHome(given));
      try {
        await fs.access(path.join(abs, CONFIG_FILE));
      } catch {
        return `${abs} has no ${CONFIG_FILE}; build a new organization there instead, or clone one first`;
      }
      folder = abs;
      state.update((s) => {
        s.node.folder = folder;
      });
      state.event({ who: 'page', verb: 'switched', text: `to the organization in ${folder}` });
      void recheck();
      return undefined;
    },
    chat: (text) => (desk ? desk.send(text) : 'the loops are not running yet; finish pre-flight first'),
    libraryFile: (rel) => shipped.find((a) => a.avatarFile && a.avatar === rel)?.avatarFile,
    orgFile: (rel) => {
      const org = lastReport.org;
      if (!org || !folder) return undefined;
      const allowed = org.agents.some((a) => isAvatarFile(a.avatar) && a.avatar === rel);
      if (!allowed) return undefined;
      const abs = path.resolve(folder, rel);
      return abs.startsWith(folder + path.sep) ? abs : undefined;
    },
    build: (input) => fixer.startJob('build', 'Build the organization', async (log) => {
      const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
      const agents = Array.isArray(input.agents) ? input.agents.filter((a): a is string => typeof a === 'string') : [];
      const built = await buildOrganization({ folder: str('folder'), name: str('name'), repo: str('repo'), private: input.private !== false, director: str('director') || 'director', agents, ...(str('template') ? { template: str('template') } : {}), ...(str('from') ? { from: str('from') } : {}) }, log);
      folder = built.folder;
      state.update((s) => {
        s.node.folder = folder;
      });
      log('done; running pre-flight on the new organization');
    }),
  });
  state.info(`UI at ${ui.url}`);
  if (args.open && process.platform === 'darwin') spawn('open', [ui.url], { stdio: 'ignore', detached: true }).unref();

  startLoops(first);
  let recheckTimer: NodeJS.Timeout | null = null;
  if (!started) {
    state.warn('pre-flight failed; the loops wait until it passes. Fix it on the page; the page re-checks every 30 seconds.');
    recheckTimer = setInterval(() => {
      if (started) {
        if (recheckTimer) clearInterval(recheckTimer);
        return;
      }
      if (!fixer.running) void recheck();
    }, 30_000);
  }

  const shutdown = (): void => {
    state.info('stopping');
    if (recheckTimer) clearInterval(recheckTimer);
    fixer.cancel();
    agentLoop?.stop();
    mechanicalLoop?.stop();
    ui.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function writes(a: Spec): string {
  if (!a.access.write.length) return 'nothing';
  return hasAll(a.access.write) ? 'everything' : a.access.write.map((f) => `${f}/`).join(', ');
}

function orgView(org: Organization, killSwitch: boolean): NodeState['org'] {
  return {
    name: org.config.name,
    director: org.director.name,
    agents: org.agents.map((a) => ({
      name: a.name, role: a.role, description: a.description, model: a.model ?? org.config.model, tools: a.tools, access: describeAccess(a.access), writes: writes(a), file: a.file,
      ...(a.avatar ? (isAvatarFile(a.avatar) ? { avatarUrl: `/org/${a.avatar}` } : { avatar: a.avatar }) : {}),
      ...(a.group ? { group: a.group } : {}),
      ...(a.color ? { color: a.color } : {}),
    })),
    actions: org.actions.map((a) => a.name),
    killSwitch,
  };
}

// Run when started as the script itself (npm run dev, tsx src/cli.ts); bin/dashing-agent.js imports main instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
