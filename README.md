# Planner

A human-in-the-loop review tool for AI agents. Your agent writes an HTML plan, opens it in your browser, then waits while you annotate it and send feedback. The whole loop runs over localhost — no accounts, no cloud, no telemetry.

## How it works

1. The agent writes an HTML artifact (design, report, diagram, proposal)
2. It calls `planner open <name> <path>` — your browser opens showing the plan
3. You click elements to annotate them, type notes, and hit **Send**
4. The agent receives structured JSON feedback and makes changes
5. It calls `planner update <name> <path>` — the browser reloads with the new version and the agent waits again
6. Repeat until satisfied, then click **End Session** — the plan is archived and the agent is unblocked

---

## Installation

**Requirements:** Node.js 18 or later

### 1. Clone the repo

```sh
git clone <repo-url> ~/planner
cd ~/planner
npm install
npm link   # makes `planner` available globally
```

### 2. Add to Claude's context

Add the following to `~/.claude/CLAUDE.md` (create the file if it doesn't exist):

```markdown
## Showing plans for review

Use the planner CLI to get visual feedback on HTML artifacts:

  planner open <name> <path>      # copy plan into Planner storage, open browser, block for feedback
  planner update <name> <path>    # replace plan with new version, reload browser, block for feedback
  planner reopen <name>           # re-open an active plan in the browser (user command, returns immediately)
  planner restore <name>          # restore an archived plan to active (user command, returns immediately)

<name> must be unique, alphanumeric with dashes/underscores, max 64 chars.
<path> is the HTML file you wrote — Planner copies it into its own storage.

open and update block until the user sends feedback or ends the session.
Both return JSON on stdout:

{
  "session": { "name": "...", "status": "feedback" | "ended" },
  "prompts": [{ "uid": "...", "prompt": "...", "selector": "...", "text": "..." }],
  "layout_warnings": [],
  "dom_snapshot": "...",
  "next_step": "..."
}

Always check next_step — if there are layout errors, fix them before asking for human feedback.
If status is "ended", the user has finished reviewing; do not call update again.
```

---

## Agent usage example

```sh
# Agent writes a plan
cat > /tmp/my-plan.html << 'EOF'
<h1>Project Plan</h1>
<p>Phase 1: Foundation (3 days)</p>
<p>Phase 2: UI (5 days)</p>
EOF

# Opens browser and blocks until user sends feedback
planner open my-plan /tmp/my-plan.html

# Agent revises the plan and calls update — browser reloads and blocks again
planner update my-plan /tmp/my-plan-v2.html

# User eventually clicks End Session in the browser
# update returns: { "session": { "status": "ended" }, "next_step": "Session ended. Plan has been archived." }
```

---

## Plan storage

Planner manages all plan files at `~/.planner/`:

```
~/.planner/
  state.json              Session records (survives server restarts)
  active_plans/           One .html file per active plan
  archived_plans/         Ended plans, named <name>-<ISO-datetime>.html
```

The agent's source file is never modified — Planner copies it into its storage on `open`.

---

## User commands

These open the browser and return immediately (no blocking):

```sh
# Re-open an active plan (e.g. if you closed the tab)
planner reopen my-plan

# Restore the most recent archive for a plan name back to active
# Fails if an active plan with that name already exists
planner restore my-plan
```

---

## Privacy

Nothing leaves your machine. All state is in `~/.planner/`. The server runs on port 4737 and exits after 30 minutes of inactivity.
