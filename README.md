# Planner

A human-in-the-loop review tool for AI agents. Your agent writes an HTML plan, opens it in your browser, then waits while you annotate it and send feedback. The whole loop runs over localhost — no accounts, no cloud, no telemetry.

## How it works

1. The agent writes an HTML plan (a design, report, diagram, proposal, etc.)
2. It calls `planner open` — your browser opens showing the plan
3. You click elements to annotate them, type notes, and hit **Send**
4. The agent receives your feedback as structured JSON and makes changes
5. It calls `planner poll --agent-reply "here's what I changed"` — you see the reply in the browser and can send more feedback

---

## Installation

**Requirements:** Node.js 18 or later

### 1. Clone the repo

```sh
git clone https://github.com/yourusername/planner.git ~/planner
```

Or anywhere you like — the location just needs to stay stable.

### 2. Add PLANNER_DIR to your shell

Add this line to your `~/.bashrc` or `~/.zshrc`:

```sh
export PLANNER_DIR="$HOME/planner"
```

Then reload your shell:

```sh
source ~/.bashrc   # or ~/.zshrc
```

### 3. Tell your AI agent how to use it

Add the following to `~/.claude/CLAUDE.md` (create the file if it doesn't exist):

```markdown
## Showing plans for review

When you want to show me something visual for feedback, use the planner tool:

  node $PLANNER_DIR/planner.mjs open <file>          # open plan in browser
  node $PLANNER_DIR/planner.mjs poll <file>          # wait for my feedback
  node $PLANNER_DIR/planner.mjs poll <file> --agent-reply "message"   # show a reply, then wait
  node $PLANNER_DIR/planner.mjs end <file>           # end the session

The poll command blocks until I send feedback. It returns JSON with:
- prompts: my annotations and messages
- layout_warnings: any layout issues detected automatically
- next_step: what to do next

Always check next_step — if there are layout errors, fix them before asking for my input.
```

That's it. No npm install, no global commands, no PATH changes.

---

## Verify it works

```sh
node $PLANNER_DIR/planner.mjs --version
```

---

## Usage example (what the agent does)

```sh
# Agent writes a plan
echo "<h1>My Plan</h1><p>Here is the plan...</p>" > /tmp/plan.html

# Agent opens it — your browser opens
node $PLANNER_DIR/planner.mjs open /tmp/plan.html

# Agent waits for your feedback — you annotate in the browser and click Send
node $PLANNER_DIR/planner.mjs poll /tmp/plan.html

# Agent edits /tmp/plan.html based on feedback, then shows its reply
node $PLANNER_DIR/planner.mjs poll /tmp/plan.html --agent-reply "Updated the plan based on your notes"

# You review and send more feedback, or the agent ends the session
node $PLANNER_DIR/planner.mjs end /tmp/plan.html
```

---

## State and privacy

Session state is stored locally at `~/.planner/state.json`. Nothing leaves your machine.

---

## Updating

```sh
cd $PLANNER_DIR && git pull
```

No reinstall needed — there's nothing to compile or install.
