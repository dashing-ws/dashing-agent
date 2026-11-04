import type { RunObserver } from '../runner/agent-runner.js';
import { describeDenied, describeToolCall } from '../runner/narrate.js';
import type { StateStore, RunView } from '../state.js';

/**
 * Feeds one run into the node state for the page: a live card while it runs (turns, tool calls,
 * what it does now, what it last said) and one activity line per thing it does. The loop that
 * owns the run reports the start and the end itself, since it knows the task and the outcome.
 */

export interface TrackedRun {
  id: string;
  who: string;
  task?: number;
  title?: string;
  /** The agent's working folder, so file paths read relative to it. */
  cwd: string;
  leaseUntil?: string;
}

const SAID_MAX = 280;

export function trackRun(state: StateStore, run: TrackedRun): RunObserver & { renewed: (until: string) => void } {
  const base = (): RunView => ({
    id: run.id, kind: 'agent', who: run.who, startedAt: new Date().toISOString(), turns: 0, maxTurns: 0, toolCalls: 0, denied: 0, maxBudgetUsd: 0,
    ...(run.task ? { task: run.task } : {}), ...(run.title ? { title: run.title } : {}), ...(run.leaseUntil ? { leaseUntil: run.leaseUntil } : {}),
  });
  const task = run.task ? { task: run.task } : {};
  return {
    started: (info) => {
      state.run(run.id, () => ({ ...base(), maxTurns: info.maxTurns, maxBudgetUsd: info.maxBudgetUsd, now: 'starting' }));
      state.event({ who: run.who, verb: 'started', text: `on ${info.model} · ${info.tools} tools · ${info.maxTurns} turns max · $${info.maxBudgetUsd} cap`, ...task });
    },
    tool: (call) => {
      if (!call.ok) {
        state.run(run.id, (r) => (r ? { ...r, turns: call.turns, toolCalls: call.toolCalls, denied: call.denied } : r));
        state.event({ who: run.who, verb: 'denied:', text: `${describeDenied(call.name, call.input, run.cwd)} · ${call.reason ?? 'outside its allowance'}`, level: 'warn', ...task });
        return;
      }
      const words = describeToolCall(call.name, call.input, run.cwd);
      state.run(run.id, (r) => (r ? { ...r, turns: call.turns, toolCalls: call.toolCalls, denied: call.denied, ...(words ? { now: words.now } : {}) } : r));
      if (words) state.event({ who: run.who, verb: words.verb, text: words.text, ...task });
    },
    said: (text, turns) => {
      const said = text.length > SAID_MAX ? `${text.slice(0, SAID_MAX - 1)}…` : text;
      state.run(run.id, (r) => (r ? { ...r, turns, said } : r));
      state.event({ who: run.who, verb: 'said', text: '', said, ...task });
    },
    ended: () => {
      state.run(run.id, () => undefined);
    },
    renewed: (until) => {
      state.run(run.id, (r) => (r ? { ...r, leaseUntil: until } : r));
    },
  };
}

/** "11:25" from an ISO time, in the laptop's own time zone. */
export function clock(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
