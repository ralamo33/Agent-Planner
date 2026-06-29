# Planner — Codebase Guide

Planner is a human-in-the-loop review tool. An agent generates an HTML plan (a design, report, diagram, proposal) and hands it to Planner, which opens it in the user's browser. The user annotates elements and sends feedback. The agent receives that feedback as structured JSON and iterates. The whole loop is localhost HTTP — no accounts, no cloud, no telemetry.

---

## Repository layout

```
bin/planner          Entry point. Dispatches argv[2] to the right handler.
src/store.js         Pure data layer. Reads/writes ~/.planner/state.json and manages plan files.
src/server.js        HTTP server. All routes, SSE, poll loop, presence state.
src/cli.js           Agent + user CLI commands. HTTP client only — never imports the server.
browser/chrome.js    Outer frame JS. Owns the chat panel, annotation queue, SSE listener.
browser/sdk.js       Injected into the plan iframe. Annotation UI, layout audit, postMessage bridge.
browser/chrome.css   Styles for the chrome frame only.
```

The `browser/` files are served as static assets by the server. They are never bundled.

---

## File storage

Planner owns all plan files. Agents never write to `~/.planner/` directly.

```
~/.planner/
  state.json           Session records (persists across server restarts)
  active_plans/        One .html file per active plan, named by plan name
  archived_plans/      Ended plans, named <plan-name>-<ISO-datetime>.html
```

---

## Agent commands (blocking)

Both commands block until the user sends feedback or ends the session.

```sh
planner open <name> <path>     # Copy <path> into active_plans/<name>.html, open browser, wait
planner update <name> <path>   # Replace active_plans/<name>.html, trigger reload, wait
```

- `open` fails if `<name>` already exists in active_plans.
- `update` fails if `<name>` does not exist in active_plans.
- Both return JSON on stdout when unblocked (see Output format below).

## User commands (non-blocking)

```sh
planner reopen <name>    # Re-open an active plan in the browser
planner restore <name>   # Move most-recent archive for <name> back to active, open browser
                         # Fails if an active plan with that name already exists
```

---

## Output format

When `open` or `update` unblocks, it prints JSON to stdout:

```json
{
  "session": { "name": "my-plan", "status": "feedback" },
  "prompts": [
    { "uid": "3", "prompt": "Make this bigger", "selector": "h1", "tag": "h1", "text": "Title" }
  ],
  "layout_warnings": [],
  "dom_snapshot": "uid=1 body\n  uid=2 h1 \"Title\"\n  ...",
  "next_step": "Apply feedback, then run `planner update my-plan <path>`."
}
```

If the user ends the session from the browser:

```json
{
  "session": { "name": "my-plan", "status": "ended" },
  "next_step": "Session ended. Plan has been archived."
}
```

**Always check `next_step`** — if there are layout errors, fix them before waiting for human feedback.

---

## Session lifecycle

```
planner open        →  active_plans/<name>.html created
                       browser opens
                       [blocks]
                       user sends feedback
                    ←  returns feedback JSON

planner update      →  active_plans/<name>.html replaced
                       browser reloads
                       [blocks]
                       user sends feedback
                    ←  returns feedback JSON

  ... repeat update loop until user clicks "End Session" in browser ...

user clicks End     →  active_plans/<name>.html moved to archived_plans/<name>-<ts>.html
                       session status set to "ended"
                    ←  current blocking update returns { status: "ended" }
```

---

## Server routes

| Route | Who calls it | Purpose |
|---|---|---|
| `GET /health` | CLI | Liveness check |
| `POST /shutdown` | CLI | Graceful shutdown |
| `POST /api/plans/open` | CLI | Copy file, create session |
| `POST /api/plans/update` | CLI | Replace file, broadcast reload |
| `POST /api/plans/archive` | chrome.js | Archive file, end session |
| `POST /api/plans/reopen` | CLI | Resume existing active session |
| `POST /api/plans/restore` | CLI | Move archive → active, resume session |
| `GET /api/poll?name=` | CLI | Long-poll for feedback (blocks, streams heartbeat) |
| `POST /api/:key/prompts` | chrome.js | Queue user annotations |
| `POST /api/:key/layout-warnings` | chrome.js | Submit layout audit findings |
| `POST /api/:key/agent-reply` | CLI (via poll --agent-reply) | Push agent message to chat |
| `GET /events/:key` | chrome.js | SSE stream (reload, agent-reply, agent-presence) |
| `GET /session/:key` | browser | Chrome shell HTML |
| `GET /plan/:key/index.html` | browser | Plan HTML with SDK injected |
| `GET /plan/:key/*` | browser | Plan sibling assets (CSS, images, fonts) |
| `GET /browser/*` | browser | Chrome static assets |

Session keys are plan names (e.g. `my-plan`). URLs look like `/session/my-plan`.

---

## Two browser contexts

The browser has two completely isolated JS environments:

**Chrome frame** (`chrome.js`) — the outer page served by the server. Can talk to the server via fetch. Owns the chat panel, annotation queue (persisted in sessionStorage), SSE connection, layout gate overlay, and presence banner.

**Plan iframe** (`sdk.js`) — sandboxed with `allow-scripts` but without `allow-same-origin`, giving it a null origin. Cannot fetch the server. Can only communicate with the chrome via `postMessage`. Owns annotation highlighting, click interception, selector generation, layout audit, and scroll tracking.

All messages between the two use the `planner:*` namespace (e.g. `planner:queuePrompt`, `planner:layoutWarnings`). Layout warnings travel: sdk.js → postMessage → chrome.js → POST /api/:key/layout-warnings.

---

## Agent presence states

Tracked in server memory (not persisted). Pushed to the browser over SSE.

- `waiting` — no agent is polling
- `listening` — agent is blocked in `/api/poll`
- `working` — poll returned feedback, agent is processing

The browser disables the Send button while presence is `working`.

---

## Layout audit

`sdk.js` runs automatically after fonts load and layout settles. It detects:
- `page-horizontal-overflow` — page wider than viewport
- `element-scroll-overflow` — element content overflows its box
- `clipped-text` — text hidden by `overflow: hidden`
- `element-parent-overflow` — element escapes its parent's bounds
- `overlapping-text` — text covered by another element

Error-severity findings hold the plan behind a "Checking layout" overlay until resolved. Warnings are recorded but don't block the reveal.

---

## Key implementation notes

- The poll response streams whitespace heartbeats every 15s so the agent's connection doesn't time out. The CLI's `fetchJson` trims whitespace before parsing.
- `open` and `update` in cli.js POST to the server then immediately call `GET /api/poll` internally — the agent just calls one command and waits.
- Sessions survive server restarts because `state.json` is read on every operation (no in-memory cache).
- The server self-shuts after 30 minutes with no SSE clients or active polls. The next CLI call restarts it transparently.
- Plan name validation: `[a-zA-Z0-9_-]`, max 64 chars.
- Asset path traversal is blocked: sibling asset paths are resolved and checked with `path.relative` to ensure they stay within the plan's directory.
