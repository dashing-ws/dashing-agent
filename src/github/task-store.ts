import { gh, ghJson } from './gh.js';

/**
 * Tasks are issues in the organization's repository, added to one GitHub Project (V2).
 * The Project's "Status" field is the state machine both loops read; the "Agent" field names
 * who works on it. Comments on the issue are the conversation and the record.
 */

export type TaskStatus = 'Inbox' | 'Assigned' | 'Running' | 'Review' | 'Approved' | 'Executing' | 'Done' | 'Failed' | 'Rejected';

export const TASK_STATUSES: TaskStatus[] = ['Inbox', 'Assigned', 'Running', 'Review', 'Approved', 'Executing', 'Done', 'Failed', 'Rejected'];

export const STATUS_MEANING: Record<TaskStatus, string> = {
  Inbox: 'new; the Director reads it and assigns an agent',
  Assigned: 'has an agent; any laptop may claim it',
  Running: 'claimed; one agent run is in progress on one laptop',
  Review: 'the agent finished and left a result or a plan; a human decides',
  Approved: 'a human approved the plan; the mechanical loop may execute it',
  Executing: 'the mechanical loop is running the plan',
  Done: 'finished',
  Failed: 'a run or an execution failed; the comment says why',
  Rejected: 'will not be done',
};

export interface Task {
  number: number;
  url: string;
  title: string;
  body: string;
  status: TaskStatus;
  agent?: string;
  /** The issue is closed on GitHub (a merged pull request that closes it, or a person). */
  closed?: boolean;
  itemId?: string;
}

export interface Comment {
  author: string;
  body: string;
  at: string;
}

export interface TaskStore {
  list(): Promise<Task[]>;
  get(number: number): Promise<Task | undefined>;
  setStatus(task: Task, status: TaskStatus): Promise<void>;
  setAgent(task: Task, agent: string): Promise<void>;
  comment(task: Task, body: string): Promise<void>;
  comments(task: Task): Promise<Comment[]>;
  create(title: string, body: string): Promise<Task>;
}

export interface GitHubStoreOptions {
  owner: string;
  repo: string;
  project: number;
  cwd?: string;
}


const MAX_PAGES = 5;

const ITEMS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      content { __typename ... on Issue { number title body url state } }
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      agent: fieldValueByName(name: "Agent") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    }
  } } }
}`;

interface ItemsPage {
  data?: {
    node?: {
      items?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          id?: string;
          content?: { __typename?: string; number?: number; title?: string; body?: string; url?: string; state?: string } | null;
          status?: { name?: string } | null;
          agent?: { name?: string } | null;
        }>;
      };
    };
  };
}

export function toStatus(v: unknown): TaskStatus {
  const s = typeof v === 'string' ? v : '';
  return (TASK_STATUSES as string[]).includes(s) ? (s as TaskStatus) : 'Inbox';
}

export class GitHubProjectStore implements TaskStore {
  private readonly nwo: string;

  constructor(private readonly o: GitHubStoreOptions) {
    this.nwo = `${o.owner}/${o.repo}`;
  }

  private projectId: string | undefined;

  /** The Project's node id, read once. */
  private async id(): Promise<string> {
    if (!this.projectId) {
      const v = await ghJson<{ id: string }>(['project', 'view', String(this.o.project), '--owner', this.o.owner, '--format', 'json'], { cwd: this.o.cwd });
      this.projectId = v.id;
    }
    return this.projectId;
  }

  /**
   * Lists the Project's issues with their Status and Agent. One lean GraphQL query per page:
   * `gh project item-list` asks for every field value of every item and costs hundreds of
   * rate-limit points per call; this asks for two and costs a few.
   */
  async list(): Promise<Task[]> {
    const id = await this.id();
    const tasks: Task[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = ['api', 'graphql', '-f', `query=${ITEMS_QUERY}`, '-F', `id=${id}`, ...(after ? ['-F', `after=${after}`] : [])];
      const data = await ghJson<ItemsPage>(args, { cwd: this.o.cwd });
      const items = data.data?.node?.items;
      for (const item of items?.nodes ?? []) {
        const c = item.content;
        if (!c || c.__typename !== 'Issue' || typeof c.number !== 'number' || typeof c.url !== 'string') continue;
        const agent = item.agent?.name;
        tasks.push({
          number: c.number,
          url: c.url,
          title: typeof c.title === 'string' ? c.title : '',
          body: typeof c.body === 'string' ? c.body : '',
          status: toStatus(item.status?.name),
          ...(c.state === 'CLOSED' ? { closed: true } : {}),
          ...(typeof agent === 'string' && agent ? { agent } : {}),
          ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
        });
      }
      if (!items?.pageInfo?.hasNextPage || !items.pageInfo.endCursor) break;
      after = items.pageInfo.endCursor;
    }
    return tasks.sort((x, y) => x.number - y.number);
  }

  async get(number: number): Promise<Task | undefined> {
    return (await this.list()).find((t) => t.number === number);
  }

  async setStatus(task: Task, status: TaskStatus): Promise<void> {
    await this.edit(task, 'Status', status);
    task.status = status;
  }

  async setAgent(task: Task, agent: string): Promise<void> {
    await this.edit(task, 'Agent', agent);
    task.agent = agent;
  }

  async comment(task: Task, body: string): Promise<void> {
    await gh(['issue', 'comment', String(task.number), '-R', this.nwo, '--body-file', '-'], { cwd: this.o.cwd, input: body });
  }

  async comments(task: Task): Promise<Comment[]> {
    const json = await ghJson<{ comments: Array<{ author?: { login?: string }; body?: string; createdAt?: string }> }>(
      ['issue', 'view', String(task.number), '-R', this.nwo, '--json', 'comments'],
      { cwd: this.o.cwd },
    );
    return (json.comments ?? []).map((c) => ({ author: c.author?.login ?? '', body: c.body ?? '', at: c.createdAt ?? '' }));
  }

  async create(title: string, body: string): Promise<Task> {
    const url = (await gh(['issue', 'create', '-R', this.nwo, '--title', title, '--body-file', '-'], { cwd: this.o.cwd, input: body })).trim();
    const m = /\/issues\/(\d+)$/.exec(url);
    if (!m?.[1]) throw new Error(`could not read the issue number from "${url}"`);
    const added = await ghJson<{ id?: string }>(
      ['project', 'item-add', String(this.o.project), '--owner', this.o.owner, '--url', url, '--format', 'json'],
      { cwd: this.o.cwd },
    );
    const task: Task = { number: Number(m[1]), url, title, body, status: 'Inbox', ...(added.id ? { itemId: added.id } : {}) };
    await this.setStatus(task, 'Inbox');
    return task;
  }

  private async edit(task: Task, field: string, value: string): Promise<void> {
    await gh(
      ['project', 'item-edit', String(this.o.project), '--owner', this.o.owner, '--url', task.url, '--field', field, '--value', value],
      { cwd: this.o.cwd },
    );
  }
}
