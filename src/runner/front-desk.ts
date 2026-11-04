import path from 'node:path';
import type { AgentSpec, Organization } from '../org/contract.js';
import type { Task, TaskStore } from '../github/task-store.js';
import type { StateStore, ChatMessage } from '../state.js';
import { runAgent } from './agent-runner.js';
import { chatTools } from './chat-tools.js';
import { trackRun } from '../loops/run-tracker.js';

/**
 * The chat on the page. Each message runs the front desk agent once, with the recent conversation
 * in the prompt and the chat tools as its only tools. The conversation lives on this laptop; what
 * it files lives on GitHub like every other task.
 */

export interface FrontDeskDeps {
  state: StateStore;
  store: TaskStore;
  org: () => Organization;
  /** The agent that answers: the organization's own `front-desk` when it has one, else the library's. */
  agent: () => AgentSpec;
  node: string;
  auditDir: string;
  onFiled: (task: Task) => void;
}

const HISTORY = 12;
const MAX_MESSAGES = 60;
const MAX_TEXT = 4000;

export class FrontDesk {
  private busy = false;

  constructor(private readonly d: FrontDeskDeps) {}

  /** Sends one message. Returns the reason when it cannot. */
  send(raw: string): string | undefined {
    const text = raw.trim();
    if (!text) return 'say something first';
    if (text.length > MAX_TEXT) return `keep it under ${MAX_TEXT} characters`;
    if (this.busy) return 'the front desk is still answering';
    this.busy = true;
    this.push({ role: 'you', text, at: new Date().toISOString() });
    this.d.state.update((s) => {
      s.chat.busy = true;
    });
    void this.answer(text).finally(() => {
      this.busy = false;
      this.d.state.update((s) => {
        s.chat.busy = false;
      });
    });
    return undefined;
  }

  private push(m: ChatMessage): void {
    this.d.state.update((s) => {
      s.chat.messages.push(m);
      if (s.chat.messages.length > MAX_MESSAGES) s.chat.messages.splice(0, s.chat.messages.length - MAX_MESSAGES);
    });
  }

  private async answer(text: string): Promise<void> {
    const { state, store, node } = this.d;
    const org = this.d.org();
    const agent = this.d.agent();
    const history = state.state.chat.messages.slice(-HISTORY - 1, -1).filter((m) => m.role !== 'note');
    const log = (t: string): void => state.info(t, 'chat');
    const calls: string[] = [];
    const tools = chatTools({
      store, org, node,
      log: (t) => { calls.push(t); log(t); },
      event: (e) => state.event({ who: agent.name, ...e, text: `${e.text} · for ${node.split('@')[0]}` }),
      onFiled: this.d.onFiled,
    });
    const prompt = [
      history.length ? `The conversation so far, oldest first:\n${history.map((m) => `${m.role === 'you' ? 'Person' : 'Front desk'}: ${m.text}`).join('\n')}\n` : '',
      `The person now says:\n${text}`,
      '',
      'Answer them. Facts come from your tools; file a task only when they ask for work to be done.',
    ].join('\n');
    const budgets = { maxTurns: 12, maxBudgetUsd: org.config.budgets.maxBudgetUsd, timeoutMinutes: 3 };
    const chatOrg: Organization = { ...org, config: { ...org.config, budgets } };
    const auditFile = path.join(this.d.auditDir, 'chat', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    try {
      const watch = trackRun(state, { id: 'chat', who: agent.name, title: 'the chat on this page', cwd: org.dir });
      const out = await runAgent({ agent, org: chatOrg, prompt, cwd: org.dir, node, tools, auditFile, label: 'chat', log, observer: { tool: watch.tool, ended: watch.ended } });
      const answer = out.outcome === 'success' ? out.text || '(no answer)' : `(the front desk stopped: ${out.outcome}${out.text ? `: ${out.text}` : ''})`;
      this.push({ role: 'desk', text: answer, at: new Date().toISOString(), costUsd: out.costUsd, ...(calls.length ? { did: calls } : {}) });
    } catch (e) {
      this.push({ role: 'note', text: `the front desk failed: ${(e as Error).message.split('\n')[0]}`, at: new Date().toISOString() });
    }
  }
}
