import { spawn, type ChildProcess } from 'node:child_process';
import type { StateStore, FixView } from '../state.js';
import type { CheckResult } from './index.js';

/**
 * Runs one job from the page and streams its output into the node state: a pre-flight fix, or
 * an in-process job like building an organization. A fix is the command pre-flight attached to a
 * failed check, never free text: the page may only fill the named placeholders. GitHub CLI logins
 * print a one-time device code; the runner spots it so the page can show it with a copy button
 * and the link to github.com/login/device.
 */

export type OwnCommand = (args: string[], log: (line: string) => void) => Promise<void>;
export type Job = (log: (line: string) => void) => Promise<void>;

const MAX_LINES = 200;
const DEVICE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const DEVICE_URL = /https:\/\/\S+\/login\/device\S*/;
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@:/-]{0,199}$/;

export class Fixer {
  private child: ChildProcess | undefined;
  private busy = false;

  constructor(
    private readonly state: StateStore,
    private readonly own: OwnCommand,
    private readonly onDone: () => Promise<void>,
  ) {}

  get running(): boolean {
    return this.busy;
  }

  /** Starts the fix of a check. Returns the reason when it cannot. */
  start(check: CheckResult, values: Record<string, string>): string | undefined {
    if (this.busy) return 'another fix is still running';
    const fix = check.fix;
    if (!fix?.command) return 'this check has no command to run';
    if (fix.terminal) return 'this fix needs a terminal; run the command yourself';
    const command: string[] = [];
    for (const arg of fix.command) {
      const filled = arg.replace(/<([a-z-]+)>/g, (_, key: string) => {
        const v = (values[key] ?? '').trim();
        if (!VALUE_RE.test(v)) throw new Error(`"${key}" must be filled in with letters, digits, dots, slashes or dashes`);
        return v;
      });
      command.push(filled);
    }
    this.launch({ id: check.id, title: check.title, command, lines: [], running: true, startedAt: new Date().toISOString() }, () => this.execute(command));
    return undefined;
  }

  /** Runs an in-process job with the same streaming panel. Returns the reason when it cannot start. */
  startJob(id: string, title: string, job: Job): string | undefined {
    if (this.busy) return 'another job is still running';
    this.launch({ id, title, command: [id], lines: [], running: true, startedAt: new Date().toISOString() }, async () => {
      try {
        await job((l) => this.append(l));
        return 0;
      } catch (e) {
        this.append(`error: ${(e as Error).message}`);
        return 1;
      }
    });
    return undefined;
  }

  cancel(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.append('(cancelled from the page)');
    }
  }

  private launch(view: FixView, runner: () => Promise<number>): void {
    this.busy = true;
    this.state.update((s) => {
      s.fix = view;
    });
    this.state.info(`started from the page: ${view.command.join(' ')}`, 'fix');
    void runner().then(async (code) => {
      this.busy = false;
      this.child = undefined;
      this.state.update((s) => {
        if (s.fix) {
          s.fix.running = false;
          s.fix.exitCode = code;
          s.fix.endedAt = new Date().toISOString();
        }
      });
      this.state.log(code === 0 ? 'info' : 'warn', `${code === 0 ? 'finished' : `exited with ${code}`}: ${view.command[0]}`, 'fix');
      await this.onDone();
    });
  }

  private append(line: string): void {
    const text = line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!text) return;
    this.state.update((s) => {
      if (!s.fix) return;
      s.fix.lines.push(text);
      if (s.fix.lines.length > MAX_LINES) s.fix.lines.splice(0, s.fix.lines.length - MAX_LINES);
      const code = DEVICE_CODE.exec(text);
      if (code?.[1] && /code/i.test(text)) s.fix.device = { code: code[1], url: s.fix.device?.url ?? 'https://github.com/login/device' };
      const url = DEVICE_URL.exec(text);
      if (url && s.fix.device) s.fix.device.url = url[0];
    });
  }

  private async execute(command: string[]): Promise<number> {
    if (command[0] === 'agentic-loop') {
      try {
        await this.own(command.slice(1), (l) => this.append(l));
        return 0;
      } catch (e) {
        this.append(`error: ${(e as Error).message}`);
        return 1;
      }
    }
    return new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', HOMEBREW_NO_ENV_HINTS: '1' },
      });
      this.child = child;
      const feed = (chunk: Buffer, carry: { rest: string }): void => {
        carry.rest += chunk.toString();
        const parts = carry.rest.split(/\r?\n/);
        carry.rest = parts.pop() ?? '';
        for (const p of parts) this.append(p);
      };
      const out = { rest: '' };
      const err = { rest: '' };
      child.stdout?.on('data', (c: Buffer) => feed(c, out));
      child.stderr?.on('data', (c: Buffer) => feed(c, err));
      child.on('error', (e) => {
        this.append(`cannot start ${command[0]}: ${e.message}`);
        resolve(127);
      });
      child.on('close', (code) => {
        if (out.rest) this.append(out.rest);
        if (err.rest) this.append(err.rest);
        resolve(code ?? 1);
      });
    });
  }
}
