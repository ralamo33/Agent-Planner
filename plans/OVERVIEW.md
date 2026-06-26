# Lavish — Build Plan Overview

Clean Node.js reimplementation of lavish-axi. A human-in-the-loop review tool an AI agent drives with 3 bash commands. Runs entirely on localhost. No telemetry, no external services, no opaque dependencies.

## Agent-facing interface

```
lavish open artifact.html         # register session, open browser
lavish poll artifact.html         # block until human sends feedback, return JSON
lavish poll artifact.html --agent-reply "here's what I changed"
lavish end artifact.html          # end session
```

Poll returns:
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
lavish/
├── package.json
├── bin/
│   └── lavish                      (~3 lines: shebang + ESM import + dispatch)
└── src/
    ├── cli.js                      (~200 lines)
    ├── server.js                   (~280 lines)
    ├── store.js                    (~130 lines)
    └── browser/
        ├── artifact-sdk.js         (~380 lines — browser JS, no ESM imports)
        ├── chrome-client.js        (~300 lines — browser JS)
        └── chrome.css              (~200 lines)
```

**Dependencies — only two:**
- `express` ^5
- `open` ^10

## Architecture

```
Agent (Claude, etc.)
  ↕ 3 bash commands: open / poll / end
CLI (thin HTTP client, src/cli.js)
  ↕ HTTP to localhost:4387
Express server (src/server.js) + state (~/.lavish/state.json)
  ↕ HTTP + SSE
Browser: chrome shell (outer frame) + artifact iframe
  ↑ human sits here
```

**Key invariants:**
- Session key = `sha256(realpath(file)).hex().slice(0, 16)` — two paths to the same file collapse to one session
- State is read from disk on every op, written back immediately — no in-memory cache, sessions survive restarts
- Iframe sandboxed without `allow-same-origin` — chrome ↔ iframe comms are postMessage only
- SDK injected at serve time (script tag appended), artifact file never modified on disk
- Poll streams whitespace heartbeat every 15s so agent harness doesn't timeout; JSON payload ends the response
- Server self-shuts after 30 min idle

## Build phases

Each phase is testable before the next one starts.

| Phase | Files | Test when done |
|---|---|---|
| **1 — Store + server core** | `package.json`, `src/store.js`, `src/server.js` | `curl` routes directly |
| **2 — CLI** | `bin/lavish`, `src/cli.js` | `lavish open` + `lavish poll` from terminal |
| **3 — Chrome shell + SSE** | `src/browser/chrome.css`, `src/browser/chrome-client.js`, chrome HTML in server.js | Open browser, verify presence states + chat |
| **4 — Artifact SDK + injection** | `src/browser/artifact-sdk.js`, artifact routes in server.js | Annotations work in iframe, prompts reach poll |
| **5 — Layout audit** | Layout audit block in `artifact-sdk.js`, layout gate in `chrome-client.js` | Overflow HTML triggers `layout_warnings` in poll |

See `plans/phase-*.md` for per-phase implementation detail.

## State schema

```json
{
  "sessions": {
    "<key16>": {
      "key": "a1b2c3d4e5f6a7b8",
      "file": "/absolute/path/artifact.html",
      "url": "http://127.0.0.1:4387/session/<key>",
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

## Server routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ ok: true, app: "lavish" }` |
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
| GET | `/sdk.js` | Generated SDK IIFE |
| GET | `/chrome-client.js` | Browser chrome script |
| GET | `/chrome.css` | Browser chrome styles |

## postMessage protocol (chrome ↔ iframe)

**SDK → chrome:**
| Type | When |
|---|---|
| `lavish:queuePrompt` | User queues an annotation |
| `lavish:sendQueuedPrompts` | Cmd+Enter in annotation card |
| `lavish:snapshot` | Response to `requestSnapshot` |
| `lavish:layoutWarnings` | After layout audit completes |
| `lavish:scroll` | On scroll (RAF-throttled) |

**Chrome → SDK:**
| Type | When |
|---|---|
| `lavish:setAnnotationMode` | On toggle switch |
| `lavish:requestSnapshot` | Before submit |
| `lavish:restoreScroll` | After iframe load |

## Presence states (SSE → browser)

- `waiting` — no active poll
- `listening` — poll blocking
- `working` — feedback delivered, agent processing

Tracked in-memory only (not persisted). Changes pushed over SSE as `agent-presence` events.
