# Planner — Build Plan Overview

Human-in-the-loop review tool for AI agents. The agent writes an HTML artifact, opens it in a browser, then long-polls for feedback the human writes by annotating the page. Runs entirely on localhost. No telemetry, no external services, no npm dependencies.

## Installation (for users)

1. Clone the repo anywhere
2. Add `export PLANNER_DIR=/path/to/repo` to `.bashrc` / `.zshrc`
3. Add to `~/.claude/CLAUDE.md`:
   ```
   To show an artifact to the user for review:
     node $PLANNER_DIR/planner.mjs open <file>
     node $PLANNER_DIR/planner.mjs poll <file>
     node $PLANNER_DIR/planner.mjs poll <file> --agent-reply "message"
     node $PLANNER_DIR/planner.mjs end <file>
   ```

## Agent-facing interface

```sh
node $PLANNER_DIR/planner.mjs open artifact.html
node $PLANNER_DIR/planner.mjs poll artifact.html
node $PLANNER_DIR/planner.mjs poll artifact.html --agent-reply "here's what I changed"
node $PLANNER_DIR/planner.mjs end artifact.html
```

Poll returns JSON to stdout:
```json
{
  "session": { "file": "...", "status": "feedback" },
  "prompts": [...],
  "layout_warnings": [...],
  "dom_snapshot": "...",
  "next_step": "..."
}
```

`next_step` is load-bearing — the agent reads it to know what to do next.

## File structure

```
planner/
├── planner.mjs          (single file: client + server + store, ~700 lines, zero deps)
├── browser/
│   ├── chrome.js        (~300 lines — outer frame JS, served as static file)
│   ├── chrome.css       (~200 lines)
│   └── sdk.js           (~380 lines — injected into artifact iframe at serve time)
├── plans/               (build plans, not shipped)
└── README.md            (human install guide)
```

**Zero npm dependencies.** Uses only Node built-ins: `node:http`, `node:fs`, `node:crypto`, `node:path`, `node:os`, `node:child_process`, `node:url`.

One exception: opening the browser. Use `node:child_process` to call `xdg-open` (Linux), `open` (Mac), or `start` (Windows) directly — no `open` package needed.

## Architecture

```
Agent (Claude, etc.)
  ↕ node $PLANNER_DIR/planner.mjs open|poll|end
planner.mjs acting as CLI (thin HTTP client)
  ↕ HTTP to localhost:4737
planner.mjs acting as server (spawned detached)
  ↕ HTTP + SSE
Browser: chrome shell (outer) + artifact iframe (sandboxed)
  ↑ human sits here
```

`planner.mjs` is both client and server. When the client detects no server running (`/health` fails), it spawns a detached copy of itself with `node planner.mjs server` and waits up to 5s for it to come up.

**Port:** 4737

## Single-file design

`planner.mjs` is divided into clearly labelled sections:

1. **Config + constants** — port, state path, idle timeout
2. **Store** — all `~/.planner/state.json` read/write functions
3. **Server** — `node:http` request handler, routing, SSE, long-poll
4. **Browser open** — cross-platform `xdg-open` / `open` / `start`
5. **Client commands** — `open`, `poll`, `end`, `ensureServer`
6. **Entry point** — dispatch on `process.argv[2]`

## State schema

Stored at `~/.planner/state.json`:

```json
{
  "sessions": {
    "<key16>": {
      "key": "a1b2c3d4e5f6a7b8",
      "file": "/absolute/path/artifact.html",
      "url": "http://127.0.0.1:4737/session/<key>",
      "status": "open",
      "pending_prompts": 0,
      "prompts": [],
      "layout_warnings": [],
      "dom_snapshot": "",
      "chat": [{ "role": "user|agent", "text": "...", "at": "<iso>" }],
      "updated_at": "<iso>"
    }
  }
}
```

Status flow: `open` → `feedback` (prompts queued) → `open` (after takeFeedback clears them) → `ended`

Session key: `sha256(realpath(file)).hex().slice(0, 16)`

## Server routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ ok: true, app: "planner" }` |
| POST | `/shutdown` | Graceful exit |
| POST | `/api/sessions` | Register/resume session |
| GET | `/api/poll` | Long-poll with heartbeat |
| POST | `/api/:key/prompts` | Browser submits prompt batch |
| POST | `/api/:key/layout-warnings` | Iframe reports layout audit |
| POST | `/api/:key/agent-reply` | CLI sends agent reply text |
| POST | `/api/end` | End session |
| GET | `/session/:key` | Chrome shell HTML |
| GET | `/artifact/:key/index.html` | Artifact HTML with SDK injected |
| GET | `/artifact/:key/*` | Sibling assets (path traversal guarded) |
| GET | `/events/:key` | SSE stream |
| GET | `/browser/:file` | Serve files from `browser/` directory |

## Iframe sandbox + SDK injection

The artifact is served inside `<iframe sandbox="allow-scripts allow-forms allow-popups allow-downloads">`. `allow-same-origin` is intentionally omitted — chrome ↔ iframe can only communicate via `postMessage`.

`browser/sdk.js` is injected at serve time: the server reads the artifact HTML, appends `<script src="/browser/sdk.js?key=..."></script>` before `</body>`, and serves the result. The file on disk is never modified.

## postMessage protocol (chrome ↔ iframe)

**SDK → chrome:**
| Type | When |
|---|---|
| `planner:queuePrompt` | User queues an annotation |
| `planner:snapshot` | Response to `requestSnapshot` |
| `planner:layoutWarnings` | After layout audit completes |
| `planner:scroll` | On scroll (RAF-throttled) |

**Chrome → SDK:**
| Type | When |
|---|---|
| `planner:setAnnotationMode` | On toggle switch |
| `planner:requestSnapshot` | Before submit |
| `planner:restoreScroll` | After iframe load |

## Presence states (SSE → browser)

- `waiting` — no active poll
- `listening` — poll blocking
- `working` — feedback delivered, agent processing

Tracked in-memory only (not persisted). Pushed over SSE as `agent-presence` events.

## Long-poll heartbeat

Response body is `" " " " ... "<JSON>"` — leading spaces are heartbeat bytes sent every 15s, JSON payload ends the stream. `JSON.parse` ignores leading whitespace, so the client just does `JSON.parse(responseText)`.

## Build phases

| Phase | Scope | Test when done |
|---|---|---|
| **1 — Core: store + server** | `planner.mjs` sections 1–3 (no browser serving yet) | `curl` routes directly |
| **2 — Client commands** | `planner.mjs` sections 4–6 | `node planner.mjs open/poll/end` from terminal |
| **3 — Chrome shell + SSE** | `browser/chrome.js`, `browser/chrome.css`, chrome HTML route | Open browser, verify presence + chat |
| **4 — Artifact SDK + injection** | `browser/sdk.js`, artifact routes | Annotations work, prompts reach poll |
| **5 — Layout audit** | Audit block in `sdk.js`, layout gate in `chrome.js` | Overflow HTML triggers `layout_warnings` |
