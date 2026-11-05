import { describe, it, expect } from 'vitest';
import { StateStore, type NodeState } from '../state.js';
import { Fixer } from './fixer.js';
import type { CheckResult } from './index.js';

function store(): StateStore {
  const s: NodeState = {
    node: { id: 'me@laptop', user: 'me', host: 'laptop', folder: '/x', startedAt: '', port: 0, version: 't' },
    org: null, repo: null, preflight: null, leases: [], loops: {}, tasks: [], fix: null, library: [], templates: [], owners: [], chat: { messages: [], busy: false }, log: [],
  };
  const st = new StateStore(s);
  st.log = () => {};
  return st;
}

function waitDone(st: StateStore): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (st.state.fix && !st.state.fix.running) resolve();
    };
    st.on('change', check);
    check();
  });
}

describe('Fixer', () => {
  it('streams the output and spots a GitHub device code', async () => {
    const st = store();
    let rechecked = 0;
    const fixer = new Fixer(st, async () => {}, async () => { rechecked += 1; });
    const check: CheckResult = {
      id: 'gh-auth', title: 'GitHub login', status: 'fail', detail: 'x',
      fix: { description: 'sign in', command: ['node', '-e', "console.error('! One-time code (ABCD-1234) copied to clipboard'); console.log('Open this URL to continue in your web browser: https://github.com/login/device')"] },
    };
    expect(fixer.start(check, {})).toBeUndefined();
    expect(fixer.start(check, {})).toBe('another fix is still running');
    await waitDone(st);
    await new Promise((r) => setTimeout(r, 20));
    expect(st.state.fix?.exitCode).toBe(0);
    expect(st.state.fix?.device).toEqual({ code: 'ABCD-1234', url: 'https://github.com/login/device' });
    expect(st.state.fix?.lines).toHaveLength(2);
    expect(rechecked).toBe(1);
  });

  it('fills placeholders and refuses bad values', async () => {
    const st = store();
    const fixer = new Fixer(st, async () => {}, async () => {});
    const check: CheckResult = {
      id: 'git-name', title: 'git name', status: 'fail', detail: 'x',
      fix: { description: 'set it', command: ['node', '-e', 'console.log(process.argv[1])', '<name>'] },
    };
    expect(() => fixer.start(check, { name: '-rf' })).toThrow(/name/);
    expect(() => fixer.start(check, {})).toThrow(/name/);
    expect(fixer.start(check, { name: 'Eugene S' })).toBeUndefined();
    await waitDone(st);
    expect(st.state.fix?.command).toEqual(['node', '-e', 'console.log(process.argv[1])', 'Eugene S']);
    expect(st.state.fix?.lines).toEqual(['Eugene S']);
  });

  it('runs the tool\'s own commands in-process and refuses terminal-only fixes', async () => {
    const st = store();
    const seen: string[][] = [];
    const fixer = new Fixer(st, async (args, log) => { seen.push(args); log('wrote 3 files'); }, async () => {});
    const terminal: CheckResult = { id: 'node', title: 'Node', status: 'fail', detail: 'x', fix: { description: 'nvm', command: ['nvm', 'install', '22'], terminal: true } };
    expect(fixer.start(terminal, {})).toMatch(/terminal/);
    const own: CheckResult = { id: 'org', title: 'Org', status: 'fail', detail: 'x', fix: { description: 'init', command: ['agentic-loop', 'init', '/tmp/o'] } };
    expect(fixer.start(own, {})).toBeUndefined();
    await waitDone(st);
    expect(seen).toEqual([['init', '/tmp/o']]);
    expect(st.state.fix?.lines).toEqual(['wrote 3 files']);
    expect(st.state.fix?.exitCode).toBe(0);
  });
});
