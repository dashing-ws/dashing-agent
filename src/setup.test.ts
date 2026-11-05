import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeProjectNumber } from './setup.js';
import { parseConfig } from './org/contract.js';

async function roundTrip(text: string, number: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-yaml-'));
  const file = path.join(dir, 'agentic-loop.yaml');
  await fs.writeFile(file, text);
  await writeProjectNumber(file, number);
  const out = await fs.readFile(file, 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return out;
}

describe('writeProjectNumber', () => {
  it('fills a github key that holds only a comment, as the starter file does', async () => {
    const out = await roundTrip('name: t\ndirector: d\ngithub:\n  # project: 1   # filled in by setup\npaths:\n  agents: agents\n', 7);
    const problems: string[] = [];
    expect(parseConfig(out, problems)?.github.project).toBe(7);
    expect(problems).toEqual([]);
    expect(out).toContain('name: t');
    expect(out).toContain('agents: agents');
  });

  it('replaces an existing number and keeps the other keys', async () => {
    const out = await roundTrip('name: t\ndirector: d\ngithub:\n  project: 2\n  other: x\n', 9);
    const problems: string[] = [];
    expect(parseConfig(out, problems)?.github.project).toBe(9);
    expect(out).toContain('other: x');
  });

  it('adds the github key when it is missing', async () => {
    const out = await roundTrip('name: t\ndirector: d\n', 4);
    expect(parseConfig(out, [])?.github.project).toBe(4);
  });
});
