import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

/** Runs a command and resolves with its exit code and output. Never throws for a non-zero exit. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const code = typeof e.code === 'number' ? e.code : 127;
        const extra = typeof e.code === 'string' ? `${e.code}: ${e.message}` : e.killed ? 'timed out' : '';
        resolve({ code, stdout: String(stdout ?? ''), stderr: `${String(stderr ?? '')}${extra ? `\n${extra}` : ''}`.trim() });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Runs a command and returns stdout; throws with stderr when the exit code is not zero. */
export async function ok(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

export async function which(cmd: string): Promise<string | null> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
  return r.code === 0 ? r.stdout.trim().split('\n')[0] ?? null : null;
}
