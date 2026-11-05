import fs from 'node:fs/promises';
import path from 'node:path';
import { query, createSdkMcpServer, type Options, type HookCallback, type SdkMcpToolDefinition, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSpec, Organization } from '../org/contract.js';
import { HANDLERS } from '../mechanical/plan.js';
import { checkAccess, describeAccess } from './access.js';

/**
 * One run = one agent on one prompt through the Claude Agent SDK, on this laptop's Claude login.
 * The harness decides what the agent can touch: only the built-in tools its spec lists and the
 * ledger tools this run was given. A PreToolUse hook denies everything else and writes every
 * call to the audit file. The run is bounded by turns, cost and wall clock.
 */

export const VERSION = '0.1.0';

export interface RunSpec {
  agent: AgentSpec;
  org: Organization;
  prompt: string;
  cwd: string;
  node: string;
  /** In-process ledger tools (served as MCP server "ledger"). */
  tools: SdkMcpToolDefinition<any>[];
  auditFile: string;
  label: string;
  log: (text: string) => void;
  abort?: AbortController;
  /** Where the agent works and what happens to its files; goes into the harness prompt. */
  workNote?: string;
  /** Watches the run for the page: the start, every tool call, what the agent says, the end. */
  observer?: RunObserver;
}

/** What a run reports as it goes. `turns` counts the model's replies so far. */
export interface RunObserver {
  started?: (info: { model: string; tools: number; maxTurns: number; maxBudgetUsd: number }) => void;
  tool?: (call: { name: string; input: unknown; ok: boolean; reason?: string; turns: number; toolCalls: number; denied: number }) => void;
  said?: (text: string, turns: number) => void;
  ended?: (out: RunOutcome) => void;
}

export type Outcome = 'success' | 'max_turns' | 'max_budget' | 'error' | 'aborted' | 'timeout';

export interface RunOutcome {
  outcome: Outcome;
  text: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  toolCalls: number;
  denied: number;
  sessionId?: string;
}

const ALWAYS_DENIED = ['Bash(git push*)', 'Bash(sudo *)', 'Bash(rm -rf *)', 'Bash(gh auth*)'];

export function harnessPrompt(agent: AgentSpec, org: Organization, ledgerNames: string[], workNote?: string): string {
  const roster = org.agents.map((a) => `- ${a.name}: ${a.role}${a.description ? ` (${a.description})` : ''}`).join('\n');
  return [
    agent.prompt.trim(),
    '',
    '## How you run (from the Agentic Loop harness)',
    `You are "${agent.name}" (${agent.role}) in the organization "${org.config.name}". You run unattended on a laptop; nobody answers questions during a run, so decide and act.`,
    `You never execute changes in the world yourself: you read, think, write files in your working folder, and leave results on the task through the ledger tools (${ledgerNames.join(', ')}). Anything that must happen outside is a plan with steps from this catalog: ${Object.entries(HANDLERS).map(([k, v]) => `${k} (${v})`).join('; ')}. A human approves plans.`,
    `Your folders: ${describeAccess(agent.access)}. Paths outside them, outside your checkout, and .git are denied; give Glob and Grep a path inside your folders.`,
    'Tool calls outside your allowance are denied and logged; do not retry them. System reminders come from the harness. Finish by calling the ledger tool that closes your work.',
    ...(workNote ? [workNote] : []),
    '',
    'The organization:',
    roster,
  ].join('\n');
}

export async function runAgent(spec: RunSpec): Promise<RunOutcome> {
  const { agent, org } = spec;
  const ledgerNames = spec.tools.map((t) => `mcp__ledger__${t.name}`);
  const allowed = new Set<string>([...agent.tools, ...ledgerNames]);
  const started = Date.now();
  let toolCalls = 0;
  let denied = 0;
  let turns = 0;
  let sessionId: string | undefined;
  const watch = spec.observer ?? {};
  await fs.mkdir(path.dirname(spec.auditFile), { recursive: true });

  const audit = async (record: Record<string, unknown>): Promise<void> => {
    await fs.appendFile(spec.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  };

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const name = input.tool_name;
    const verdict = allowed.has(name) ? checkAccess(name, input.tool_input, spec.cwd, agent.access) : { ok: false as const, reason: `${name} is not in your tools` };
    const ok = verdict.ok;
    toolCalls += 1;
    if (!ok) denied += 1;
    await audit({ event: 'tool', name, ok, ...(ok ? {} : { reason: verdict.reason }), input: input.tool_input });
    watch.tool?.({ name, input: input.tool_input, ok, ...(ok ? {} : { reason: verdict.reason }), turns, toolCalls, denied });
    if (ok) {
      spec.log(`→ ${name}`);
      return {};
    }
    spec.log(`✗ ${name} (denied: ${verdict.reason})`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: allowed.has(name) ? verdict.reason : `${agent.name} may use only: ${[...allowed].join(', ')}`,
      },
    };
  };

  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const r = (input as { tool_response?: unknown }).tool_response;
    const summary = typeof r === 'string' ? r.slice(0, 500) : JSON.stringify(r ?? null).slice(0, 500);
    await audit({ event: 'tool-result', name: input.tool_name, result: summary });
    return {};
  };

  const abort = spec.abort ?? new AbortController();
  const timeoutMs = org.config.budgets.timeoutMinutes * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);

  const options: Options = {
    cwd: spec.cwd,
    model: agent.model ?? org.config.model,
    systemPrompt: harnessPrompt(agent, org, ledgerNames, spec.workNote),
    tools: agent.tools,
    allowedTools: [...agent.tools, ...ledgerNames],
    disallowedTools: ALWAYS_DENIED,
    permissionMode: 'dontAsk',
    mcpServers: { ledger: createSdkMcpServer({ name: 'ledger', version: VERSION, tools: spec.tools }) },
    maxTurns: org.config.budgets.maxTurns,
    maxBudgetUsd: org.config.budgets.maxBudgetUsd,
    settingSources: [],
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `agentic-loop/${VERSION}` },
    abortController: abort,
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
    },
    ...(process.env.AGENTIC_LOOP_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.AGENTIC_LOOP_CLAUDE_PATH } : {}),
  };

  await audit({
    event: 'start', label: spec.label, agent: agent.name, model: options.model, node: spec.node, cwd: spec.cwd,
    tools: [...allowed], maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, timeoutMinutes: org.config.budgets.timeoutMinutes,
  });
  spec.log(`run ${spec.label}: ${agent.name} on ${options.model}, ${allowed.size} tools, ${options.maxTurns} turns max`);
  watch.started?.({ model: options.model ?? '', tools: allowed.size, maxTurns: options.maxTurns ?? 0, maxBudgetUsd: options.maxBudgetUsd ?? 0 });

  let result: SDKResultMessage | undefined;
  let lastText = '';
  let error: string | undefined;
  try {
    for await (const m of query({ prompt: spec.prompt, options })) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
      } else if (m.type === 'assistant') {
        turns += 1;
        const blocks = (m.message.content ?? []) as Array<{ type: string; text?: string; name?: string }>;
        for (const b of blocks) {
          if (b.type === 'text' && b.text?.trim()) {
            lastText = b.text.trim();
            spec.log(`${agent.name}: ${lastText.slice(0, 160).replace(/\s+/g, ' ')}${lastText.length > 160 ? '…' : ''}`);
            watch.said?.(lastText, turns);
          }
        }
      } else if (m.type === 'result') {
        result = m;
      }
    }
  } catch (e) {
    error = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - started;
  let outcome: Outcome;
  let text = lastText;
  if (timedOut) outcome = 'timeout';
  else if (abort.signal.aborted) outcome = 'aborted';
  else if (result?.subtype === 'success') {
    outcome = result.is_error ? 'error' : 'success';
    text = result.result || lastText;
  } else if (result?.subtype === 'error_max_turns') outcome = 'max_turns';
  else if (result?.subtype === 'error_max_budget_usd') outcome = 'max_budget';
  else outcome = 'error';
  if (outcome === 'error') {
    const errors = result && 'errors' in result ? ((result as { errors?: string[] }).errors ?? []).join('; ') : '';
    text = [text, errors, error].filter(Boolean).join('\n') || 'unknown error';
  }

  const out: RunOutcome = {
    outcome,
    text,
    costUsd: result?.total_cost_usd ?? 0,
    turns: result?.num_turns ?? 0,
    durationMs,
    toolCalls,
    denied,
    ...(sessionId ? { sessionId } : {}),
  };
  await audit({ event: 'end', ...out, text: out.text.slice(0, 2000) });
  spec.log(`run ${spec.label}: ${outcome} after ${out.turns} turns, ${(durationMs / 1000).toFixed(0)}s, ~$${out.costUsd.toFixed(3)}, ${toolCalls} tool calls (${denied} denied)`);
  watch.ended?.(out);
  return out;
}
