# Agentic Loop

Runs an organization of AI agents from a GitHub repository, on your laptop, together with other people's laptops.

- An **agent loop** claims one task, runs one agent on it with the Claude Agent SDK on your own Claude login, and leaves the result on the task.
- A **mechanical loop** executes the plans a human approved: scripts from the repository and pull-request merges. No model in it.
- One **Director** per organization reads new tasks and assigns them. The Director runs on one laptop at a time under a lease.
- Everything shared lives on GitHub: the repository, one Project, its issues, and Actions. Leases are git refs. No server.

Design, invariants and open points: [docs/design.md](docs/design.md).

## Install

```sh
git clone <this repository> agentic-loop && cd agentic-loop
npm install && npm run build && npm link
```

Needs Node 22, git, the GitHub CLI signed in with the `repo` and `project` scopes, and Claude Code signed in on the laptop.

## Run

```sh
agentic-loop                         # no organization yet: the page helps you build one
agentic-loop       ~/git/my-org      # every laptop: pre-flight, UI at localhost:4848, both loops
agentic-loop check ~/git/my-org --fix
agentic-loop init  ~/git/my-org      # the starter files without the page
agentic-loop setup ~/git/my-org      # the GitHub Project and its fields without the page
```

With no folder, or a folder without `agentic-loop.yaml`, the page shows a form: name, folder, GitHub repository, the Director, and agents from the library that ships with the tool (`library/agents/`). It writes the files, creates the repository and the Project, and pushes.

Pre-flight names each missing piece and its fix. On the page every failed check has a button that runs the fix and shows its output; signing in to GitHub shows the one-time code with a copy button and the link to paste it. `--fix` runs the same fixes in the terminal. The loops start when every check passes.

The page is a gate until every check passes, then a dashboard: the organization as a chart, a live feed of what every agent does in plain words, the open work, and a front desk chat that answers from the board and files tasks in Inbox for the Director. An agent may read and write only the folders its file grants (`access: { read: [...], write: [...] }`; the default is read everything, write nothing). An agent works in a worktree of the organization repository on the branch `agentic-loop/task-<n>`. When its run ends, Agentic Loop commits what changed, pushes the branch and opens a pull request on the task. Nothing reaches the default branch without a human.

## The organization folder

The folder you pass is a clone of the organization's own repository: one repository per department of agents, with its own GitHub Project as the ticketing system. Agentic Loop is only the tool; it reads these files and writes nothing into the folder while it runs.

```
agentic-loop.yaml                    name, logo, director, GitHub project, paths, lease times, budgets
agents/<name>.md                front matter (role, description, model, tools, access) + the system prompt
actions/<name>/manifest.yaml    a script the mechanical loop may run, with typed parameters
actions/<name>/run.sh
control/kill                    present means every laptop stops
```

`logo:` in `agentic-loop.yaml` is one emoji or an image file inside the organization (`avatars/logo.png`); the page shows it in the header before the organization's name.

An organization made before 2026-11-05 has `dashing.yaml` instead; the tool still reads it, and pre-flight offers the rename.

Only `agentic-loop.yaml` has a fixed place. If the organization keeps its agents, actions or control folder elsewhere, name them:

```yaml
paths:
  agents: org/agents
  actions: harness/actions
  control: ops/control
```

See [examples/org](examples/org).
