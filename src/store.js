import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PORT = 4737;

const STATE_DIR = path.join(os.homedir(), '.planner');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const ACTIVE_DIR = path.join(STATE_DIR, 'active_plans');
export const ARCHIVE_DIR = path.join(STATE_DIR, 'archived_plans');

function ensureDirs() {
  mkdirSync(ACTIVE_DIR, { recursive: true });
  mkdirSync(ARCHIVE_DIR, { recursive: true });
}

export function activePlanPath(name) {
  return path.join(ACTIVE_DIR, `${name}.html`);
}

function readState() {
  if (!existsSync(STATE_FILE)) return { sessions: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── File operations ───────────────────────────────────────────────────────────

export function openPlan(name, sourcePath) {
  ensureDirs();
  const dest = activePlanPath(name);
  if (existsSync(dest)) throw new Error(`Plan "${name}" already exists in active plans`);
  copyFileSync(sourcePath, dest);
  return dest;
}

export function updatePlan(name, sourcePath) {
  const dest = activePlanPath(name);
  if (!existsSync(dest)) throw new Error(`Plan "${name}" not found in active plans`);
  copyFileSync(sourcePath, dest);
  return dest;
}

export function archivePlan(name) {
  ensureDirs();
  const src = activePlanPath(name);
  if (!existsSync(src)) throw new Error(`Plan "${name}" not found in active plans`);
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const dest = path.join(ARCHIVE_DIR, `${name}-${ts}.html`);
  renameSync(src, dest);
  return dest;
}

export function restorePlan(name) {
  ensureDirs();
  const dest = activePlanPath(name);
  if (existsSync(dest)) throw new Error(`An active plan named "${name}" already exists`);
  const prefix = `${name}-`;
  const matches = readdirSync(ARCHIVE_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.html'))
    .sort()
    .reverse();
  if (matches.length === 0) throw new Error(`No archived plan named "${name}" found`);
  renameSync(path.join(ARCHIVE_DIR, matches[0]), dest);
  return dest;
}

// ── Session operations ────────────────────────────────────────────────────────

export function upsertSession(name) {
  const state = readState();
  if (!state.sessions[name]) {
    state.sessions[name] = {
      key: name,
      name,
      file: activePlanPath(name),
      url: `http://127.0.0.1:${PORT}/session/${encodeURIComponent(name)}`,
      status: 'open',
      pending_prompts: 0,
      prompts: [],
      layout_warnings: [],
      dom_snapshot: '',
      chat: [],
      updated_at: new Date().toISOString(),
    };
  } else {
    state.sessions[name].status = 'open';
    state.sessions[name].file = activePlanPath(name);
    state.sessions[name].updated_at = new Date().toISOString();
  }
  writeState(state);
  return state.sessions[name];
}

export function takeFeedback(key) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return { status: 'missing' };

  const hasPrompts = session.prompts.length > 0;
  const hasWarnings = session.layout_warnings.length > 0;

  if (!hasPrompts && !hasWarnings) {
    return { status: session.status === 'ended' ? 'ended' : 'waiting' };
  }

  const result = {
    status: 'feedback',
    prompts: session.prompts,
    layout_warnings: session.layout_warnings,
    dom_snapshot: session.dom_snapshot,
  };
  session.prompts = [];
  session.layout_warnings = [];
  session.dom_snapshot = '';
  session.pending_prompts = 0;
  if (session.status !== 'ended') session.status = 'open';
  session.updated_at = new Date().toISOString();
  writeState(state);
  return result;
}

export function queuePrompts(key, prompts, domSnapshot) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;
  session.prompts.push(...prompts);
  session.dom_snapshot = domSnapshot ?? session.dom_snapshot;
  session.status = 'feedback';
  session.pending_prompts = (session.pending_prompts ?? 0) + prompts.length;
  const now = new Date().toISOString();
  for (const p of prompts) {
    if (p.tag === 'message' && p.prompt) {
      session.chat.push({ role: 'user', text: p.prompt, at: now });
    }
  }
  session.updated_at = now;
  writeState(state);
}

export function recordLayoutWarnings(key, warnings) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return false;
  session.layout_warnings = warnings;
  const changed = warnings.length > 0;
  if (changed) session.status = 'feedback';
  session.updated_at = new Date().toISOString();
  writeState(state);
  return changed;
}

export function addAgentReply(key, text) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;
  session.chat.push({ role: 'agent', text, at: new Date().toISOString() });
  session.updated_at = new Date().toISOString();
  writeState(state);
}

export function endSession(key) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;
  session.status = 'ended';
  session.updated_at = new Date().toISOString();
  writeState(state);
}

export function findByKey(key) {
  return readState().sessions[key] ?? null;
}
