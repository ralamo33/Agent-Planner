---
name: planner
description: Open an HTML artifact in a local browser review session so the user can annotate elements, type messages, and send feedback back to the agent. Use when you have generated an HTML plan, report, prototype, or visual artifact and want the user to review it interactively.
argument-hint: <path to html file or description>
---

# Planner

Planner is a human-in-the-loop review tool. You write an HTML file, open it with `planner open`, and the user reviews it in their browser — annotating elements, typing messages, and hitting Send. Both `open` and `update` block until the user sends feedback. You loop with `update` until the user ends the session.

## Request

$ARGUMENTS

If the argument is a file path, open that file. If it is a description or empty, write the HTML artifact first, then open it.

## Workflow

1. Write the HTML artifact to disk (see HTML rules below).
2. Run `planner open <name> <path>` — registers the session, opens the browser, blocks until feedback arrives.
3. Read `next_step` in the JSON output. If it reports layout errors, fix them and re-open before asking the user to review.
4. Apply the user's feedback and write the updated HTML to disk.
5. Run `planner update <name> <path>` — reloads the browser, blocks until the next round of feedback.
6. Repeat step 4–5 until the user clicks **End Session** in the browser, at which point the output has `status: "ended"`.

## Commands

```
planner open <name> <path>     # New session: copy file, open browser, block for feedback
planner update <name> <path>   # Replace file, reload browser, block for feedback
planner reopen <name>          # Re-open an active plan in the browser (non-blocking, user command)
planner restore <name>         # Restore most-recent archive to active (non-blocking, user command)
```

`<name>` must be unique, alphanumeric + dashes/underscores, max 64 chars.
`<path>` is the HTML file you wrote — planner copies it into its own storage.

If `planner` is not on PATH, run `node ~/Workspace/planner/bin/planner` instead.

## Output format

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

When `status` is `"ended"`, the user is done. Do not call `update` again.

Always read `next_step` first. If there are layout errors, fix them before the user sees the plan.

## HTML rules (must follow to pass the layout audit)

The browser runs an automatic layout audit after each load. Errors block the review gate until fixed.

**Block elements only for content** — never put `<code>`, `<strong>`, or `<em>` inline inside `<p>` text. Use a `<span class="mono">` styled as `display: inline-block` or plain text instead.

**Every container needs:**
```css
max-width: 100%;
overflow-wrap: break-word;
word-break: break-word;
```

**Flex children need** `min-width: 0` to allow shrinking.

**Monospace snippets** — use `<pre>` with:
```css
white-space: pre-wrap;
word-break: break-all;
overflow-x: auto;
```

**Short code labels** — if you need inline monospace, use `display: inline-block; max-width: 100%; word-break: break-all` on the element.

**Safe starter CSS:**
```css
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; padding: 32px; max-width: 860px; margin: 0 auto; }
.mono { font-family: monospace; font-size: 12px; background: #f0f0f0;
        padding: 1px 5px; border-radius: 3px;
        display: inline-block; max-width: 100%; word-break: break-all; }
pre { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 6px;
      font-size: 12px; white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
```
