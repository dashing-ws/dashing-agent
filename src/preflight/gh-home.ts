import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Where gh keeps its login. gh uses GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else ~/.config/gh.
 * On a managed laptop ~/.config may belong to another user, and `gh auth login` ends with
 * "mkdir ~/.config/gh: permission denied". Then the tool points gh at ~/.agentic-loop/gh for every
 * command it runs. The token is still gh's, stored by gh, never by the tool.
 */
export interface GhHome {
  /** The folder gh uses in this process. */
  dir: string;
  /** True when the tool set GH_CONFIG_DIR itself because gh's own folder cannot be used. */
  moved: boolean;
  /** The folder gh would have used. */
  reason?: string;
}

let decided: GhHome | undefined;

/** True when the folder exists and is writable, or does not exist and its nearest existing parent is. */
async function canUse(dir: string): Promise<boolean> {
  let p = dir;
  for (;;) {
    try {
      await fs.access(p, fs.constants.W_OK);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(p);
      if (parent === p) return false;
      p = parent;
    }
  }
}

/** Decides once per process, before the first gh call, and sets GH_CONFIG_DIR only when it has to. */
export async function ensureGhConfigDir(): Promise<GhHome> {
  if (decided) return decided;
  if (process.env.GH_CONFIG_DIR) return (decided = { dir: process.env.GH_CONFIG_DIR, moved: false });
  const own = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'gh');
  if (await canUse(own)) return (decided = { dir: own, moved: false });
  const ours = path.join(os.homedir(), '.agentic-loop', 'gh');
  await fs.mkdir(ours, { recursive: true });
  process.env.GH_CONFIG_DIR = ours;
  return (decided = { dir: ours, moved: true, reason: own });
}

/** For tests: forget the decision. */
export function resetGhConfigDir(): void {
  decided = undefined;
}
