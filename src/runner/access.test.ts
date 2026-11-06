import { describe, it, expect } from 'vitest';
import { checkAccess, normalizeFolder, describeAccess, DEFAULT_ACCESS, type Access } from './access.js';

const cwd = '/work/task-1';

describe('normalizeFolder', () => {
  it('maps the ways of saying everything to the root and rejects escapes', () => {
    expect(normalizeFolder('.')).toBe('');
    expect(normalizeFolder('**')).toBe('');
    expect(normalizeFolder('/')).toBe('');
    expect(normalizeFolder('docs/')).toBe('docs');
    expect(normalizeFolder('./docs/notes')).toBe('docs/notes');
    expect(normalizeFolder('../x')).toBeUndefined();
    expect(normalizeFolder('/etc')).toBeUndefined();
    expect(normalizeFolder('docs/*.md')).toBeUndefined();
    expect(normalizeFolder(3)).toBeUndefined();
  });
});

describe('checkAccess', () => {
  const a: Access = { read: ['docs', 'policy'], write: ['docs/notes'] };

  it('lets non-file tools through', () => {
    expect(checkAccess('WebFetch', { url: 'x' }, cwd, a)).toEqual({ ok: true });
    expect(checkAccess('mcp__ledger__finish', {}, cwd, a)).toEqual({ ok: true });
  });

  it('reads only inside the read and write folders', () => {
    expect(checkAccess('Read', { file_path: '/work/task-1/docs/a.md' }, cwd, a).ok).toBe(true);
    expect(checkAccess('Read', { file_path: 'policy/x.md' }, cwd, a).ok).toBe(true);
    expect(checkAccess('Read', { file_path: 'docs/notes/n.md' }, cwd, a).ok).toBe(true);
    const no = checkAccess('Read', { file_path: 'src/index.ts' }, cwd, a);
    expect(no.ok).toBe(false);
    expect(no).toMatchObject({ reason: expect.stringContaining('src/index.ts is not in it') });
  });

  it('writes only inside the write folders', () => {
    expect(checkAccess('Write', { file_path: 'docs/notes/new.md' }, cwd, a).ok).toBe(true);
    expect(checkAccess('Edit', { file_path: 'docs/notes/new.md' }, cwd, a).ok).toBe(true);
    expect(checkAccess('Write', { file_path: 'docs/a.md' }, cwd, a).ok).toBe(false);
    expect(checkAccess('NotebookEdit', { notebook_path: 'policy/x.ipynb' }, cwd, a).ok).toBe(false);
    expect(checkAccess('Write', {}, cwd, a).ok).toBe(false);
  });

  it('never leaves the checkout or enters .git, whatever the access', () => {
    const all: Access = { read: [''], write: [''] };
    expect(checkAccess('Read', { file_path: '/etc/passwd' }, cwd, all).ok).toBe(false);
    expect(checkAccess('Read', { file_path: '../other/x' }, cwd, all).ok).toBe(false);
    expect(checkAccess('Write', { file_path: '.git/config' }, cwd, all).ok).toBe(false);
    expect(checkAccess('Read', { file_path: '.github/workflows/a.yml' }, cwd, all).ok).toBe(true);
  });

  it('treats a missing path for Glob, Grep and LS as the checkout root', () => {
    expect(checkAccess('Glob', { pattern: '**/*.md' }, cwd, a).ok).toBe(false);
    expect(checkAccess('Glob', { pattern: '**/*.md', path: 'docs' }, cwd, a).ok).toBe(true);
    expect(checkAccess('Glob', { pattern: '../**/*.md', path: 'docs' }, cwd, a).ok).toBe(false);
    expect(checkAccess('Grep', { pattern: 'x' }, cwd, DEFAULT_ACCESS).ok).toBe(true);
    expect(checkAccess('LS', { path: 'policy' }, cwd, a).ok).toBe(true);
  });

  it('describes itself for the prompt and the page', () => {
    expect(describeAccess(DEFAULT_ACCESS)).toBe('read everything, write nothing');
    expect(describeAccess(a)).toBe('read docs/, policy/, docs/notes/, write docs/notes/');
    expect(describeAccess({ read: [''], write: ['notes'] })).toBe('read everything, write notes/');
  });
});

describe('checkAccess with a second checkout', () => {
  const a: Access = { read: [''], write: ['src'] };
  const repo = '/work/task-1-api';

  it('applies the same folders inside the granted checkout and denies everything between', () => {
    expect(checkAccess('Read', { file_path: '/work/task-1-api/pom.xml' }, cwd, a, [repo]).ok).toBe(true);
    expect(checkAccess('Write', { file_path: '/work/task-1-api/src/Main.java' }, cwd, a, [repo]).ok).toBe(true);
    expect(checkAccess('Write', { file_path: '/work/task-1-api/pom.xml' }, cwd, a, [repo]).ok).toBe(false);
    expect(checkAccess('Read', { file_path: '/work/task-1-api/.git/config' }, cwd, a, [repo]).ok).toBe(false);
    expect(checkAccess('Read', { file_path: '/work/other/x' }, cwd, a, [repo])).toMatchObject({ ok: false, reason: expect.stringContaining('outside your checkouts') });
    expect(checkAccess('Read', { file_path: '/work/task-1-api/pom.xml' }, cwd, a).ok).toBe(false);
  });
});
