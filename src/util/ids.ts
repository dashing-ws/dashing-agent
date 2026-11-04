import os from 'node:os';

export function shortId(len = 6): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

export function hostName(): string {
  return os.hostname().replace(/\.local$/, '');
}

export function osUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function minutes(n: number): number {
  return n * 60_000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
