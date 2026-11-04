# dashing-agent: guidance for AI coding assistants

dashing-agent runs an organization of AI agents from a GitHub repository on a laptop. Two loops: an agent loop (claims a task, runs one agent through the Claude Agent SDK, posts the result) and a mechanical loop (executes human-approved plans with no model). Many laptops run it at once; GitHub is the only shared state; leases are git refs updated by compare-and-swap. Read `docs/design.md` first: it holds the goal, the invariants and the open points.

## Layout
- `src/cli.ts` the command: `run` (default; the folder is optional), `check`, `init`, `setup`
- `src/preflight/` the checks and their fixes; `fixer.ts` runs a fix from the page and spots the GitHub device code
- `library/agents/*.md` the agents that ship with the tool and `library/templates/*.yaml` the named sets of them; `src/org/library.ts` reads both; `src/org/builder.ts` makes a new organization from the page, from a template, or from another organization's agents
- `src/org/contract.ts` the organization folder: `dashing.yaml` at the root, then `agents/*.md`, `actions/*/manifest.yaml`, `control/kill` at the paths it names
- `src/lease/git-ref-lease.ts` leases as git refs with `--force-with-lease`; tested against a local bare repo
- `src/github/` the `gh` wrapper, the Project-backed task store, an in-memory store for tests
- `src/runner/` the Agent SDK run with the deny hook and the audit file; the ledger tools agents call; `workspace.ts` the worktree, branch and pull request per task; `access.ts` the folder rules the hook enforces; `chat-tools.ts` and `front-desk.ts` the chat on the page; `narrate.ts` a tool call in plain words for the feed
- `src/mechanical/` the plan format, its validation, the handler catalog (`run_script`, `merge_pr`, `comment`)
- `src/loops/` the loop runner, the agent loop (Director lease, claim, run), the mechanical loop; `run-tracker.ts` feeds a run into the state for the page
- `src/ui/` the localhost page (`page.ts`, the gate and the dashboard in one HTML string) and its server with the event stream; `src/state.ts` the one JSON state the page renders, with the activity feed and the runs in progress
- `examples/org/` the smallest organization that runs

## Commands
- `npm run dev -- <folder>` run from source; `npm run build` then `node bin/dashing-agent.js <folder>` the built CLI
- `npm test` runs vitest (lease and plan tests); `npm run typecheck`

## Rules
- TypeScript, ESM, Node 22, `strict`. Imports end in `.js`. No framework for the UI: one HTML page, `node:http`, server-sent events.
- The organization is its own repository; dashing-agent is the tool. The tool reads the organization and writes nothing into it at run time. Nothing organization-specific (names, agents, policies) goes into this repository except `examples/org`.
- Everything that touches GitHub goes through `gh`. Nothing stores a token.
- An agent never gets a tool the harness did not list, and never a path outside the folders its spec grants. Keep the deny hook and `settingSources: []` in every run.
- A plan step is a handler from the catalog with validated arguments. Never add a handler that runs free text. The same for pre-flight fixes: the page runs the command the check defined, with placeholders checked, never a command the page sends.
- A run never pushes the default branch. Agents work on `dashing/task-<n>`; the harness pushes and opens the pull request.
- Write for a reader who did not watch you work. Short sentences, plain words. Docs follow `~/git/brain/me/working-with-eugene.md`.
- This is Eugene's own side project. Keep it free of his employer's specs, policies and files; only the generic ideas already in `docs/design.md`. One exception, decided by Eugene on 2026-11-04: the agent library holds the runtime team, twelve agents adapted from the organization he designed at work (names, roles, groups, portraits; prompts rewritten for this harness). Nothing else from there.
