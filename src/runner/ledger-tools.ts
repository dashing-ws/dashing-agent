import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSpec, Organization } from '../org/contract.js';
import type { Task, TaskStatus, TaskStore } from '../github/task-store.js';
import { renderPlanComment, validatePlan, type Plan } from '../mechanical/plan.js';
import { checkAccess } from './access.js';
import { refusal } from './github-tools.js';
import type { Grant } from './grants.js';

/** One line for the activity feed, from a tool that did something worth telling. */
export type ToolEvent = (e: { verb: string; text: string; task?: number; said?: string; needs?: boolean }) => void;

/**
 * The ledger tools are the only way an agent touches the task. They are served in-process,
 * scoped to the one task (or, for the Director, the inbox) the run was launched for.
 */

type Tool = SdkMcpToolDefinition<any>;

/** The SDK types each tool by its own schema; an array of different tools needs one common type. */
function asTools(tools: unknown[]): Tool[] {
  return tools as Tool[];
}

function text(s: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) };
}

export interface WorkerToolContext {
  task: Task;
  store: TaskStore;
  agent: AgentSpec;
  org: Organization;
  node: string;
  /** The agent's checkout; `remove_file` works inside it under the agent's write folders. */
  cwd: string;
  /** Called when the agent sets a final status so the loop does not set one again. */
  onFinal: (status: TaskStatus) => void;
  log: (t: string) => void;
  event?: ToolEvent;
  /** The organization's own repository, owner/name. */
  own: string;
  /** The granted repositories, as merged on the default branch. */
  grants: Grant[];
  /** Opens the checkout of a granted repository for this run; present when the agent has the github tools. */
  openRepo?: (repo: string) => Promise<{ dir: string; branch: string; note?: string }>;
}

export function workerTools(ctx: WorkerToolContext): Tool[] {
  const sign = (body: string): string => `${body}\n\n<sub>${ctx.agent.name} on ${ctx.node}</sub>`;
  return asTools([
    tool('read_task', 'Read the task you were launched for: title, body, status, agent and all comments.', {}, async () => {
      const comments = await ctx.store.comments(ctx.task);
      return text(JSON.stringify({ number: ctx.task.number, url: ctx.task.url, title: ctx.task.title, body: ctx.task.body, status: ctx.task.status, agent: ctx.task.agent, comments }, null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('post_update', 'Post a progress note on the task as a comment. Use it for what a colleague would want to know; keep it short.', { note: z.string().min(1).max(8000) }, async ({ note }) => {
      await ctx.store.comment(ctx.task, sign(`**Update:** ${note}`));
      ctx.log('posted an update');
      ctx.event?.({ verb: 'posted', text: 'an update on the task', task: ctx.task.number, said: note });
      return text('posted');
    }),

    tool('remove_file', 'Delete one file in your checkout. Only inside the folders you may write; the deletion goes into your pull request like any other change.', {
      path: z.string().min(1).max(500).describe('relative to your checkout'),
    }, async ({ path: rel }) => {
      const verdict = checkAccess('Write', { file_path: rel }, ctx.cwd, ctx.agent.access);
      if (!verdict.ok) return text(`cannot remove ${rel}: ${verdict.reason}`, true);
      const abs = path.resolve(ctx.cwd, rel);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return text(`${rel} is not a file`, true);
        await fs.unlink(abs);
      } catch {
        return text(`there is no file ${rel}`, true);
      }
      ctx.log(`removed ${rel}`);
      ctx.event?.({ verb: 'removed', text: rel, task: ctx.task.number });
      return text(`removed ${rel}`);
    }),

    tool('propose_plan', 'Propose a plan for the mechanical loop to execute after a human approves it. Each step names a handler from the catalog with its arguments. The task moves to Review.', {
      summary: z.string().min(1).max(500),
      steps: z.array(z.object({
        handler: z.enum(['run_script', 'merge_pr', 'comment']),
        // A loose object, not z.record: the zod inside Agent SDK 0.3.284 and older cannot convert a record made
        // by zod 4.6, and one tool it cannot convert hides every tool of the server from the agent.
        args: z.looseObject({}),
      })).min(1).max(20),
    }, async ({ summary, steps }) => {
      const plan: Plan = { summary, steps, proposedBy: ctx.agent.name, at: new Date().toISOString() };
      const problems = validatePlan(plan, ctx.org);
      if (problems.length) return text(`The plan is not valid:\n- ${problems.join('\n- ')}\nFix it and call propose_plan again.`, true);
      await ctx.store.comment(ctx.task, sign(renderPlanComment(plan)));
      await ctx.store.setStatus(ctx.task, 'Review');
      ctx.onFinal('Review');
      ctx.log(`proposed a plan with ${steps.length} step${steps.length === 1 ? '' : 's'}; task is in Review`);
      ctx.event?.({ verb: 'proposed', text: `a plan with ${steps.length} step${steps.length === 1 ? '' : 's'} · waits for your approval`, task: ctx.task.number, said: summary, needs: true });
      return text('Plan posted. The task is in Review and waits for a human.');
    }),

    ...(ctx.openRepo ? [workIn(ctx)] : []),

    tool('finish', 'Finish your work on the task. "Review" when a human should look at your result; "Done" when nothing else is needed.', {
      summary: z.string().min(1).max(8000),
      status: z.enum(['Review', 'Done']),
    }, async ({ summary, status }) => {
      await ctx.store.comment(ctx.task, sign(`**Result (${status}):** ${summary}`));
      await ctx.store.setStatus(ctx.task, status);
      ctx.onFinal(status);
      ctx.log(`finished; task is ${status}`);
      ctx.event?.({ verb: 'reported', text: `the result · the task is ${status}`, task: ctx.task.number, said: summary, needs: status === 'Review' });
      return text(`The task is ${status}.`);
    }),
  ]);
}

/** `work_in`: the one checkout of a granted repository a run may open. */
function workIn(ctx: WorkerToolContext): Tool {
  let opened: string | undefined;
  return tool('work_in', 'Open your checkout of a granted repository to change its files. Once per run, one repository. Returns the folder; use your file tools there. The harness commits, pushes a branch and opens a pull request in that repository that points at this task.', {
    repo: z.string().min(3).max(140).describe('owner/name, from list_granted_repos'),
  }, async ({ repo }) => {
    if (opened) return text(`you already work in ${opened}; one repository per run. Finish this task and ask for another task for the next repository.`, true);
    const no = refusal(ctx, repo);
    if (no) return text(no, true);
    try {
      const ws = await ctx.openRepo!(repo);
      opened = repo;
      ctx.log(`works in ${repo} at ${ws.dir} on ${ws.branch}`);
      ctx.event?.({ verb: 'opened', text: `${repo} on ${ws.branch}`, task: ctx.task.number });
      return text(`Your checkout of ${repo} is ${ws.dir}, on the branch ${ws.branch}. Read and edit files there with your file tools, under the same folders you have at home. You do not commit or push; when you finish, the harness commits what changed, pushes the branch and opens a pull request in ${repo} that points at this task.${ws.note ? ` Note: ${ws.note}.` : ''}`);
    } catch (e) {
      const why = (e as Error).message.split('\n')[0];
      ctx.log(`could not open ${repo}: ${why}`);
      return text(`could not open ${repo}: ${why}`, true);
    }
  }) as Tool;
}

export interface DirectorToolContext {
  inbox: Task[];
  store: TaskStore;
  org: Organization;
  node: string;
  log: (t: string) => void;
  event?: ToolEvent;
}

export function directorTools(ctx: DirectorToolContext): Tool[] {
  const find = (number: number): Task | undefined => ctx.inbox.find((t) => t.number === number);
  const sign = (body: string): string => `${body}\n\n<sub>${ctx.org.director.name} on ${ctx.node}</sub>`;
  return asTools([
    tool('list_inbox', 'List the tasks waiting for assignment.', {}, async () => {
      return text(JSON.stringify(ctx.inbox.map((t) => ({ number: t.number, title: t.title, body: t.body.slice(0, 2000), url: t.url })), null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('assign_task', 'Give an inbox task to an agent of the organization, with a short note on what you expect.', {
      number: z.number().int().positive(),
      agent: z.string(),
      note: z.string().max(4000).optional(),
    }, async ({ number, agent, note }) => {
      const task = find(number);
      if (!task) return text(`#${number} is not in the inbox`, true);
      if (!ctx.org.agents.some((a) => a.name === agent)) return text(`no agent named "${agent}"; the organization has: ${ctx.org.agents.map((a) => a.name).join(', ')}`, true);
      await ctx.store.setAgent(task, agent);
      await ctx.store.comment(task, sign(`**Assigned to ${agent}.**${note ? ` ${note}` : ''}`));
      await ctx.store.setStatus(task, 'Assigned');
      ctx.inbox = ctx.inbox.filter((t) => t.number !== number);
      ctx.log(`assigned #${number} to ${agent}`);
      ctx.event?.({ verb: 'assigned', text: `#${number} to ${agent}`, task: number, ...(note ? { said: note } : {}) });
      return text(`#${number} assigned to ${agent}`);
    }),

    tool('reject_task', 'Reject an inbox task that the organization will not do, with the reason.', {
      number: z.number().int().positive(),
      reason: z.string().min(1).max(4000),
    }, async ({ number, reason }) => {
      const task = find(number);
      if (!task) return text(`#${number} is not in the inbox`, true);
      await ctx.store.comment(task, sign(`**Rejected.** ${reason}`));
      await ctx.store.setStatus(task, 'Rejected');
      ctx.inbox = ctx.inbox.filter((t) => t.number !== number);
      ctx.log(`rejected #${number}`);
      ctx.event?.({ verb: 'rejected', text: `#${number}`, task: number, said: reason });
      return text(`#${number} rejected`);
    }),
  ]);
}
