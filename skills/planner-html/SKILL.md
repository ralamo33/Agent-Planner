---
name: planner-html
description: Convert a raw plan, report, or proposal into layout-audit-safe HTML ready for `planner open`. Use when you need to turn a prose or structured description into a visual artifact that will pass planner's automatic layout audit without overflow or clipping errors.
argument-hint: <description or structured content to convert>
---

# Planner HTML Generator

You are a subagent whose only job is to produce a single self-contained HTML file from the content below. The file must pass planner's automatic layout audit (no `element-scroll-overflow`, `clipped-text`, `overlapping-text`, or `page-horizontal-overflow` errors).

## Content to convert

$ARGUMENTS

## Output

Write the HTML to a file in `/tmp/` and print the absolute path on the last line, prefixed with `PATH:`. Example:

```
PATH: /tmp/my-plan.html
```

## Mandatory layout rules

These rules are non-negotiable. Every violation becomes a layout error that blocks the review gate.

### 1. No inline elements inside prose

**Never** do this:
```html
<p>Server uses <code>node:http</code> module.</p>
```

**Do this instead:**
```html
<p>Server uses the <span class="mono">node:http</span> module.</p>
```

Where `.mono` is `display: inline-block` (see CSS below). The key is that `display: inline` elements have `clientWidth = 0`, so the audit always flags them regardless of content width.

### 2. All containers must constrain text

Every `div`, `td`, `li`, `p`, flex child — anything that holds text — must have:
```css
max-width: 100%;
overflow-wrap: break-word;
word-break: break-word;
```

Apply it globally with `* { overflow-wrap: break-word; word-break: break-word; }` and override as needed.

### 3. Flex children must have min-width: 0

Any element that is a flex child must have `min-width: 0` or it cannot shrink below its content width.

### 4. Monospace blocks use pre with wrapping

```css
pre {
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
```

Never use `white-space: pre` without `pre-wrap` — it prevents wrapping.

### 5. Inline code labels

For short filenames, flags, or identifiers inline in text, use:
```html
<span class="mono">planner open</span>
```

With CSS:
```css
.mono {
  font-family: monospace;
  font-size: 12px;
  background: #f0f0f0;
  padding: 1px 5px;
  border-radius: 3px;
  display: inline-block;
  max-width: 100%;
  word-break: break-all;
}
```

`display: inline-block` gives the element a real `clientWidth`, which the audit can measure correctly.

## Starter template

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Plan</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0;
        overflow-wrap: break-word; word-break: break-word; }
    body { font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6;
           color: #1a1a1a; background: #f8f8f6; padding: 32px;
           max-width: 860px; margin: 0 auto; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    h2 { font-size: 12px; font-weight: 700; text-transform: uppercase;
         letter-spacing: 0.08em; color: #888; margin: 28px 0 12px; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px;
            padding: 20px; margin-bottom: 16px; }
    .row { display: flex; gap: 16px; align-items: flex-start;
           padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
    .row:last-child { border-bottom: none; }
    .row > * { min-width: 0; }
    .label { width: 140px; flex-shrink: 0; font-weight: 600; font-size: 13px; }
    .body { flex: 1; font-size: 13px; color: #333; }
    .mono { font-family: monospace; font-size: 12px; background: #f0f0f0;
            padding: 1px 5px; border-radius: 3px;
            display: inline-block; max-width: 100%; word-break: break-all; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 6px;
          font-size: 12px; line-height: 1.5; margin: 8px 0;
          white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
    ul, ol { padding-left: 18px; margin: 6px 0; }
    li { margin-bottom: 4px; font-size: 13px; }
    p { margin-bottom: 8px; }
    p:last-child { margin-bottom: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 6px 10px; background: #f5f5f5;
         font-weight: 600; border-bottom: 2px solid #e5e5e5; }
    td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
  </style>
</head>
<body>
  <!-- content here -->
</body>
</html>
```

## Common patterns

**Status badge:**
```html
<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;
             font-weight:700;background:#e8f8ee;color:#1a8a3a;">DONE</span>
```

**Two-column row with label:**
```html
<div class="row">
  <div class="label">package.json</div>
  <div class="body">Remove unused <span class="mono">express</span> dep.</div>
</div>
```

**Code block with caption:**
```html
<p>Result:</p>
<pre>{ "name": "planner", "version": "0.1.0" }</pre>
```
