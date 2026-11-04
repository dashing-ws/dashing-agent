import { describe, it, expect } from 'vitest';
import { describeToolCall, describeDenied } from './narrate.js';

const cwd = '/work/task-7';

describe('tool calls in plain words', () => {
  it('names files relative to the checkout', () => {
    expect(describeToolCall('Read', { file_path: '/work/task-7/docs/plan.md' }, cwd)).toEqual({ verb: 'read', text: 'docs/plan.md', now: 'reading docs/plan.md' });
    expect(describeToolCall('Write', { file_path: 'notes/a.md' }, cwd)?.verb).toBe('wrote');
    expect(describeToolCall('Edit', { file_path: '/elsewhere/x.md' }, cwd)?.text).toBe('/elsewhere/x.md');
  });

  it('shortens commands and quotes searches', () => {
    const long = 'x'.repeat(200);
    expect(describeToolCall('Bash', { command: long }, cwd)?.text.length).toBe(90);
    expect(describeToolCall('Grep', { pattern: 'TODO', path: '/work/task-7/src' }, cwd)).toEqual({ verb: 'searched for', text: '“TODO” in src', now: 'searching for “TODO” in src' });
    expect(describeToolCall('WebSearch', { query: 'node 22 release' }, cwd)?.text).toBe('the web for “node 22 release”');
  });

  it('keeps quiet about ledger tools that report themselves', () => {
    expect(describeToolCall('mcp__ledger__post_update', { note: 'hi' }, cwd)).toBeUndefined();
    expect(describeToolCall('mcp__ledger__assign_task', {}, cwd)).toBeUndefined();
    expect(describeToolCall('mcp__ledger__read_task', {}, cwd)?.text).toBe('the task');
    expect(describeToolCall('mcp__ledger__task_status', { number: 4 }, cwd)?.text).toBe('#4');
  });

  it('says what a denied call tried', () => {
    expect(describeDenied('Write', { file_path: '/work/task-7/policy/security.md' }, cwd)).toBe('write to policy/security.md');
    expect(describeDenied('Bash', { command: 'git push origin main' }, cwd)).toBe('run git push origin main');
    expect(describeDenied('WebFetch', { url: 'https://x.y' }, cwd)).toBe('use WebFetch');
  });
});
