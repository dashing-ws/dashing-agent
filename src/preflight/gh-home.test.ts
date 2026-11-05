import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureGhConfigDir, resetGhConfigDir } from './gh-home.js';

const KEYS = ['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'] as const;
let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-loop-gh-'));
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = root;
  resetGhConfigDir();
});

afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGhConfigDir();
  await fs.chmod(path.join(root, '.config'), 0o700).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

describe('ensureGhConfigDir', () => {
  it('leaves gh alone when its folder can be made', async () => {
    const h = await ensureGhConfigDir();
    expect(h).toEqual({ dir: path.join(root, '.config', 'gh'), moved: false });
    expect(process.env.GH_CONFIG_DIR).toBeUndefined();
  });

  it('respects GH_CONFIG_DIR when the shell set it', async () => {
    process.env.GH_CONFIG_DIR = '/elsewhere/gh';
    expect(await ensureGhConfigDir()).toEqual({ dir: '/elsewhere/gh', moved: false });
  });

  it('points gh at ~/.agentic-loop/gh when ~/.config belongs to someone else', async () => {
    await fs.mkdir(path.join(root, '.config'), { mode: 0o500 });
    const h = await ensureGhConfigDir();
    expect(h.moved).toBe(true);
    expect(h.dir).toBe(path.join(root, '.agentic-loop', 'gh'));
    expect(h.reason).toBe(path.join(root, '.config', 'gh'));
    expect(process.env.GH_CONFIG_DIR).toBe(h.dir);
    await expect(fs.access(h.dir)).resolves.toBeUndefined();
    expect(await ensureGhConfigDir()).toBe(h);
  });
});
