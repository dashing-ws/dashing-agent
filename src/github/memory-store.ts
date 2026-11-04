import type { Comment, Task, TaskStatus, TaskStore } from './task-store.js';

/** An in-memory store for tests and dry runs. */
export class MemoryStore implements TaskStore {
  /** Marks an issue closed, as GitHub does when a pull request that closes it merges. */
  close(number: number): void {
    const t = this.tasks.get(number);
    if (t) t.closed = true;
  }

  readonly tasks = new Map<number, Task>();
  readonly log = new Map<number, Comment[]>();
  private next = 1;

  async list(): Promise<Task[]> {
    return [...this.tasks.values()].map((t) => ({ ...t })).sort((a, b) => a.number - b.number);
  }

  async get(number: number): Promise<Task | undefined> {
    const t = this.tasks.get(number);
    return t ? { ...t } : undefined;
  }

  async setStatus(task: Task, status: TaskStatus): Promise<void> {
    const t = this.must(task.number);
    t.status = status;
    task.status = status;
  }

  async setAgent(task: Task, agent: string): Promise<void> {
    const t = this.must(task.number);
    t.agent = agent;
    task.agent = agent;
  }

  async comment(task: Task, body: string): Promise<void> {
    this.must(task.number);
    const list = this.log.get(task.number) ?? [];
    list.push({ author: 'node', body, at: new Date().toISOString() });
    this.log.set(task.number, list);
  }

  async comments(task: Task): Promise<Comment[]> {
    return [...(this.log.get(task.number) ?? [])];
  }

  async create(title: string, body: string, status: TaskStatus = 'Inbox', agent?: string): Promise<Task> {
    const number = this.next++;
    const task: Task = { number, url: `memory://tasks/${number}`, title, body, status, ...(agent ? { agent } : {}) };
    this.tasks.set(number, task);
    return { ...task };
  }

  private must(number: number): Task {
    const t = this.tasks.get(number);
    if (!t) throw new Error(`no task #${number}`);
    return t;
  }
}
