import type { StateStore, LoopStatus } from '../state.js';

/** A loop runs one tick, waits, runs the next. Ticks never overlap. */
export class Loop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private paused = false;
  private ticks = 0;

  private holdUntil = 0;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly state: StateStore,
    /** Given a failed tick's error, how long to wait before the next tick, or nothing for the usual interval. */
    private readonly backoff?: (error: Error) => Promise<number | undefined>,
  ) {
    this.publish('stopped');
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.publish('idle');
    void this.cycle();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.publish(this.running ? 'running' : 'stopped');
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.publish(this.running ? 'running' : 'paused');
    this.state.event({ who: `${this.name} loop`, verb: 'paused', text: 'from the page' });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.running) this.publish('idle');
    this.state.event({ who: `${this.name} loop`, verb: 'resumed', text: 'from the page' });
  }

  /** Runs one tick now if none is running. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    await this.execute();
  }

  get isRunning(): boolean {
    return this.running;
  }

  setCurrent(text: string | undefined): void {
    this.state.update((s) => {
      const v = s.loops[this.name];
      if (v) {
        if (text) v.current = text;
        else delete v.current;
      }
    });
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    if (!this.paused && !this.running) await this.execute();
    if (this.stopped) {
      this.publish('stopped');
      return;
    }
    const wait = Math.max(this.intervalMs, this.holdUntil - Date.now());
    this.timer = setTimeout(() => void this.cycle(), wait);
  }

  private async execute(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ticks += 1;
    this.publish('running');
    try {
      await this.tick();
      this.publish(this.paused ? 'paused' : 'idle');
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.state.error(`tick failed: ${msg}`, this.name);
      const hold = this.backoff ? await this.backoff(e as Error).catch(() => undefined) : undefined;
      if (hold && hold > this.intervalMs) {
        this.holdUntil = Date.now() + hold;
        const until = new Date(this.holdUntil).toISOString().slice(11, 16);
        this.state.warn(`waiting until ${until} UTC before the next tick`, this.name);
        this.publish('waiting', `${msg}; waiting until ${until} UTC`);
      } else {
        this.publish(this.paused ? 'paused' : 'idle', msg);
      }
    } finally {
      this.running = false;
      this.setCurrent(undefined);
    }
  }

  private publish(status: LoopStatus, lastError?: string): void {
    this.state.update((s) => {
      const prev = s.loops[this.name];
      s.loops[this.name] = {
        name: this.name,
        status,
        ticks: this.ticks,
        lastTickAt: new Date().toISOString(),
        ...(lastError ? { lastError } : prev?.lastError && status === 'running' ? { lastError: prev.lastError } : {}),
        ...(prev?.current ? { current: prev.current } : {}),
      };
    });
  }
}
