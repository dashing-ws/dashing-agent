import { isKillSwitchOn, type Organization } from '../org/contract.js';
import type { TaskStore } from '../github/task-store.js';
import type { GitRefLease } from '../lease/git-ref-lease.js';
import type { StateStore } from '../state.js';
import { latestPlan, validatePlan } from '../mechanical/plan.js';
import { runStep } from '../mechanical/handlers.js';
import type { Loop } from './loop.js';
import { minutes } from '../util/ids.js';
import type { StepView } from '../state.js';

export interface MechanicalLoopDeps {
  reload: () => Promise<Organization | undefined>;
  store: TaskStore;
  lease: GitRefLease;
  state: StateStore;
  holder: string;
}

/**
 * The mechanical loop: no model. For every Approved task with a valid plan, take a short lease,
 * run the steps in order, write what happened, and set Done or Failed. A failed step stops the plan.
 */
export class MechanicalLoop {
  loop: Loop | undefined;

  constructor(private readonly d: MechanicalLoopDeps) {}

  readonly tick = async (): Promise<void> => {
    const { state, store, lease, holder } = this.d;
    const org = await this.d.reload();
    if (!org) return;
    if (await isKillSwitchOn(org.dir, org.config.paths.control)) return;
    const approved = (await store.list()).filter((t) => t.status === 'Approved');
    for (const task of approved) {
      const name = `task-${task.number}`;
      const claim = await lease.acquire(name, holder, minutes(10));
      if (!claim.ok) continue;
      try {
        const log = (t: string): void => state.info(`#${task.number}: ${t}`, 'mechanical');
        this.loop?.setCurrent(`executing #${task.number} ${task.title}`);
        const plan = latestPlan(await store.comments(task));
        if (!plan) {
          await store.comment(task, `**Nothing to execute.** The task is Approved but has no plan comment. Move it to Done if no execution is needed.`);
          await store.setStatus(task, 'Failed');
          continue;
        }
        const problems = validatePlan(plan, org);
        if (problems.length) {
          await store.comment(task, `**The plan cannot run:**\n- ${problems.join('\n- ')}`);
          await store.setStatus(task, 'Failed');
          continue;
        }
        await store.setStatus(task, 'Executing');
        const runId = `plan-${task.number}`;
        const steps: StepView[] = plan.steps.map((s) => ({ handler: s.handler, state: 'todo' }));
        const show = (now?: string): void => state.run(runId, (r) => ({
          id: runId, kind: 'mechanical', who: 'mechanical loop', task: task.number, title: task.title, startedAt: r?.startedAt ?? new Date().toISOString(),
          turns: 0, maxTurns: 0, toolCalls: 0, denied: 0, maxBudgetUsd: 0, steps: steps.map((s) => ({ ...s })), ...(now ? { now } : {}),
        }));
        state.event({ who: 'mechanical loop', verb: 'started', text: `the plan on #${task.number} · ${steps.length} step${steps.length === 1 ? '' : 's'} by ${plan.proposedBy}`, task: task.number });
        const report: string[] = [];
        let failed = false;
        try {
          for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i]!;
            steps[i]!.state = 'on';
            show(`step ${i + 1} of ${steps.length} · ${step.handler}`);
            const began = Date.now();
            const r = await runStep(step, { org, taskNumber: task.number, node: holder, log });
            const took = `${((Date.now() - began) / 1000).toFixed(0)} s`;
            steps[i]!.state = r.ok ? 'done' : 'failed';
            show();
            state.event({ who: 'mechanical loop', verb: r.ok ? 'ran' : 'failed:', text: `step ${i + 1} ${step.handler} · ${took}${r.ok ? '' : ` · ${r.output.trim().split('\n')[0] ?? ''}`}`, task: task.number, ...(r.ok ? {} : { level: 'error' as const }) });
            report.push(`${r.ok ? '✓' : '✗'} step ${i + 1} \`${step.handler}\`\n\`\`\`\n${r.output}\n\`\`\``);
            if (!r.ok) {
              failed = true;
              break;
            }
          }
        } finally {
          state.run(runId, () => undefined);
        }
        await store.comment(task, `**Executed on ${holder}${failed ? ', stopped at the first failure' : ''}.**\n\n${report.join('\n\n')}`);
        await store.setStatus(task, failed ? 'Failed' : 'Done');
        log(failed ? 'failed' : 'done');
        state.event({ who: 'mechanical loop', verb: 'finished', text: `#${task.number} · the task is ${failed ? 'Failed · move it back to Approved to run the plan again' : 'Done'}`, task: task.number, ...(failed ? { level: 'error' as const, needs: true } : {}) });
      } finally {
        await lease.release(name, holder);
        this.loop?.setCurrent(undefined);
      }
    }
  };
}
