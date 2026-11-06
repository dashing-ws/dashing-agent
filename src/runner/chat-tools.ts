import { z } from 'zod';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Organization } from '../org/contract.js';
import type { Task, TaskStore } from '../github/task-store.js';
import type { Grant } from './grants.js';

/**
 * The tools of the front desk, the agent behind the chat on the page. It can look at the board
 * and file tasks; it cannot touch files, run anything, or move a task along. Everything it files
 * lands in Inbox like any other input, and the Director takes it from there.
 */

type Tool = SdkMcpToolDefinition<any>;

function asTools(tools: unknown[]): Tool[] {
  return tools as Tool[];
}

function text(s: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) };
}

export interface ChatToolContext {
  store: TaskStore;
  org: Organization;
  /** Who is talking: login@host. */
  node: string;
  log: (t: string) => void;
  /** One line for the activity feed when the front desk files or comments. */
  event?: (e: { verb: string; text: string; task?: number }) => void;
  /** Called after a task was filed, so the Director can plan right away. */
  onFiled?: (task: Task) => void;
  /** The organization's own repository (owner/name) and the granted ones, for "what can they reach". */
  own?: string;
  grants?: () => Grant[];
}

export function chatTools(ctx: ChatToolContext): Tool[] {
  const brief = (t: Task): Record<string, unknown> => ({ number: t.number, title: t.title, status: t.status, agent: t.agent ?? null, url: t.url });
  return asTools([
    tool('roster', 'Who works in this organization: each agent, its role and what it does.', {}, async () => {
      return text(JSON.stringify(ctx.org.agents.map((a) => ({ name: a.name, role: a.role, description: a.description, director: a.name === ctx.org.director.name })), null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('list_tasks', 'The tasks on the board with their status and agent. Done and Rejected tasks are left out unless asked for.', {
      all: z.boolean().optional().describe('true to include Done and Rejected tasks'),
    }, async ({ all }) => {
      const tasks = (await ctx.store.list()).filter((t) => all || (t.status !== 'Done' && t.status !== 'Rejected'));
      return text(JSON.stringify(tasks.map(brief), null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('task_status', 'One task in detail: its body and the comments so far (results, plans, reports).', {
      number: z.number().int().positive(),
    }, async ({ number }) => {
      const task = await ctx.store.get(number);
      if (!task) return text(`there is no task #${number}`, true);
      const comments = await ctx.store.comments(task);
      return text(JSON.stringify({ ...brief(task), body: task.body, closed: task.closed ?? false, comments: comments.slice(-8) }, null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('granted_repos', 'The repositories the agents may read and open pull requests in: the organization\'s own, then each granted one with when and by which task it was granted. A person grants or takes one back by asking for a task here.', {}, async () => {
      const grants = ctx.grants?.() ?? [];
      const rows = [
        ...(ctx.own ? [{ repo: ctx.own, note: 'this organization; always' }] : []),
        ...grants.map((g) => ({ repo: g.repo, url: `https://github.com/${g.repo}`, ...(g.granted ? { granted: g.granted } : {}), ...(g.task ? { task: g.task } : {}), ...(g.note ? { note: g.note } : {}) })),
      ];
      return text(JSON.stringify(rows, null, 2));
    }, { annotations: { readOnlyHint: true } }),

    tool('file_task', 'File a new task in Inbox for the Director to assign. The title says what; the body says what was asked and what done looks like.', {
      title: z.string().min(3).max(120),
      body: z.string().min(1).max(8000),
    }, async ({ title, body }) => {
      const task = await ctx.store.create(title, `${body}\n\n<sub>Filed from the chat by ${ctx.node}</sub>`);
      ctx.log(`filed #${task.number}: ${title}`);
      ctx.event?.({ verb: 'filed', text: `#${task.number} ${title}`, task: task.number });
      ctx.onFiled?.(task);
      return text(`Filed #${task.number}: ${task.url}. It is in Inbox; the Director assigns it on the next planning pass.`);
    }),

    tool('comment_task', 'Add a note from the person to a task, for the agent or the humans working on it.', {
      number: z.number().int().positive(),
      note: z.string().min(1).max(4000),
    }, async ({ number, note }) => {
      const task = await ctx.store.get(number);
      if (!task) return text(`there is no task #${number}`, true);
      await ctx.store.comment(task, `**From the chat:** ${note}\n\n<sub>${ctx.node}</sub>`);
      ctx.log(`commented on #${number}`);
      ctx.event?.({ verb: 'passed a note', text: `to #${number}`, task: number });
      return text(`noted on #${number}`);
    }),
  ]);
}
