# Lavish-axi Reference

We reverse-engineered lavish-axi as a reference for building Planner. This doc captures what it does and why, so we can understand the decisions behind the design. Planner diverges from lavish-axi in several deliberate ways — see the bottom of this doc.

## What it is

A human-in-the-loop review tool for AI agents. The agent generates an HTML artifact, opens it in a browser via a CLI command, then long-polls for feedback the human writes by annotating the page. The whole feedback loop runs over localhost HTTP. No external services involved (except telemetry, which Planner omits).

## The feedback loop from the agent's perspective (lavish-axi)

```
agent writes artifact.html
agent: lavish-axi open artifact.html     # registers session, opens browser
agent: lavish-axi poll artifact.html     # blocks until human acts

  [human annotates elements or types in the panel, hits Send]

poll returns JSON: { prompts: [...], dom_snapshot: "..." }

agent edits artifact.html
agent: lavish-axi poll artifact.html --agent-reply "here's what I changed"
# shows agent message in browser, blocks again

agent: lavish-axi end artifact.html      # agent controls end of session
```

## Architecture

```
Agent (Claude, etc.)
  ↕ only 3 bash commands: open / poll / end
CLI (thin HTTP client)
  ↕ HTTP to localhost
Express server + state.json
  ↕ HTTP + SSE
Browser UI (chrome frame + artifact iframe)
  ↑ human sits here
```

## The two browser-side JS contexts

The agent's HTML is served inside a sandboxed `<iframe sandbox="allow-scripts allow-forms allow-popups allow-downloads">`. Crucially, `allow-same-origin` is omitted — so the iframe and the outer chrome frame cannot read each other's DOM even though they're on the same localhost server. All communication is `postMessage`.

**Chrome** (`chrome-client.js`): the outer frame the server generates. Manages the conversation panel, annotation toggle, queued prompts (stored in sessionStorage), and the SSE connection for live reload and agent presence states. POSTs prompt batches to `/api/:key/prompts`.

**Artifact SDK** (injected into the iframe): handles click/hover annotation highlighting, element selector generation, text selection with range boundaries, layout audit, and scroll position relay. It can only talk to the chrome via `postMessage` because of the sandbox.

The sandbox exists to protect the user — an agent-generated HTML file shouldn't be able to read the chrome's DOM or escape its context.

## The SDK injection

Lavish never modifies the agent's HTML file on disk. Before serving it, the server appends:

```html
<script src="/sdk.js?key=..."></script>
```

The SDK script is generated server-side by serializing the artifact SDK functions as strings and wrapping them in an IIFE. The file on disk stays byte-identical. Planner uses the same approach.

## Session identity (lavish-axi)

Sessions are keyed by `sha256(canonicalFilePath).slice(0, 16)`. Two paths to the same file always collapse to the same session. State lives in `~/.lavish-axi/state.json` — a flat JSON file that is read and rewritten on every operation. No in-memory cache. Sessions survive server restarts.

**Planner diverges here:** session key is the plan name (e.g. `my-plan`), not a hash. The plan file is owned and stored by Planner in `~/.planner/active_plans/`, not referenced by path from wherever the agent wrote it.

## Server routes (lavish-axi)

| Route | Purpose |
|---|---|
| `POST /api/sessions` | Register/resume a session |
| `GET /api/poll?file=...` | Long-poll for feedback, streams whitespace heartbeat |
| `POST /api/:key/prompts` | Browser queues a prompt batch |
| `POST /api/:key/layout-warnings` | Iframe reports layout audit results |
| `GET /session/:key` | Serve the chrome shell HTML |
| `GET /artifact/:key/index.html` | Serve artifact HTML with SDK injected |
| `GET /events/:key` | SSE: reload, agent-reply, agent-presence, chrome-reload |
| `GET /health` | Version handshake |
| `POST /shutdown` | Graceful shutdown |

## Agent presence states

The browser shows one of three states pushed over SSE:
- `waiting` — no poll has connected yet
- `listening` — a poll is actively blocking
- `working` — poll delivered feedback, agent is processing

This lets the browser block the Send button while the agent is working. Planner uses the same three states.

## Layout audit

The artifact SDK runs a layout audit after fonts and ResizeObserver settle. It checks for:
- Page horizontal overflow
- Element scroll overflow
- Clipped text (overflow hidden with readable text inside)
- Overlapping text (via elementFromPoint)

Findings are delivered to the agent on the next poll, with a `next_step` telling the agent to fix layout issues before involving the human. Error-severity findings hold the chrome behind a curtain until resolved.

**Lavish-axi bug we avoided:** the sandboxed iframe tried to POST layout warnings directly to the server. Because the iframe has no `allow-same-origin`, it gets a null opaque origin and the fetch silently fails. Planner routes layout warnings through `postMessage` to chrome.js, which then POSTs them to the server.

## Key implementation notes (that apply to Planner too)

- The poll must stream whitespace heartbeat bytes so the agent's connection doesn't time out. The CLI's `fetchJson` trims whitespace before parsing.
- The `next_step` field in poll JSON is how you tell the agent what to do next — load-bearing for the agent workflow.
- Queued prompts must survive server restarts (store in state.json, not memory).
- The chrome must store queued prompts in sessionStorage so they survive iframe reloads.
- Sibling asset paths must be sandboxed to the artifact's directory (reject `..` path traversal).
- The server should self-shutdown when idle to avoid dangling background processes.

---

## How Planner diverges from lavish-axi

| Topic | lavish-axi | Planner |
|---|---|---|
| Session key | sha256 of file path | plan name |
| File ownership | agent owns the file; lavish references it by path | Planner copies the file into `~/.planner/active_plans/` |
| Session end | agent calls `end` CLI command | user clicks End Session in the browser; triggers archive |
| Plan archiving | not built in | `~/.planner/archived_plans/<name>-<ISO-datetime>.html` |
| CLI API surface | `open` / `poll` / `end` | `open` / `update` (agent); `reopen` / `restore` (user) |
| Blocking | `poll` is a separate step after `open` | `open` and `update` block internally — one command per round trip |
| Telemetry | present | removed |
| Dependencies | `express`, `axi-sdk-js`, others | `express`, `open` only |
| State dir | `~/.lavish-axi/` | `~/.planner/` |
| Port | 4387 | 4737 |
