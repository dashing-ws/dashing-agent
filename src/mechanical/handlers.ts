import path from 'node:path';
import { run } from '../util/exec.js';
import { gh, ghTry } from '../github/gh.js';
import type { Organization } from '../org/contract.js';
import type { PlanStep } from './plan.js';

export interface HandlerContext {
  org: Organization;
  taskNumber: number;
  node: string;
  log: (text: string) => void;
}

export interface StepResult {
  ok: boolean;
  output: string;
}

function clip(s: string, n = 4000): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

export async function runStep(step: PlanStep, ctx: HandlerContext): Promise<StepResult> {
  switch (step.handler) {
    case 'run_script':
      return runScript(step.args, ctx);
    case 'merge_pr':
      return mergePr(step.args, ctx);
    case 'comment':
      return comment(step.args, ctx);
    default:
      return { ok: false, output: `unknown handler ${String((step as PlanStep).handler)}` };
  }
}

async function runScript(args: Record<string, unknown>, ctx: HandlerContext): Promise<StepResult> {
  const manifest = ctx.org.actions.find((a) => a.name === args.script);
  if (!manifest) return { ok: false, output: `no action named ${String(args.script)}` };
  const params = (args.params && typeof args.params === 'object' ? args.params : {}) as Record<string, unknown>;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DASHING_TASK: String(ctx.taskNumber),
    DASHING_NODE: ctx.node,
    DASHING_ORG: ctx.org.config.name,
    DASHING_ORG_DIR: ctx.org.dir,
  };
  for (const [k, v] of Object.entries(params)) env[`DASHING_PARAM_${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = String(v);
  ctx.log(`run_script ${manifest.name} ${JSON.stringify(params)}`);
  const r = await run('bash', [path.join(manifest.dir, 'run.sh')], { cwd: manifest.dir, env, timeoutMs: manifest.timeoutMinutes * 60_000 });
  const output = clip([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n--- stderr ---\n'));
  return { ok: r.code === 0, output: `exit ${r.code}\n${output}` };
}

async function mergePr(args: Record<string, unknown>, ctx: HandlerContext): Promise<StepResult> {
  const repo = String(args.repo);
  const pr = String(args.pr);
  ctx.log(`merge_pr ${repo}#${pr}: checking state`);
  const view = await ghTry(['pr', 'view', pr, '-R', repo, '--json', 'state,mergeable,mergeStateStatus,isDraft,url']);
  if (view.code !== 0) return { ok: false, output: `gh pr view failed: ${view.stderr.trim()}` };
  const info = JSON.parse(view.stdout) as { state: string; mergeable: string; mergeStateStatus: string; isDraft: boolean; url: string };
  if (info.state === 'MERGED') return { ok: true, output: `${info.url} was already merged` };
  if (info.state !== 'OPEN') return { ok: false, output: `${info.url} is ${info.state.toLowerCase()}` };
  if (info.isDraft) return { ok: false, output: `${info.url} is a draft` };
  const checks = await ghTry(['pr', 'checks', pr, '-R', repo]);
  if (checks.code !== 0 && !/no checks reported/i.test(checks.stderr + checks.stdout)) {
    return { ok: false, output: `checks are not green:\n${clip((checks.stdout + checks.stderr).trim(), 2000)}` };
  }
  if (!['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(info.mergeStateStatus)) {
    return { ok: false, output: `${info.url} cannot merge right now (${info.mergeStateStatus.toLowerCase()})` };
  }
  ctx.log(`merge_pr ${repo}#${pr}: merging`);
  const merged = await ghTry(['pr', 'merge', pr, '-R', repo, '--squash', '--delete-branch']);
  return merged.code === 0 ? { ok: true, output: `merged ${info.url}` } : { ok: false, output: `gh pr merge failed: ${merged.stderr.trim()}` };
}

async function comment(args: Record<string, unknown>, ctx: HandlerContext): Promise<StepResult> {
  const repo = String(args.repo);
  const number = String(args.number);
  ctx.log(`comment ${repo}#${number}`);
  try {
    const url = await gh(['issue', 'comment', number, '-R', repo, '--body-file', '-'], { input: String(args.body) });
    return { ok: true, output: url.trim() };
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
}
