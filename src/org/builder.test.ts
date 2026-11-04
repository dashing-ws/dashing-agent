import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../util/exec.js';
import { loadLibrary } from './library.js';
import { buildOrganization } from './builder.js';
import { loadOrganization } from './contract.js';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dashing-build-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the agent library', () => {
  it('loads every shipped agent, director first and required', async () => {
    const lib = await loadLibrary();
    expect(lib.length).toBeGreaterThanOrEqual(8);
    expect(lib[0]?.name).toBe('rigel');
    expect(lib[0]?.required).toBe(true);
    expect(lib.filter((a) => a.required).map((a) => a.name)).toEqual(['rigel']);
    for (const a of lib) {
      expect(a.avatar, a.name).toBeTruthy();
      expect(a.description, a.name).toBeTruthy();
      expect(a.prompt.length, a.name).toBeGreaterThan(100);
      expect(a.tools.includes('Bash'), a.name).toBe(false);
    }
  });
});

describe('buildOrganization', () => {
  it('writes the chosen agents, makes a repository with one commit, and loads as an organization', async () => {
    const lines: string[] = [];
    const folder = path.join(root, 'marketing');
    const built = await buildOrganization({ folder, name: 'marketing', repo: '', director: 'rigel', agents: ['vega', 'altair'] }, (l) => lines.push(l));
    expect(built.folder).toBe(folder);
    expect(built.remote).toBeUndefined();
    const { org, problems } = await loadOrganization(folder);
    expect(problems).toEqual([]);
    expect(org?.config.name).toBe('marketing');
    expect(org?.agents.map((a) => a.name)).toEqual(['altair', 'rigel', 'vega']);
    expect(org?.director.avatar).toBeTruthy();
    const log = await run('git', ['log', '--oneline'], { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x' } });
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
    expect(log.stdout).toContain('organization marketing');
    expect((await run('git', ['status', '--porcelain'], { cwd: folder })).stdout.trim()).toBe('');
    expect(lines.join('\n')).toContain('no GitHub repository named');
  });

  it('refuses bad names, unknown agents and a folder that already is an organization', async () => {
    const log = (): void => {};
    await expect(buildOrganization({ folder: path.join(root, 'x'), name: 'Bad Name', repo: '' }, log)).rejects.toThrow(/lowercase/);
    await expect(buildOrganization({ folder: path.join(root, 'x'), name: 'x', repo: '', agents: ['nobody'] }, log)).rejects.toThrow(/not in the library: nobody/);
    await expect(buildOrganization({ folder: path.join(root, 'x'), name: 'x', repo: 'not-a-repo' }, log)).rejects.toThrow(/owner\/name/);
    await expect(buildOrganization({ folder: path.join(root, 'marketing'), name: 'again', repo: '' }, log)).rejects.toThrow(/already holds an organization/);
  });
});

describe('templates and copying agents from another organization', () => {
  it('ships templates whose agents exist in the library', async () => {
    const { loadTemplates } = await import('./library.js');
    const lib = await loadLibrary();
    const templates = await loadTemplates(lib);
    expect(templates.map((t) => t.name)).toEqual(['operations', 'runtime-team', 'writing-room']);
    for (const t of templates) expect(t.agents).toContain(t.director);
  });

  it('ships the runtime team with image avatars and groups, and every agent with a portrait', async () => {
    const { loadTemplates } = await import('./library.js');
    const lib = await loadLibrary();
    const crew = (await loadTemplates(lib)).find((t) => t.name === 'runtime-team')!.agents;
    const team = lib.filter((a) => crew.includes(a.name) && a.name !== 'polaris');
    expect(team.map((a) => a.name).sort()).toEqual(['alnilam', 'alnitak', 'bellatrix', 'betelgeuse', 'hatsya', 'meissa', 'mintaka', 'nebula', 'rigel', 'saiph', 'sirius', 'tabit']);
    for (const a of team) expect(a.group, a.name).toMatch(/^(leadership|change|production|assurance)$/);
    for (const a of lib) {
      expect(a.group, a.name).toBeTruthy();
      expect(a.avatarFile, a.name).toBeTruthy();
      expect(a.avatar, a.name).toBe(`avatars/${a.name}.png`);
    }
  });

  it('builds the runtime team with Rigel as Director and the portrait files copied in', async () => {
    const folder = path.join(root, 'runtime');
    await buildOrganization({ folder, name: 'runtime', repo: '', template: 'runtime-team' }, () => {});
    const { org, problems } = await loadOrganization(folder);
    expect(problems).toEqual([]);
    expect(org?.director.name).toBe('rigel');
    expect(org?.agents).toHaveLength(13);
    await expect(fs.stat(path.join(folder, 'avatars', 'rigel.png'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(folder, 'avatars', 'sirius.png'))).resolves.toBeTruthy();
  });

  it('builds from a template and adds the agents of another organization, avatars included', async () => {
    const source = path.join(root, 'source-org');
    await fs.mkdir(path.join(source, 'team'), { recursive: true });
    await fs.mkdir(path.join(source, 'avatars'), { recursive: true });
    await fs.writeFile(path.join(source, 'dashing.yaml'), 'name: source\ndirector: kappa\npaths:\n  agents: team\n');
    await fs.writeFile(path.join(source, 'team', 'kappa.md'), '---\nname: kappa\nrole: Writer\navatar: avatars/kappa.png\ntools: [Read, Write]\naccess:\n  write: [docs]\n---\nYou are Kappa, a writer.\n');
    await fs.writeFile(path.join(source, 'team', 'lambda.md'), '---\nname: lambda\nrole: Writer\navatar: "⭐"\ntools: [Read]\n---\nYou are Lambda, another writer.\n');
    await fs.writeFile(path.join(source, 'avatars', 'kappa.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const lines: string[] = [];
    const folder = path.join(root, 'from-template');
    await buildOrganization({ folder, name: 'from-template', repo: '', template: 'writing-room', from: source }, (l) => lines.push(l));
    const { org, problems } = await loadOrganization(folder);
    expect(problems).toEqual([]);
    expect(org?.agents.map((a) => a.name)).toEqual(['altair', 'bellatrix', 'kappa', 'lambda', 'polaris', 'rigel', 'vega']);
    expect(org?.director.name).toBe('rigel');
    expect(org?.agents.find((a) => a.name === 'kappa')?.avatar).toBe('avatars/kappa.png');
    await expect(fs.stat(path.join(folder, 'avatars', 'kappa.png'))).resolves.toBeTruthy();
    expect(lines.join('\n')).toContain('copied 2 agents');
  });

  it('refuses an unknown template and a source without agents', async () => {
    const log = (): void => {};
    await expect(buildOrganization({ folder: path.join(root, 'y'), name: 'y', repo: '', template: 'nope' }, log)).rejects.toThrow(/no template nope/);
    await fs.mkdir(path.join(root, 'empty-source'), { recursive: true });
    await expect(buildOrganization({ folder: path.join(root, 'y'), name: 'y', repo: '', from: path.join(root, 'empty-source') }, log)).rejects.toThrow(/no agents\/ folder/);
  });
});
