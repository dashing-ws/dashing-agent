import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, which } from '../util/exec.js';
import { ghJson, ghLogin, ghScopes, parseRemote, type RepoRef } from '../github/gh.js';
import { loadOrganization, isKillSwitchOn, findConfigFile, type Organization, CONFIG_FILE, OLD_CONFIG_FILE } from '../org/contract.js';
import { TASK_STATUSES } from '../github/task-store.js';
import type { CheckStatus } from '../state.js';

/**
 * Pre-flight: everything that must be true before a loop runs, cheapest first.
 * Each failed check carries the fix: a command to run, or words when there is no command.
 */

export interface Fix {
  description: string;
  /** The command, as argv. `<name>` parts are placeholders the user fills in (the page asks for them). */
  command?: string[];
  /** The command needs a real terminal (a shell function, a prompt); the page only shows it. */
  terminal?: boolean;
}

/** The placeholder names in a fix command, in order. */
export function placeholders(command: string[] | undefined): string[] {
  const out: string[] = [];
  for (const arg of command ?? []) for (const m of arg.matchAll(/<([a-z-]+)>/g)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}



export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: Fix;
}

export interface PreflightReport {
  ok: boolean;
  at: string;
  checks: CheckResult[];
  repo?: RepoRef;
  org?: Organization;
  orgProblems: string[];
  login?: string;
  project?: number;
  killSwitch: boolean;
  /** No folder was given, or it has no agentic-loop.yaml: the page offers to build an organization. */
  needsOrganization: boolean;
}

export interface PreflightOptions {
  /** The organization folder; empty when the command was started without one. */
  folder: string;
  /** Skip the checks that talk to GitHub (for tests and offline use). */
  offline?: boolean;
}

const MIN_NODE = 22;
const MIN_GH = [2, 60] as const;
const REQUIRED_SCOPES = ['repo', 'project'];
/** What the login asks for: the required scopes plus the ones the Project reads and Actions need. */
const GH_SCOPES = [...REQUIRED_SCOPES, 'read:project', 'workflow'];

function pass(id: string, title: string, detail: string): CheckResult {
  return { id, title, status: 'pass', detail };
}
function fail(id: string, title: string, detail: string, fix?: Fix): CheckResult {
  return { id, title, status: 'fail', detail, ...(fix ? { fix } : {}) };
}
function warn(id: string, title: string, detail: string, fix?: Fix): CheckResult {
  return { id, title, status: 'warn', detail, ...(fix ? { fix } : {}) };
}
function skip(id: string, title: string, detail: string): CheckResult {
  return { id, title, status: 'skip', detail };
}

function versionTuple(s: string): number[] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0];
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const folder = opts.folder ? path.resolve(opts.folder) : '';
  const checks: CheckResult[] = [];
  const report: PreflightReport = { ok: false, at: new Date().toISOString(), checks, orgProblems: [], killSwitch: false, needsOrganization: true };

  // 1. Node
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(
    nodeMajor >= MIN_NODE
      ? pass('node', 'Node.js', `v${process.versions.node}`)
      : fail('node', 'Node.js', `v${process.versions.node}; Agentic Loop needs ${MIN_NODE} or newer`, {
          description: `Install Node ${MIN_NODE}+ (for example with nvm)`,
          command: ['nvm', 'install', String(MIN_NODE)],
          terminal: true,
        }),
  );

  // 2. git
  const gitV = await run('git', ['--version']);
  checks.push(
    gitV.code === 0
      ? pass('git', 'git', gitV.stdout.trim())
      : fail('git', 'git', 'git is not installed', { description: 'Install git (opens the Xcode tools installer)', command: ['xcode-select', '--install'] }),
  );

  // 3. gh
  const ghV = await run('gh', ['--version']);
  const ghOk = ghV.code === 0;
  const ghVer = ghOk ? versionTuple(ghV.stdout) : [0, 0, 0];
  const ghNew = (ghVer[0] ?? 0) > MIN_GH[0] || ((ghVer[0] ?? 0) === MIN_GH[0] && (ghVer[1] ?? 0) >= MIN_GH[1]);
  checks.push(
    !ghOk
      ? fail('gh', 'GitHub CLI', 'gh is not installed', { description: 'Install the GitHub CLI', command: ['brew', 'install', 'gh'] })
      : !ghNew
        ? fail('gh', 'GitHub CLI', `gh ${ghVer.join('.')}; Agentic Loop needs ${MIN_GH.join('.')} or newer`, {
            description: 'Upgrade the GitHub CLI',
            command: ['brew', 'upgrade', 'gh'],
          })
        : pass('gh', 'GitHub CLI', `gh ${ghVer.join('.')}`),
  );

  // 4. gh login
  let login: string | null = null;
  if (ghOk && !opts.offline) {
    login = await ghLogin();
    if (login) report.login = login;
    checks.push(
      login
        ? pass('gh-auth', 'GitHub login', `signed in as ${login}`)
        : fail('gh-auth', 'GitHub login', 'gh is not signed in', {
            description: 'Sign in to GitHub with a one-time code; gh keeps the token',
            command: ['gh', 'auth', 'login', '-h', 'github.com', '--web', '--git-protocol', 'https', '-s', GH_SCOPES.join(',')],
          }),
    );
  } else {
    checks.push(skip('gh-auth', 'GitHub login', opts.offline ? 'offline' : 'gh is missing'));
  }

  // 5. gh scopes
  let scopesOk = false;
  if (login) {
    const scopes = (await ghScopes()) ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    scopesOk = missing.length === 0;
    checks.push(
      scopesOk
        ? pass('gh-scopes', 'GitHub token scopes', scopes.join(', '))
        : fail('gh-scopes', 'GitHub token scopes', `missing: ${missing.join(', ')} (has: ${scopes.join(', ') || 'none'})`, {
            description: 'Add the missing scopes to the gh token with a one-time code',
            command: ['gh', 'auth', 'refresh', '-h', 'github.com', '-s', GH_SCOPES.join(',')],
          }),
    );
  } else {
    checks.push(skip('gh-scopes', 'GitHub token scopes', 'not signed in'));
  }

  // 6. Claude Code
  const claudePath = await which('claude');
  const claudeV = claudePath ? await run('claude', ['--version']) : null;
  checks.push(
    claudeV && claudeV.code === 0
      ? pass('claude', 'Claude Code', `${claudeV.stdout.trim()} at ${claudePath}; agents run on this laptop's Claude login`)
      : warn('claude', 'Claude Code', 'the claude command is not on PATH; the SDK brings its own binary, but you must be signed in to Claude on this laptop', {
          description: 'Install Claude Code and sign in once',
          command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
        }),
  );

  // 7. folder
  let isDir = false;
  if (folder) {
    try {
      isDir = (await fs.stat(folder)).isDirectory();
    } catch {
      isDir = false;
    }
  }
  checks.push(
    isDir
      ? pass('folder', 'Organization folder', folder)
      : !folder
        ? fail('folder', 'Organization folder', 'none given', { description: 'Build a new organization under Organization on this page, or pass a folder on the command line' })
        : fail('folder', 'Organization folder', `${folder} does not exist`, {
            description: 'Build a new organization there under Organization on this page, or clone an existing one',
            command: ['gh', 'repo', 'clone', '<owner>/<repo>', folder],
          }),
  );
  const configFile = isDir ? await findConfigFile(folder) : undefined;
  const hasConfig = !!configFile;
  report.needsOrganization = !hasConfig;

  // 8. git repo
  let repoOk = false;
  if (isDir) {
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: folder });
    repoOk = top.code === 0 && path.resolve(top.stdout.trim()) === folder;
    checks.push(
      repoOk
        ? pass('git-repo', 'git repository', 'the folder is the root of a git repository')
        : fail('git-repo', 'git repository', top.code === 0 ? `the git root is ${top.stdout.trim()}, pass that folder instead` : 'the folder is not a git repository', {
            description: 'Make it a repository and connect it to GitHub',
            command: ['gh', 'repo', 'create', path.basename(folder), '--source', folder, '--private', '--push'],
          }),
    );
  } else {
    checks.push(skip('git-repo', 'git repository', 'no folder'));
  }

  // 9. remote
  let repo: RepoRef | null = null;
  if (repoOk) {
    const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: folder });
    repo = remote.code === 0 ? parseRemote(remote.stdout) : null;
    const isGitHub = repo?.host === 'github.com';
    if (repo && isGitHub) report.repo = repo;
    checks.push(
      repo && isGitHub
        ? pass('remote', 'GitHub remote', `origin is ${repo.url}`)
        : fail('remote', 'GitHub remote', remote.code === 0 ? `origin is ${remote.stdout.trim()}, which is not on github.com` : 'there is no "origin" remote', {
            description: 'Point origin at the GitHub repository',
            command: ['git', '-C', folder, 'remote', remote.code === 0 ? 'set-url' : 'add', 'origin', 'https://github.com/<owner>/<repo>.git'],
          }),
    );
  } else {
    checks.push(skip('remote', 'GitHub remote', 'no repository'));
  }

  // 10. remote access
  let accessOk = false;
  if (report.repo && login && !opts.offline) {
    try {
      const v = await ghJson<{ nameWithOwner: string; isArchived: boolean; isInOrganization: boolean; viewerPermission: string }>([
        'repo', 'view', `${report.repo.owner}/${report.repo.name}`, '--json', 'nameWithOwner,isArchived,isInOrganization,viewerPermission',
      ]);
      const canWrite = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(v.viewerPermission);
      accessOk = canWrite && !v.isArchived;
      const owner = v.isInOrganization ? 'a GitHub organization' : 'a personal account';
      checks.push(
        accessOk
          ? pass('remote-access', 'Repository access', `${v.nameWithOwner} (${owner}): ${v.viewerPermission.toLowerCase()}`)
          : fail('remote-access', 'Repository access', v.isArchived ? `${v.nameWithOwner} is archived` : `${login} has ${v.viewerPermission.toLowerCase()} access; write access is needed`, {
              description: `Ask ${report.repo.owner} to give ${login} write access at https://github.com/${v.nameWithOwner}/settings/access`,
            }),
      );
    } catch (e) {
      checks.push(fail('remote-access', 'Repository access', `gh cannot open ${report.repo.owner}/${report.repo.name}: ${(e as Error).message.split('\n')[0]}`, {
        description: `Check the repository name, or ask ${report.repo.owner} to give ${login} access to https://github.com/${report.repo.owner}/${report.repo.name}`,
      }));
    }
  } else {
    checks.push(skip('remote-access', 'Repository access', opts.offline ? 'offline' : 'no GitHub remote or not signed in'));
  }

  // 11. git identity: the commits the harness makes on task branches carry it
  if (repoOk) {
    const name = (await run('git', ['config', 'user.name'], { cwd: folder })).stdout.trim();
    const email = (await run('git', ['config', 'user.email'], { cwd: folder })).stdout.trim();
    checks.push(
      name
        ? pass('git-name', 'git name', name)
        : fail('git-name', 'git name', 'user.name is not set', { description: 'Set the name git signs your commits with', command: ['git', 'config', '--global', 'user.name', '<name>'] }),
    );
    checks.push(
      email
        ? pass('git-email', 'git email', email)
        : fail('git-email', 'git email', 'user.email is not set', { description: 'Set the email git signs your commits with', command: ['git', 'config', '--global', 'user.email', '<email>'] }),
    );
  } else {
    checks.push(skip('git-name', 'git name', 'no repository'));
    checks.push(skip('git-email', 'git email', 'no repository'));
  }

  // 12. upstream branch
  if (repoOk) {
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder })).stdout.trim();
    const up = await run('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: folder });
    checks.push(
      up.code === 0
        ? pass('upstream', 'Tracking branch', `${branch} tracks ${up.stdout.trim()}`)
        : warn('upstream', 'Tracking branch', `${branch} has no upstream; the loops cannot pull`, {
            description: 'Push the branch and set its upstream',
            command: ['git', '-C', folder, 'push', '-u', 'origin', branch],
          }),
    );
  } else {
    checks.push(skip('upstream', 'Tracking branch', 'no repository'));
  }

  // 13. organization contract
  if (isDir) {
    const load = await loadOrganization(folder);
    report.orgProblems = load.problems;
    if (load.org) {
      report.org = load.org;
      checks.push(pass('org', 'Organization files', `${load.org.config.name}: ${load.org.agents.length} agents (director ${load.org.director.name}), ${load.org.actions.length} actions`));
    } else {
      checks.push(fail('org', 'Organization files', load.problems.join('; '), hasConfig
        ? { description: 'Add the missing starter files (agents/, control/) and edit them', command: ['agentic-loop', 'init', folder] }
        : { description: 'Build the organization under Organization on this page' }));
    }
    report.killSwitch = await isKillSwitchOn(folder, load.org?.config.paths.control);
    if (report.killSwitch) {
      const killFile = `${load.org?.config.paths.control ?? 'control'}/kill`;
      checks.push(warn('kill', 'Kill switch', `${killFile} exists: every node stops its loops until the file is removed`, {
        description: 'Remove the kill switch when it is safe to run again',
        command: ['git', '-C', folder, 'rm', killFile],
      }));
    } else {
      checks.push(pass('kill', 'Kill switch', 'off'));
    }
    if (configFile === OLD_CONFIG_FILE) {
      checks.push(warn('org-file', 'Organization file name', `${OLD_CONFIG_FILE} is the old name; this laptop still reads it`, {
        description: `Rename it to ${CONFIG_FILE}, then commit and push`,
        command: ['git', '-C', folder, 'mv', OLD_CONFIG_FILE, CONFIG_FILE],
      }));
    }
  } else {
    checks.push(skip('org', 'Organization files', 'no folder'));
    checks.push(skip('kill', 'Kill switch', 'no folder'));
  }

  // 14. GitHub Project
  if (report.org && report.repo && scopesOk && accessOk && !opts.offline) {
    const number = report.org.config.github.project;
    if (!number) {
      checks.push(fail('project', 'GitHub Project', `${report.org.configFile} has no github.project number`, {
        description: `Create the Project with its fields and write the number into ${report.org.configFile}`,
        command: ['agentic-loop', 'setup', folder],
      }));
    } else {
      report.project = number;
      try {
        const fields = await ghJson<{ fields: Array<{ name: string; type: string; options?: Array<{ name: string }> }> }>([
          'project', 'field-list', String(number), '--owner', report.repo.owner, '--format', 'json', '--limit', '100',
        ]);
        const byName = new Map(fields.fields.map((f) => [f.name.toLowerCase(), f]));
        const status = byName.get('status');
        const agent = byName.get('agent');
        const missingStatus = TASK_STATUSES.filter((s) => !(status?.options ?? []).some((o) => o.name === s));
        const agentNames = report.org.agents.map((a) => a.name);
        const missingAgents = agentNames.filter((a) => !(agent?.options ?? []).some((o) => o.name === a));
        const problems: string[] = [];
        if (!status) problems.push('no Status field');
        else if (missingStatus.length) problems.push(`Status lacks options ${missingStatus.join(', ')}`);
        if (!agent) problems.push('no Agent field');
        else if (missingAgents.length) problems.push(`Agent lacks options ${missingAgents.join(', ')}`);
        checks.push(
          problems.length
            ? fail('project', 'GitHub Project', `project #${number}: ${problems.join('; ')}`, {
                description: 'Repair the Project fields',
                command: ['agentic-loop', 'setup', folder],
              })
            : pass('project', 'GitHub Project', `project #${number} has Status and Agent fields`),
        );
      } catch (e) {
        checks.push(fail('project', 'GitHub Project', `project #${number}: ${(e as Error).message.split('\n')[0]}`, {
          description: 'Create or repair the Project',
          command: ['agentic-loop', 'setup', folder],
        }));
      }
    }
  } else {
    checks.push(skip('project', 'GitHub Project', 'needs the organization files, the remote and the project scope'));
  }

  // 15. lease namespace readable
  if (report.repo && repoOk && !opts.offline) {
    const ls = await run('git', ['ls-remote', 'origin', 'refs/agentic-loop/leases/*'], { cwd: folder, timeoutMs: 30_000 });
    const n = ls.stdout.trim() ? ls.stdout.trim().split('\n').length : 0;
    checks.push(
      ls.code === 0
        ? pass('leases', 'Lease refs', `origin reachable; ${n} lease${n === 1 ? '' : 's'} held right now`)
        : fail('leases', 'Lease refs', `git cannot reach origin: ${ls.stderr.trim().split('\n')[0]}`, { description: 'Check your network and git credentials' }),
    );
  } else {
    checks.push(skip('leases', 'Lease refs', opts.offline ? 'offline' : 'no GitHub remote'));
  }

  report.ok = checks.every((c) => c.status !== 'fail');
  return report;
}

const MARK: Record<CheckStatus, string> = { pass: '✓', fail: '✗', warn: '!', skip: '-' };

export function formatReport(r: PreflightReport): string {
  const lines = r.checks.map((c) => {
    const head = `${MARK[c.status]} ${c.title.padEnd(22)} ${c.detail}`;
    if (!c.fix || c.status === 'pass' || c.status === 'skip') return head;
    const cmd = c.fix.command ? `\n      $ ${c.fix.command.join(' ')}` : '';
    return `${head}\n      fix: ${c.fix.description}${cmd}`;
  });
  lines.push(r.ok ? 'Pre-flight passed.' : 'Pre-flight failed. Fix the ✗ lines above, or run with --fix to run the fixes in order.');
  return lines.join('\n');
}

/**
 * Runs each failed check's fix command in order, in the terminal. Stops at the first failure.
 * Fixes that are the tool's own commands (`init`, `setup`) run in-process through `own`.
 */
export async function applyFixes(r: PreflightReport, own: (args: string[]) => Promise<void>): Promise<boolean> {
  const todo = r.checks.filter((c) => c.status === 'fail' && c.fix?.command);
  if (!todo.length) {
    console.log('Nothing to fix by command.');
    return true;
  }
  for (const c of todo) {
    const cmd = c.fix!.command!;
    if (cmd.some((a) => a.includes('<'))) {
      console.log(`! ${c.title}: fill in the placeholders and run it yourself:\n  $ ${cmd.join(' ')}`);
      return false;
    }
    if (c.fix!.terminal) {
      console.log(`! ${c.title}: run this in your shell:\n  $ ${cmd.join(' ')}`);
      return false;
    }
    console.log(`→ ${c.fix!.description}\n  $ ${cmd.join(' ')}`);
    if (cmd[0] === 'agentic-loop') {
      try {
        await own(cmd.slice(1));
      } catch (e) {
        console.log(`✗ ${c.title}: ${(e as Error).message}`);
        return false;
      }
      continue;
    }
    const code = await new Promise<number>((resolve) => {
      const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit' });
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(127));
    });
    if (code !== 0) {
      console.log(`✗ ${c.title}: the fix exited with ${code}`);
      return false;
    }
  }
  return true;
}
