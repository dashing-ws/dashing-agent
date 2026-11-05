# Agentic Loop: design

Updated 2026-11-05. From Eugene's brief of 2026-11-03 and the ideas of the Heartbeat AI RFC, rebuilt on GitHub only.

## Goal

One command, `agentic-loop <folder>`, runs an organization of AI agents from a GitHub repository on a laptop. Several people run the same command on their own laptops at the same time. They share the work through GitHub: the repository, one Project, its issues, and Actions. Nothing else is shared. There is no server and no database.

The organization is files in the repository. Agentic Loop is the program that runs them. The same program runs any organization, so one company can run several and each lives in its own repository.

## Two loops and a Director

Every node (one laptop running the command) runs two loops at once. They never talk to each other. They read and write the same tasks on GitHub, and a task's status says which loop may touch it next.

- **The agent loop** claims one task, runs one agent on it through the Claude Agent SDK on this laptop's Claude login, leaves the result on the task as a comment, and releases the claim. Agents read, think, write files, and propose. They execute nothing in the world.
- **The mechanical loop** has no model in it. It takes tasks a human approved, checks that their plan uses only handlers from the catalog, runs the steps in order, and writes what happened. A failed step stops the plan.
- **The Director** is one agent of the organization. It reads the inbox and gives each task to an agent, or rejects it. Only one laptop is the Director at a time: it holds the Director lease (20 minutes by default, renewed while it runs). When that laptop closes, the lease expires and the next laptop takes it.

## Invariants

1. GitHub holds every shared fact: the organization files and the audit in the repository, the tasks in one Project, the conversation in issue comments, the clocks in Actions. A node keeps nothing another node needs.
2. Every claim is a lease with an expiry. A lease is a git ref on the remote, updated by compare-and-swap (`git push --force-with-lease`). GitHub is the only judge of who won. An expired lease needs no cleanup; the next node takes it over.
3. An agent reaches the world only through tools the harness allows: the built-in tools its spec lists and the ledger tools of its run. Everything else is denied and logged. A deny hook enforces it on top of the SDK's own permission mode, and the laptop's own Claude Code settings are never loaded into a run. An agent sees one checkout of the organization repository and nothing else on the laptop.
4. Nothing executes without a human. An agent ends in Review. A human moves the task to Approved. The mechanical loop executes only plans whose every step names a handler from the catalog with valid typed arguments. There is no handler that runs free text.
5. Every run writes an audit file (every tool call, every result, the cost) before the task's state changes, and leaves a comment on the task that points at it.
6. One task, one agent, one run at a time per node. The loop never starts a tick while one runs, and a task with a run in progress in this process is never claimed again, since a lease held by this laptop reads as free to it. Runs are bounded by turns, cost and wall clock from the organization's budgets.
7. Pre-flight runs before anything else. The loops do not start until every check passes, and the UI shows each failed check with its fix.
8. Agentic Loop never writes the organization's default branch. An agent's file changes go to a branch of its task, pushed by the harness, and reach the default branch only through a pull request a human merges. The tool writes audit files on the laptop and state on GitHub, nothing else.
9. The kill switch is a file, `control/kill`, in the repository. Every node pulls before each tick and stops when it sees it.

## Two repositories

An organization (a department of agents) is one GitHub repository of its own. Agentic Loop is another repository: the tool. The tool runs any organization; one company runs several, each in its own repository with its own Project. Nothing of the organization lives in the tool, and no code of the tool lives in the organization.

| | The organization repository | Agentic Loop |
| --- | --- | --- |
| Holds | agents, actions, policies, the kill switch, `agentic-loop.yaml`, the Project, the issues | the loops, pre-flight, the runner, the UI |
| Owned by | the department | whoever maintains the tool |
| Changed by | people, through pull requests | releases of the tool |
| Written by the tool | `init` (starter files, once), `setup` (the Project number in `agentic-loop.yaml`, once), GitHub state (issues, fields, comments, lease refs) | nothing at run time |
| Kept on the laptop | the clone you pass on the command line | the installed command, audit files under `~/.agentic-loop/` |

The command takes the clone's path. Pre-flight proves the rest: it is a git root, origin is on GitHub, the GitHub CLI is installed and signed in with access, the organization files load, and the repository's Project exists with the fields the loops need. The Project is the ticketing system of both loops.

## The organization folder

A clone of the organization's GitHub repository. `agentic-loop.yaml` sits at its root and tells the tool what is what and how to run it. Everything else may live where the organization likes; the table shows the defaults, and `paths:` in `agentic-loop.yaml` renames the three folders. The file was `dashing.yaml` before 2026-11-05; the tool still reads that name, and pre-flight offers the rename as a fix.

| Path | Holds |
| --- | --- |
| `agentic-loop.yaml` | name, logo, the Director's name, the GitHub Project number, `paths`, model, lease times, budgets, loop intervals |
| `agents/<name>.md` | one agent: YAML front matter (`role`, `description`, `model`, `tools`, `access`) and the system prompt as the body |
| `actions/<name>/manifest.yaml`, `run.sh` | a script the mechanical loop may run; the manifest declares typed parameters, a timeout, and a description |
| `control/kill` | present means every node stops |
| `.github/workflows/agentic-loop-*.yml` | clocks that need no model: sweeping expired leases, later intake and reports |

The organization may hold any other folders (policies, context, templates, evaluations); the tool ignores what `agentic-loop.yaml` does not name. `agentic-loop init <folder>` writes the starter files. `agentic-loop setup <folder>` creates the Project with its fields and writes the number back.

## Starting an organization

`agentic-loop` with no folder, or with a folder that has no `agentic-loop.yaml`, opens the page with a form under Organization instead of a fix line: the name, the folder on this laptop, the GitHub owner (the signed-in account, or any organization it belongs to; one choice when there is one) and the repository name (private by default, or empty to add later), the Director, and the agents to start with. Creating it writes the files, makes a git repository with one commit, creates the GitHub repository and pushes, creates the Project with its fields, commits and pushes the Project number, then runs pre-flight on the new folder. When the repository is left for later, the Project waits with it; when the token lacks the Project scope, the build says so and pre-flight offers the Project again. A folder that already is a git repository or already has a remote is used as it is.

**Templates** are named sets of library agents with a director, `library/templates/<name>.yaml`, one click in the form; the tool ships a writing room, an operations desk and a runtime team. **Another organization** can be the template too: the form takes a folder on this laptop or `owner/name` on GitHub, reads that organization's agent files (at the path its own `agentic-loop.yaml` names) and copies them in, avatar images included. That is how a department's own agents become a new organization without ever entering this tool.

**Names.** An agent's `name` is its identity: unique in the organization, lowercase, the way a person has a name. Its `role` is the function and its `description` says what it does. Two writers can work side by side under different names, and the Director picks by role and description. An `avatar` is one emoji or the path of an image file inside the organization (`avatars/<name>.png`), which the page serves for the roster. The organization itself may have a `logo:` in `agentic-loop.yaml`, an emoji or an image file in the same way; the page shows it in the header before the organization's name.

The agents come from the **library** that ships with the tool: `library/agents/<name>.md`, one file per agent in the same format as an organization's own, with an emoji or an image avatar under `library/avatars/`. Every agent has a star's name, a role and a group, so two of a kind never blur: a card reads "Bellatrix · Reviewer · assurance". Vega (writer) and Altair (researcher) are the content group, Deneb (planner) is in change, Polaris (front desk) in intake. The **runtime team**: twelve agents for a department that keeps a fleet of services running. Rigel directs; the change group is Betelgeuse (footprint and cost), Nebula (service lifecycle), Alnitak (vulnerability), Alnilam (mandate) and Mintaka (housekeeping); the production group is Hatsya (production monitor) and Saiph (troubleshooter); the assurance group is Bellatrix (reviewer), Tabit (compliance evidence), Meissa (context curator) and Sirius (reporting and communications). Their names, roles, groups and portraits come from the organization Eugene designed at work; their prompts were written for this harness (files in the repository, pull requests, plans from the action catalog, a human for anything that removes or spends). The `runtime-team` template picks all twelve, plus Polaris, with Rigel as Director. The chosen files are copied into the organization and belong to it from then on; the library is a starting point, never a dependency. Organization templates (a whole marketing or operations department in one choice) are a later step on the same path.

## Tasks

A task is an issue in the organization's repository, added to its Project. The Project's **Status** field is the state machine. The **Agent** field names who works on it. Comments carry the conversation, the results, the plans and the execution reports.

| Status | Meaning | Who moves it here |
| --- | --- | --- |
| Inbox | new, no agent yet | whoever files the issue, or intake automation |
| Assigned | has an agent | the Director |
| Running | one node claimed it and an agent run is in progress | the agent loop |
| Review | the agent finished; a result or a plan is on the task | the agent, through a ledger tool |
| Approved | a human approved the plan | a human, on the board |
| Executing | the mechanical loop runs the plan | the mechanical loop |
| Done | finished | the agent (text result), the mechanical loop, or the agent loop when the issue is closed on GitHub (a merged pull request closes it) |
| Failed | a run or an execution failed; the comment says why. Move back to Assigned to retry | either loop |
| Rejected | will not be done | the Director or a human |

The loops read the Project with one lean GraphQL query per page (the issues, their Status and Agent), which costs a few rate-limit points per call. `gh project item-list` fetches every field value of every item and costs hundreds; the first live run hit GitHub's hourly budget of 5,000 points within minutes that way. When a tick fails on a rate limit, the loop waits until GitHub's reset time before the next one.

A pull request is the result of most agent runs, and merging it is its review: the pull request closes the issue, and the next tick marks the task Done. Approved is only for plans, which the mechanical loop executes.

Every intake channel (a person, Slack, Telegram, an MCP tool, a scheduled job) ends the same way: an issue in Inbox. The Director reads only the inbox, so adding a channel adds nothing to the loops.

## Intake on the page

One way in on the node's page: the **front desk** chat. (A no-model new-task box was tabled on 2026-11-04; it comes back only if a chat turns out to be the wrong tool for filing.) Each message runs the `front-desk` agent once, with the recent conversation in the prompt and five tools and nothing else: the roster, the list of tasks, one task's detail, file a task, add a note to a task. It answers questions from the board and files tasks for people who ask for work; it has no file tools and cannot move a task along. The conversation stays on the laptop; what it files is on GitHub. An organization's own agent with the role "Front desk" answers when it has one; otherwise the library's Polaris does. Each answer is one run under a 12-turn cap, audited under `audit/chat/`.

## Leases

`refs/agentic-loop/leases/<name>` on the remote points to a small commit whose message is JSON: holder, taken at, valid until. Taking, renewing and releasing a lease are pushes with `--force-with-lease=<ref>:<expected sha>`; the server rejects the push when another node moved the ref first. An empty expected value means the ref must not exist yet.

- `director`: held by the node running the Director planning pass.
- `task-<number>`: held by the node running an agent on that task, renewed every few minutes during the run. If a renewal fails, the run is stopped at once.

A GitHub Actions workflow deletes expired lease refs every 15 minutes so the board tells the truth. Correctness never depends on it.

## A run

One run is one `query()` through the Claude Agent SDK:

- the system prompt is the agent's file plus a fixed harness section (who it is, that it proposes and never executes, the handler catalog, the roster);
- the prompt is the task and the instruction to end with a ledger tool;
- `tools` is the agent's built-in list, `permissionMode` is `dontAsk`, `settingSources` is empty, and a `PreToolUse` hook denies every tool outside the allowance and writes each call to the audit file;
- the ledger tools are served in-process as the MCP server `ledger`: `read_task`, `post_update`, `remove_file` (a delete inside the write folders; the built-in tools only create and edit), `propose_plan`, `finish` for a worker; `list_inbox`, `assign_task`, `reject_task` for the Director; the five board tools for the front desk;
- limits come from `budgets`: turns, estimated cost, wall clock. The cost is the SDK's own estimate from a price table; on a Claude subscription nothing is billed per run, so it is a safety cap only. A three-turn smoke run was estimated at about $1.26, so keep the cap well above $2.

Audit files live under `~/.agentic-loop/audit/<task>/` on the node that ran, as JSON lines; the task's closing comment names the file and the node.

## Where an agent works

An agent works in the organization repository itself, in a git worktree of the clone on the branch `agentic-loop/task-<n>`, under `~/.agentic-loop/work/`. The worktree starts from the default branch, or from the task's branch if an earlier run pushed one. The agent reads and edits files there with the tools its spec lists; `git push` is denied to it. When the run ends the harness commits what changed, pushes the branch with `--force-with-lease`, opens a pull request that closes the task, and removes the worktree. The task's result comment names the commit, the branch and the pull request. The organization's clone stays on its own branch and is never touched by a run.

An agent has only what the organization gives it: its tools, its folders, its ledger tools. The agent file says which folders of the checkout it may read and which it may write:

```yaml
access:
  read: [docs, policy]   # folders it may read; "." means the whole checkout (the default)
  write: [docs/notes]    # folders it may create and edit files in; writing implies reading (default: none)
```

The deny hook checks every file tool call against this list before it runs: Read, Glob, Grep and LS against the read folders, Write, Edit, MultiEdit and NotebookEdit against the write folders. Paths outside the checkout and `.git` are denied for everyone. Bash cannot be limited to folders, so an agent with Bash must be given everything in so many words, and the organization sees that in the file. A denied call is logged in the audit file with the reason, and the agent is told its folders in its prompt so it does not try.

## The UI

Each node serves one page on `localhost:4848`, fed by one JSON state over server-sent events. The page has two faces.

**The gate** shows while pre-flight has something to fix. On a first run (no folder, or no `agentic-loop.yaml`) it signs the laptop in to GitHub with the one-time code, then offers the organization: a folder that already holds one, or a new one built from the library (a template, agents picked one by one, or the agents of another organization copied in), with the Director and a preview of the crew. On a later run it lists the checks, cheapest first, and shows each failing one with its fix in place. When every check passes it says so and turns into the dashboard by itself; the "ready" pill in the header opens it again.

**The dashboard** never scrolls as a whole: the header is fixed and each panel scrolls inside. The header carries the organization (its logo when `agentic-loop.yaml` names one, then its name), the node, the folder, the repository and the Project, the Director lease (this laptop or another, until when) and one pill per loop with pause and resume. Three columns share the width (about 17, 53 and 30 parts, with floors): the organization on the left as a chart, the Director on top, one block per `group:`, the front desk apart, each agent with its portrait, color and what it does now, and a card with its description on hover; the activity in the middle, "Now" cards for the runs in progress (turns, tool calls, what it does, what it last said; runs on other laptops as the leases and the board show them) and under them a feed of plain-word lines, who did what on which task and when, with filters; on the right the open work grouped by what it needs (you, the loops, the Director) and under it the front desk chat, half and half.

The feed comes from the harness, never from the agents: the runner's hook reports every tool call in plain words (read, wrote, ran, searched, denied), the ledger tools report what they did (assigned, proposed, reported), the loops report claims, leases, finishes and failures, pre-flight reports its outcome. Each agent's color comes from `color:` in its file; agents of one group share a hue. The theme is dark blue only. Controls are pause and resume per loop, re-check pre-flight, run a fix, pick or build an organization and the chat; none touch shared state. The shared view across laptops is the GitHub Project board itself.

## Pre-flight

Cheapest first; each failure comes with a fix. The page shows a button per failed check and runs the fix right there, streaming its output; `--fix` runs the same fixes in order in the terminal. A fix is always the command pre-flight attached to the check, never free text; where a command needs a value (a name, an email, a repository) the page asks for it and the value is checked before the command runs. Every request from the page carries a header a browser only sends from this page, so another site cannot trigger a fix.

Signing in to GitHub and adding token scopes run the GitHub CLI's device flow: gh prints a one-time code, the page shows it large with a button that copies it and opens github.com/login/device, the person pastes it there, and gh keeps the token. When the fix ends, pre-flight runs again by itself; when every check passes, the page says so and the loops start.

gh keeps its login under `~/.config/gh`. On a managed laptop that folder can belong to another user, and the sign-in ends with "permission denied". The tool checks this before its first gh call: when gh's folder cannot be written and `GH_CONFIG_DIR` is not set, it points gh at `~/.agentic-loop/gh` for every command it runs and shows a line in the checks with the export for the terminal. gh still stores the token; the tool stores nothing.

The checks: Node 22, git, GitHub CLI 2.60+, signed in, token scopes `repo` and `project`, Claude Code on PATH (warning only), the folder is a git root, origin is on github.com, the user has write access (the owner may be any account or organization gh can reach), git name and email, a tracking branch, the organization files load, the kill switch, the Project exists with the Status and Agent options, and the lease namespace on origin is readable.

## Open points

- **Labels or Project fields.** Status lives on the Project, which needs the `project` token scope and a Project per organization. Issue labels would work with the `repo` scope alone and trigger Actions on change, at the price of a poorer board. The Project is in now; a labels backend can sit behind the same `TaskStore` interface.
- **Where the audit lives.** Today: a local JSON-lines file per run and a summary comment. Committing audit files to the repository from many laptops means push conflicts; a per-node branch or a GitHub release asset would avoid them.
- **Claude login and terms.** The Agent SDK documentation says agents built on it should use API keys and that third parties may not offer claude.ai login in their products. Running on your own laptop with your own Claude Code login is what Hermes does today with `claude -p`; the same question applies to both. If it becomes a problem, `AGENTIC_LOOP_CLAUDE_PATH` points the SDK at the installed `claude`, and an API key works unchanged.
- **A reviewer agent.** Today a human reviews every Review task. A reviewer agent that reconstructs the facts and approves Tier 2 work is the next step from the Heartbeat design.
- **Tiers and ceilings.** The first version has one gate: a human approves plans. Per-agent ceilings and per-action tiers belong in `policy/` when there is more than one kind of action.
- **Bash and folders.** Folder access cannot cover Bash. An agent that needs a shell gets everything today; a sandboxed shell (a container or a filesystem jail) would close that gap.
- **Access requests.** When gh can reach GitHub but not the repository, pre-flight names the owner and the settings page to ask at. GitHub has no API to request access to a repository, so this stays a message.
- **Library growth.** Agents in the library are prompts over files in the repository. Agents that need a live system (a cost export, a monitoring API) need an action in the catalog that fetches it into the repository first, or an intake workflow that files the data as a task. A template picks agents, actions and workflows together.
- **Intake adapters.** Slack, Telegram and MCP inputs become issues in Inbox. Each adapter is a small Actions workflow or a tool; none is written yet.
- **The `setup` command** creates the Project and its fields through `gh` and GraphQL; it could not be run in the session that wrote it because the token lacks the `project` scope. It needs one real run.
