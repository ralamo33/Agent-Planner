import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PORT } from './store.js';

const BASE = `http://127.0.0.1:${PORT}`;
const BIN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'planner');

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data.trim())); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function openBrowser(url) {
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '', url];
  } else if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    cmd = 'powershell.exe'; args = ['-NoProfile', '-c', `Start-Process '${url}'`];
  } else {
    cmd = 'xdg-open'; args = [url];
  }
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function ensureServer() {
  try {
    const res = await fetchJson(`${BASE}/health`);
    if (res.ok) return;
  } catch {}

  spawn(process.execPath, [BIN_PATH, 'server'], { detached: true, stdio: 'ignore' }).unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const res = await fetchJson(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
  }
  throw new Error('server did not start within 5s');
}

async function poll(name) {
  return fetchJson(`${BASE}/api/poll?name=${encodeURIComponent(name)}`);
}

function buildNextStep(name, result) {
  if (result.status === 'ended') return 'Session ended. Plan has been archived.';
  const errors = (result.layout_warnings ?? []).filter(w => w.severity === 'error');
  if (errors.length > 0) {
    return `Fix ${errors.length} layout error(s) before asking for human feedback: ${errors.map(w => w.kind).join(', ')}. Then run \`planner update ${name} <path>\`.`;
  }
  return `Apply feedback, then run \`planner update ${name} <path>\`.`;
}

// ── Agent commands ────────────────────────────────────────────────────────────

export async function cmdOpen(args) {
  const [name, sourcePath] = args;
  if (!name || !sourcePath) {
    process.stderr.write('Usage: planner open <name> <path>\n');
    process.exit(1);
  }
  await ensureServer();
  const res = await fetchJson(`${BASE}/api/plans/open`, {
    method: 'POST',
    body: JSON.stringify({ name, path: path.resolve(sourcePath) }),
  });
  if (res.error) {
    process.stderr.write(`[planner] ${res.error}\n`);
    process.exit(1);
  }
  openBrowser(res.url);
  process.stderr.write(`[planner] session URL: ${res.url}\n`);
  process.stderr.write(`[planner] waiting for feedback on "${name}"...\n`);
  const result = await poll(name);
  console.log(JSON.stringify({
    session: { name, status: result.status },
    ...result,
    next_step: buildNextStep(name, result),
  }));
}

export async function cmdUpdate(args) {
  const [name, sourcePath] = args;
  if (!name || !sourcePath) {
    process.stderr.write('Usage: planner update <name> <path>\n');
    process.exit(1);
  }
  await ensureServer();
  const res = await fetchJson(`${BASE}/api/plans/update`, {
    method: 'POST',
    body: JSON.stringify({ name, path: path.resolve(sourcePath) }),
  });
  if (res.error) {
    process.stderr.write(`[planner] ${res.error}\n`);
    process.exit(1);
  }
  process.stderr.write(`[planner] plan updated, waiting for feedback on "${name}"...\n`);
  const result = await poll(name);
  console.log(JSON.stringify({
    session: { name, status: result.status },
    ...result,
    next_step: buildNextStep(name, result),
  }));
}

// ── User commands ─────────────────────────────────────────────────────────────

export async function cmdReopen(args) {
  const [name] = args;
  if (!name) {
    process.stderr.write('Usage: planner reopen <name>\n');
    process.exit(1);
  }
  await ensureServer();
  const res = await fetchJson(`${BASE}/api/plans/reopen`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (res.error) {
    process.stderr.write(`[planner] ${res.error}\n`);
    process.exit(1);
  }
  openBrowser(res.url);
  console.log(JSON.stringify({ session: { name, status: 'open', url: res.url } }));
}

export async function cmdRestore(args) {
  const [name] = args;
  if (!name) {
    process.stderr.write('Usage: planner restore <name>\n');
    process.exit(1);
  }
  await ensureServer();
  const res = await fetchJson(`${BASE}/api/plans/restore`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (res.error) {
    process.stderr.write(`[planner] ${res.error}\n`);
    process.exit(1);
  }
  openBrowser(res.url);
  console.log(JSON.stringify({ session: { name, status: 'open', url: res.url } }));
}
