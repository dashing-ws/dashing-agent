import type { Organization } from '../org/contract.js';
import type { Comment } from '../github/task-store.js';

/**
 * A plan is what an agent proposes and the mechanical loop executes. It is a list of steps;
 * each step names a handler from the fixed catalog and gives typed arguments. There is no
 * step that runs free text: scripts come from the organization's actions/ folder.
 */

export type HandlerName = 'run_script' | 'merge_pr' | 'comment';

export const HANDLERS: Record<HandlerName, string> = {
  run_script: 'run a script from actions/<name>/run.sh with the parameters its manifest declares',
  merge_pr: 'merge a pull request in a GitHub repository after its checks pass',
  comment: 'post a comment on a GitHub issue or pull request',
};

export interface PlanStep {
  handler: HandlerName;
  args: Record<string, unknown>;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  proposedBy: string;
  at: string;
}

export const PLAN_MARKER = '<!-- dashing:plan -->';

export function renderPlanComment(plan: Plan): string {
  const lines = plan.steps.map((s, i) => `${i + 1}. \`${s.handler}\` ${JSON.stringify(s.args)}`);
  return [
    PLAN_MARKER,
    `**Plan proposed by ${plan.proposedBy}**: ${plan.summary}`,
    '',
    ...lines,
    '',
    'Move this task to **Approved** to let the mechanical loop run it, or **Rejected** to drop it.',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
  ].join('\n');
}

export function parsePlanComment(body: string): Plan | null {
  if (!body.includes(PLAN_MARKER)) return null;
  const m = /```json\s*([\s\S]*?)```/.exec(body);
  if (!m?.[1]) return null;
  try {
    const raw = JSON.parse(m[1]) as Partial<Plan>;
    if (!Array.isArray(raw.steps)) return null;
    return {
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      steps: raw.steps as PlanStep[],
      proposedBy: typeof raw.proposedBy === 'string' ? raw.proposedBy : '',
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  } catch {
    return null;
  }
}

/** The newest plan among the comments, or null. */
export function latestPlan(comments: Comment[]): Plan | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const p = parsePlanComment(comments[i]!.body);
    if (p) return p;
  }
  return null;
}

/** Returns the problems with a plan; an empty list means it may run. */
export function validatePlan(plan: Plan, org: Organization): string[] {
  const problems: string[] = [];
  if (!plan.steps.length) problems.push('the plan has no steps');
  plan.steps.forEach((step, i) => {
    const n = i + 1;
    if (!step || typeof step !== 'object') {
      problems.push(`step ${n} is not an object`);
      return;
    }
    const args = step.args && typeof step.args === 'object' ? step.args : {};
    switch (step.handler) {
      case 'run_script': {
        const script = args.script;
        const manifest = org.actions.find((a) => a.name === script);
        if (!manifest) {
          problems.push(`step ${n}: no action named "${String(script)}" in actions/ (have: ${org.actions.map((a) => a.name).join(', ') || 'none'})`);
          break;
        }
        const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {};
        for (const [name, spec] of Object.entries(manifest.params)) {
          const v = params[name];
          if (v === undefined) {
            if (spec.required) problems.push(`step ${n}: parameter "${name}" is required`);
            continue;
          }
          if (spec.type === 'integer' && !(typeof v === 'number' && Number.isInteger(v))) problems.push(`step ${n}: "${name}" must be an integer`);
          if (spec.type === 'boolean' && typeof v !== 'boolean') problems.push(`step ${n}: "${name}" must be true or false`);
          if (spec.type === 'string' && typeof v !== 'string') problems.push(`step ${n}: "${name}" must be a string`);
          if (spec.type === 'string' && typeof v === 'string' && spec.pattern && !new RegExp(spec.pattern).test(v)) problems.push(`step ${n}: "${name}" does not match ${spec.pattern}`);
          if (typeof v === 'number' && spec.minimum !== undefined && v < spec.minimum) problems.push(`step ${n}: "${name}" is below ${spec.minimum}`);
          if (typeof v === 'number' && spec.maximum !== undefined && v > spec.maximum) problems.push(`step ${n}: "${name}" is above ${spec.maximum}`);
        }
        for (const name of Object.keys(params)) if (!(name in manifest.params)) problems.push(`step ${n}: unknown parameter "${name}"`);
        break;
      }
      case 'merge_pr': {
        if (typeof args.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) problems.push(`step ${n}: "repo" must be owner/name`);
        if (!(typeof args.pr === 'number' && Number.isInteger(args.pr) && args.pr > 0)) problems.push(`step ${n}: "pr" must be a pull request number`);
        break;
      }
      case 'comment': {
        if (typeof args.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) problems.push(`step ${n}: "repo" must be owner/name`);
        if (!(typeof args.number === 'number' && Number.isInteger(args.number) && args.number > 0)) problems.push(`step ${n}: "number" must be an issue number`);
        if (typeof args.body !== 'string' || !args.body.trim()) problems.push(`step ${n}: "body" must be text`);
        break;
      }
      default:
        problems.push(`step ${n}: unknown handler "${String((step as { handler?: unknown }).handler)}" (have: ${Object.keys(HANDLERS).join(', ')})`);
    }
  });
  return problems;
}
