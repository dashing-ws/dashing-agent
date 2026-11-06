import type { Task, TaskStore } from '../github/task-store.js';
import type { StateStore, TaskView } from '../state.js';

/**
 * Wraps the task store so the page sees every board write the moment this laptop makes it. The
 * loops refill the list from GitHub at the start of a tick; the writes happen inside the tick,
 * often minutes later during a run, and the Work panel would show the old status until the next
 * tick. Writes by other laptops still show at the next read.
 */
export function mirrorBoard(store: TaskStore, state: StateStore): TaskStore {
  const view = (t: Task): TaskView => ({ number: t.number, title: t.title, status: t.status, url: t.url, ...(t.agent ? { agent: t.agent } : {}) });
  const put = (t: Task): void =>
    state.update((s) => {
      const i = s.tasks.findIndex((x) => x.number === t.number);
      if (i >= 0) s.tasks[i] = view(t);
      else s.tasks.push(view(t));
    });
  return {
    async list() {
      const tasks = await store.list();
      state.update((s) => {
        s.tasks = tasks.map(view);
      });
      return tasks;
    },
    get: (number) => store.get(number),
    async setStatus(task, status) {
      await store.setStatus(task, status);
      put(task);
    },
    async setAgent(task, agent) {
      await store.setAgent(task, agent);
      put(task);
    },
    comment: (task, body) => store.comment(task, body),
    comments: (task) => store.comments(task),
    async create(title, body) {
      const task = await store.create(title, body);
      put(task);
      return task;
    },
  };
}
