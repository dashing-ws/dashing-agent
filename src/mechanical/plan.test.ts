import { describe, it, expect } from 'vitest';
import { parsePlanComment, renderPlanComment, validatePlan, latestPlan, type Plan } from './plan.js';
import type { Organization } from '../org/contract.js';

const org = {
  dir: '/tmp/org',
  config: { name: 'test', director: 'dash' },
  agents: [],
  director: {},
  actions: [
    { name: 'echo', description: '', dir: '/tmp/org/actions/echo', timeoutMinutes: 1, params: { message: { type: 'string', required: true, pattern: '^[a-z ]+$' }, times: { type: 'integer', required: false, minimum: 1, maximum: 3 } } },
  ],
} as unknown as Organization;

describe('plan', () => {
  it('round-trips through a comment', () => {
    const plan: Plan = { summary: 'say hi', steps: [{ handler: 'run_script', args: { script: 'echo', params: { message: 'hi' } } }], proposedBy: 'writer', at: '2026-11-03T00:00:00Z' };
    const body = renderPlanComment(plan);
    expect(parsePlanComment(body)).toEqual(plan);
    expect(parsePlanComment('no plan here')).toBeNull();
    expect(latestPlan([{ author: 'a', body: 'x', at: '' }, { author: 'b', body, at: '' }])?.summary).toBe('say hi');
  });

  it('accepts a valid plan', () => {
    const plan: Plan = { summary: '', at: '', proposedBy: '', steps: [
      { handler: 'run_script', args: { script: 'echo', params: { message: 'hello there', times: 2 } } },
      { handler: 'merge_pr', args: { repo: 'dashing-ws/x', pr: 12 } },
      { handler: 'comment', args: { repo: 'dashing-ws/x', number: 3, body: 'done' } },
    ] };
    expect(validatePlan(plan, org)).toEqual([]);
  });

  it('rejects bad steps with reasons', () => {
    const plan: Plan = { summary: '', at: '', proposedBy: '', steps: [
      { handler: 'run_script', args: { script: 'rm-rf', params: {} } },
      { handler: 'run_script', args: { script: 'echo', params: { message: 'HI!', times: 9, extra: 1 } } },
      { handler: 'merge_pr', args: { repo: 'bad', pr: 'x' } },
      { handler: 'shell' as never, args: { cmd: 'kubectl delete' } },
    ] };
    const problems = validatePlan(plan, org);
    expect(problems.some((p) => p.includes('no action named "rm-rf"'))).toBe(true);
    expect(problems.some((p) => p.includes('does not match'))).toBe(true);
    expect(problems.some((p) => p.includes('above 3'))).toBe(true);
    expect(problems.some((p) => p.includes('unknown parameter "extra"'))).toBe(true);
    expect(problems.some((p) => p.includes('owner/name'))).toBe(true);
    expect(problems.some((p) => p.includes('unknown handler "shell"'))).toBe(true);
    expect(validatePlan({ summary: '', at: '', proposedBy: '', steps: [] }, org)).toEqual(['the plan has no steps']);
  });
});
