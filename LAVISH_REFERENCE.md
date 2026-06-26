# Lavish-axi Reference

We reverse-engineered lavish-axi (https://github.com/lavish-axi) as a reference for building a similar tool. This doc captures what it does and why, so we can build our own clean version with no telemetry or opaque dependencies.

## What it is

A human-in-the-loop review tool for AI agents. The agent generates an HTML artifact, opens it in a browser via a CLI command, then long-polls for feedback the human writes by annotating the page. The whole feedback loop runs over localhost HTTP. No external services involved (except telemetry, which we are intentionally omitting).

## The feedback loop from the agent's perspective

```
agent writes artifact.html
agent: lavish-axi open artifact.html     # registers session, opens browser
agent: lavish-axi poll artifact.html     # blocks until human acts

  [human annotates elements or types in the panel, hits Send]

poll returns JSON: { prompts: [...], dom_snapshot: "..." }

agent edits artifact.html
agent: lavish-axi poll artifact.html --agent-reply "here's what I changed"
# shows agent message in browser, blocks again
```

The agent never touches the browser directly. It only ever calls 3 CLI commands. The CLI is the entire API surface the agent sees.

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

The SDK script is generated server-side by serializing the artifact SDK functions as strings and wrapping them in an IIFE. The file on disk stays byte-identical.

## Session identity

Sessions are keyed by `sha256(canonicalFilePath).slice(0, 16)`. Two paths to the same file always collapse to the same session. State lives in `~/.lavish-axi/state.json` — a flat JSON file that is read and rewritten on every operation. No in-memory cache. Sessions survive server restarts.

## Server routes (the ones that matter)

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

This lets the browser block the Send button while the agent is working.

## Layout audit

The artifact SDK runs a layout audit after fonts and ResizeObserver settle. It checks for:
- Page horizontal overflow
- Element scroll overflow
- Clipped text (overflow hidden with readable text inside)
- Overlapping text (via elementFromPoint)

Findings are POSTed to `/api/:key/layout-warnings` and delivered to the agent on the next poll, with a `next_step` telling the agent to fix layout issues before involving the human. Error-severity findings hold the chrome behind a curtain until resolved.

## What we are building instead

A clean reimplementation with:
- No telemetry
- No `axi-sdk-js` dependency (replace with plain fetch calls)
- No playbook/design reference system (add later if needed)
- No version handshake / server upgrade machinery (add later if needed)
- Full auditability — every line of code written by us

Estimated core size: ~400-600 lines of Node.js.

## Key implementation notes

- The poll must stream whitespace heartbeat bytes on indefinite polls so the agent's harness doesn't think the connection died
- The `next_step` field in poll JSON output is how you tell the agent what to do next — this is load-bearing for the agent workflow
- Queued prompts must survive server restarts (store in the JSON file, not memory)
- The chrome must store queued prompts in sessionStorage so they survive iframe reloads
- Sibling asset paths must be sandboxed to the artifact's directory (reject `..` path traversal)
- The server should self-shutdown when idle to avoid dangling background processes
