import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { gh, ghJson, parseRemote } from './github/gh.js';
import { run } from './util/exec.js';
import { loadOrganization, findConfigFile, CONFIG_FILE } from './org/contract.js';
import { loadLibrary, type LibraryAgent } from './org/library.js';
import { TASK_STATUSES, STATUS_MEANING } from './github/task-store.js';

/** What a new organization is made of. Defaults: the folder's name, the library's director and writer. */
export interface OrgChoice {
  name?: string;
  director?: string;
  agents?: LibraryAgent[];
}

/** `agentic-loop init <folder>` and the page's builder: writes the starter organization files that are missing. */
export async function initOrganization(folder: string, choice: OrgChoice = {}): Promise<string[]> {
  const written: string[] = [];
  const put = async (rel: string, content: string, mode?: number): Promise<void> => {
    const full = path.join(folder, rel);
    try {
      await fs.access(full);
      return;
    } catch {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, mode !== undefined ? { mode } : {});
      written.push(rel);
    }
  };
  const name = choice.name ?? path.basename(path.resolve(folder)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const library = choice.agents ? [] : await loadLibrary();
  const director = choice.director ?? library.find((a) => a.required)?.name ?? 'director';
  const agents = choice.agents ?? library.filter((a) => a.required || a.name === 'vega');
  await put((await findConfigFile(folder)) ?? CONFIG_FILE, `# The organization Agentic Loop runs. See docs/design.md in the Agentic Loop repository.
name: ${name}
# logo: avatars/logo.png   # one emoji or an image file in this repository; the page shows it in the header
director: ${director}          # the agent that reads the inbox and assigns work
model: claude-opus-5-5      # default model for every agent; an agent may pin its own
github:
  # project: 1              # the GitHub Project number; "agentic-loop setup <folder>" fills it in
paths:                      # where this repository keeps its files; these are the defaults
  agents: agents
  actions: actions
  control: control
lease:
  director_minutes: 20      # one laptop is the Director for this long, then anyone may take over
  task_minutes: 30          # a claimed task returns to the queue if the laptop goes quiet this long
  renew_minutes: 5
  plan_every_minutes: 10
budgets:
  max_turns: 40
  max_budget_usd: 15        # the SDK's own estimate, a safety cap; on a subscription nothing is billed per run
  timeout_minutes: 30
loops:
  agent_seconds: 60
  mechanical_seconds: 120
`);
  for (const a of agents) {
    await put(`agents/${a.name}.md`, a.text);
    if (a.avatarFile && a.avatar) {
      const to = path.join(folder, a.avatar);
      try {
        await fs.access(to);
      } catch {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(a.avatarFile, to);
        written.push(a.avatar);
      }
    }
  }
  await put('README.md', `# ${name}

An organization of AI agents, run by [Agentic Loop](https://github.com/dashing-ws/dashing-agent). The agents are the files under agents/; the actions the mechanical loop may run are under actions/; control/kill stops every laptop. Tasks are issues on this repository's Project.
`);
  await put('actions/echo/manifest.yaml', `name: echo
description: Prints a message. The smallest possible action, here to test the mechanical loop.
timeout_minutes: 1
params:
  message:
    type: string
    pattern: "^[A-Za-z0-9 .,!?-]{1,200}$"
    required: true
`);
  await put('actions/echo/run.sh', `#!/usr/bin/env bash
set -euo pipefail
echo "task #$AGENTIC_LOOP_TASK on $AGENTIC_LOOP_NODE says: $AGENTIC_LOOP_PARAM_MESSAGE"
`, 0o755);
  await put('control/.gitkeep', '');
  await put('.github/workflows/agentic-loop-leases.yml', `# Deletes expired lease refs so the board tells the truth. Correctness never depends on this:
# an expired lease is claimable with or without it.
name: Agentic Loop leases
on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Delete expired leases
        run: |
          now=$(date -u +%s)
          git ls-remote origin 'refs/agentic-loop/leases/*' | while read -r sha ref; do
            git fetch -q origin "$ref"
            until=$(git log -1 --format=%B "$sha" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Math.floor(Date.parse(JSON.parse(s).until)/1000))}catch{console.log(0)}})')
            if [ "$until" -lt "$now" ]; then
              echo "expired: $ref"
              git push -q --force-with-lease="$ref:$sha" origin ":$ref" || true
            fi
          done
`);
  return written;
}

interface FieldJson {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string }>;
}

/**
 * `agentic-loop setup <folder>`: creates the GitHub Project for the organization (or repairs it),
 * gives Status the statuses both loops use and Agent one option per agent, and writes the
 * project number into agentic-loop.yaml.
 */
export async function setupProject(folder: string, log: (t: string) => void): Promise<void> {
  const dir = path.resolve(folder);
  const load = await loadOrganization(dir);
  if (!load.org) throw new Error(`the organization files do not load:\n- ${load.problems.join('\n- ')}`);
  const org = load.org;
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  const repo = remote.code === 0 ? parseRemote(remote.stdout) : null;
  if (!repo || repo.host !== 'github.com') throw new Error('origin is not a github.com remote');
  const owner = repo.owner;

  let number = org.config.github.project;
  if (!number) {
    // A run that failed after creating the Project must not create another: reuse one with the organization's name.
    const existing = await ghJson<{ projects: { number: number; title: string; url: string; closed: boolean }[] }>(['project', 'list', '--owner', owner, '--format', 'json', '--limit', '100']);
    const same = existing.projects.filter((p) => !p.closed && p.title === org.config.name).sort((a, b) => a.number - b.number);
    if (same[0]) {
      number = same[0].number;
      log(`found project #${number} named ${org.config.name}: ${same[0].url}${same.length > 1 ? ` (${same.length - 1} more with the same name; delete the extras: gh project delete <number> --owner ${owner})` : ''}`);
    } else {
      const created = await ghJson<{ number: number; url: string }>(['project', 'create', '--owner', owner, '--title', org.config.name, '--format', 'json']);
      number = created.number;
      log(`created project #${number}: ${created.url}`);
    }
    const link = await run('gh', ['project', 'link', String(number), '--owner', owner, '--repo', `${owner}/${repo.name}`]);
    log(link.code === 0 ? `linked it to ${owner}/${repo.name}` : `link to ${owner}/${repo.name}: ${link.stderr.trim().split('\n')[0] || 'already linked'}`);
  } else {
    log(`using project #${number}`);
  }

  const fields = await ghJson<{ fields: FieldJson[] }>(['project', 'field-list', String(number), '--owner', owner, '--format', 'json', '--limit', '100']);
  const byName = new Map(fields.fields.map((f) => [f.name.toLowerCase(), f]));

  const status = byName.get('status');
  if (!status) throw new Error('the project has no Status field; GitHub creates one for every project, so this is unexpected');
  const haveStatus = new Set((status.options ?? []).map((o) => o.name));
  const missingStatus = TASK_STATUSES.filter((s) => !haveStatus.has(s));
  if (missingStatus.length) {
    const options = [
      ...(status.options ?? []).map((o) => ({ name: o.name, color: 'GRAY', description: '' })),
      ...missingStatus.map((s) => ({ name: s, color: colorFor(s), description: STATUS_MEANING[s] })),
    ];
    await updateSingleSelect(status.id, options);
    log(`Status gained: ${missingStatus.join(', ')}`);
  } else {
    log('Status has every status');
  }

  const agentNames = org.agents.map((a) => a.name);
  const agent = byName.get('agent');
  if (!agent) {
    await gh(['project', 'field-create', String(number), '--owner', owner, '--name', 'Agent', '--data-type', 'SINGLE_SELECT', '--single-select-options', agentNames.join(',')]);
    log(`created the Agent field with ${agentNames.join(', ')}`);
  } else {
    const have = new Set((agent.options ?? []).map((o) => o.name));
    const missing = agentNames.filter((a) => !have.has(a));
    if (missing.length) {
      const options = [
        ...(agent.options ?? []).map((o) => ({ name: o.name, color: 'GRAY', description: '' })),
        ...missing.map((a) => ({ name: a, color: 'BLUE', description: org.agents.find((x) => x.name === a)?.role ?? '' })),
      ];
      await updateSingleSelect(agent.id, options);
      log(`Agent gained: ${missing.join(', ')}`);
    } else {
      log('Agent has every agent');
    }
  }

  if (org.config.github.project !== number) {
    await writeProjectNumber(path.join(dir, org.configFile), number);
    log(`wrote github.project: ${number} into ${org.configFile}; commit and push it so every laptop sees it`);
  }
}

/** Writes `github.project` into agentic-loop.yaml, keeping the rest of the file and its comments. */
export async function writeProjectNumber(file: string, number: number): Promise<void> {
  const doc = YAML.parseDocument(await fs.readFile(file, 'utf8'));
  const github = doc.get('github');
  if (YAML.isMap(github)) github.set('project', number);
  else doc.set('github', doc.createNode({ project: number }));
  await fs.writeFile(file, doc.toString());
}

async function updateSingleSelect(fieldId: string, options: Array<{ name: string; color: string; description: string }>): Promise<void> {
  const mutation = `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
      projectV2Field { ... on ProjectV2SingleSelectField { id options { name } } }
    }
  }`;
  await gh(['api', 'graphql', '-f', `query=${mutation}`, '-F', `fieldId=${fieldId}`, '--input', '-'], {
    input: JSON.stringify({ query: mutation, variables: { fieldId, options } }),
  });
}

function colorFor(s: string): string {
  switch (s) {
    case 'Inbox': return 'GRAY';
    case 'Assigned': return 'BLUE';
    case 'Running': return 'PURPLE';
    case 'Review': return 'YELLOW';
    case 'Approved': return 'ORANGE';
    case 'Executing': return 'PINK';
    case 'Done': return 'GREEN';
    case 'Failed': return 'RED';
    default: return 'GRAY';
  }
}
