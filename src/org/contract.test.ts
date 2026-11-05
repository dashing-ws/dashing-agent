import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadOrganization, isKillSwitchOn, parseConfig } from './contract.js';

const AGENT = `---
name: director
role: Director
tools: [Read]
---
You direct.
`;

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-org-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

describe('organization paths', () => {
  it('reads the default folders', async () => {
    await put('agentic-loop.yaml', 'name: t\ndirector: director\n');
    await put('agents/director.md', AGENT);
    await put('control/.gitkeep', '');
    const { org, problems } = await loadOrganization(dir);
    expect(problems).toEqual([]);
    expect(org?.config.paths).toEqual({ agents: 'agents', actions: 'actions', control: 'control' });
    expect(org?.director.file).toBe('agents/director.md');
  });

  it('reads the folders named under paths', async () => {
    await put('agentic-loop.yaml', 'name: t\ndirector: director\npaths:\n  agents: org/people/\n  actions: ./harness/actions\n  control: ops/control\n');
    await put('org/people/director.md', AGENT);
    await put('harness/actions/echo/manifest.yaml', 'name: echo\ndescription: e\n');
    await put('harness/actions/echo/run.sh', 'echo hi\n');
    await put('ops/control/.gitkeep', '');
    const { org, problems } = await loadOrganization(dir);
    expect(problems).toEqual([]);
    expect(org?.config.paths).toEqual({ agents: 'org/people', actions: 'harness/actions', control: 'ops/control' });
    expect(org?.director.file).toBe('org/people/director.md');
    expect(org?.actions.map((a) => a.name)).toEqual(['echo']);
    expect(await isKillSwitchOn(dir, org!.config.paths.control)).toBe(false);
    await put('ops/control/kill', '');
    expect(await isKillSwitchOn(dir, org!.config.paths.control)).toBe(true);
    expect(await isKillSwitchOn(dir)).toBe(false);
  });

  it('names the missing folder by its configured path', async () => {
    await put('agentic-loop.yaml', 'name: t\ndirector: director\npaths:\n  agents: org/people\n');
    const { org, problems } = await loadOrganization(dir);
    expect(org).toBeUndefined();
    expect(problems.join('\n')).toContain('org/people/ is missing');
    expect(problems.join('\n')).toContain('control/ is missing');
  });

  it('rejects paths that leave the organization', () => {
    const problems: string[] = [];
    const c = parseConfig('name: t\ndirector: d\npaths:\n  agents: ../elsewhere\n  actions: /abs\n', problems);
    expect(c?.paths).toEqual({ agents: 'agents', actions: 'actions', control: 'control' });
    expect(problems).toHaveLength(2);
  });
});

describe('agent access', () => {
  it('defaults to read everything, write nothing, and reads the access block', async () => {
    await put('agentic-loop.yaml', 'name: t\ndirector: director\n');
    await put('agents/director.md', AGENT);
    await put('agents/writer.md', '---\nname: writer\ntools: [Read, Write]\naccess:\n  read: [docs/, policy]\n  write: [docs/notes/]\n---\nWrite.\n');
    await put('control/.gitkeep', '');
    const { org, problems } = await loadOrganization(dir);
    expect(problems).toEqual([]);
    expect(org?.director.access).toEqual({ read: [''], write: [] });
    expect(org?.agents.find((a) => a.name === 'writer')?.access).toEqual({ read: ['docs', 'policy'], write: ['docs/notes'] });
  });

  it('refuses Bash without everything and folders that leave the repository', async () => {
    await put('agentic-loop.yaml', 'name: t\ndirector: director\n');
    await put('agents/director.md', AGENT);
    await put('agents/coder.md', '---\nname: coder\ntools: [Read, Bash]\naccess:\n  write: [src, ../other]\n---\nCode.\n');
    await put('control/.gitkeep', '');
    const { org, problems } = await loadOrganization(dir);
    expect(org).toBeUndefined();
    expect(problems.join('\n')).toContain('Bash reaches every file');
    expect(problems.join('\n')).toContain('"../other"');
  });

  it('accepts Bash when the agent is given everything', async () => {
    await put('agentic-loop.yaml', 'name: t\ndirector: director\n');
    await put('agents/director.md', AGENT);
    await put('agents/coder.md', '---\nname: coder\ntools: [Read, Bash]\naccess:\n  read: [.]\n  write: [.]\n---\nCode.\n');
    await put('control/.gitkeep', '');
    const { org, problems } = await loadOrganization(dir);
    expect(problems).toEqual([]);
    expect(org?.agents.find((a) => a.name === 'coder')?.access).toEqual({ read: [''], write: [''] });
  });
});

describe('logo', () => {
  it('reads an emoji or an image file inside the organization', () => {
    expect(parseConfig('name: t\ndirector: d\nlogo: 🏢\n', [])?.logo).toBe('🏢');
    expect(parseConfig('name: t\ndirector: d\nlogo: avatars/logo.png\n', [])?.logo).toBe('avatars/logo.png');
    expect(parseConfig('name: t\ndirector: d\n', [])?.logo).toBeUndefined();
    const problems: string[] = [];
    parseConfig('name: t\ndirector: d\nlogo: ../logo.png\n', problems);
    expect(problems).toEqual([expect.stringContaining('logo')]);
  });
});

describe('the old config file name', () => {
  it('still loads, says which name it found, and yields to the new name', async () => {
    await put('dashing.yaml', 'name: t\ndirector: director\n');
    await put('agents/director.md', AGENT);
    await put('control/.gitkeep', '');
    const { org, problems } = await loadOrganization(dir);
    expect(problems).toEqual([]);
    expect(org?.configFile).toBe('dashing.yaml');
    await put('agentic-loop.yaml', 'name: new\ndirector: director\n');
    const again = await loadOrganization(dir);
    expect(again.org?.configFile).toBe('agentic-loop.yaml');
    expect(again.org?.config.name).toBe('new');
  });
});
