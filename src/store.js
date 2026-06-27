import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.lavish');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PORT = parseInt(process.env.LAVISH_PORT ?? '') || 4387;

function readState() {
  if (!existsSync(STATE_FILE)) return { sessions: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function sessionKey(canonicalPath) {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16);
}

export async function upsertSession(file) {
  const canonical = typeof file === 'string' && path.isAbsolute(file) ? file : await realpath(path.resolve(file));
  const key = sessionKey(canonical);
  const state = readState();
  if (!state.sessions[key]) {
    state.sessions[key] = {
      key,
      file: canonical,
      url: `http://127.0.0.1:${PORT}/session/${key}`,
      status: 'open',
      pending_prompts: 0,
      prompts: [],
      layout_warnings: [],
      dom_snapshot: '',
      chat: [],
      updated_at: new Date().toISOString(),
    };
    writeState(state);
  }
  return state.sessions[key];
}

export function takeFeedback(key) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return { status: 'missing' };

  const hasPrompts = session.prompts.length > 0;
  const hasWarnings = session.layout_warnings.length > 0;

  if (session.status === 'ended' && !hasPrompts && !hasWarnings) {
    return { status: 'ended' };
  }

  if (!hasPrompts && !hasWarnings) {
    return { status: 'waiting' };
  }

  const prompts = session.prompts;
  const layout_warnings = session.layout_warnings;
  const dom_snapshot = session.dom_snapshot;

  session.prompts = [];
  session.layout_warnings = [];
  session.dom_snapshot = '';
  session.pending_prompts = 0;
  if (session.status !== 'ended') session.status = 'open';
  session.updated_at = new Date().toISOString();
  writeState(state);

  return { status: 'feedback', prompts, layout_warnings, dom_snapshot };
}

export function queuePrompts(key, prompts, domSnapshot) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;

  session.prompts.push(...prompts);
  session.dom_snapshot = domSnapshot ?? '';
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

  const prev = JSON.stringify(session.layout_warnings);
  const next = JSON.stringify(warnings);
  if (prev === next) return false;

  session.layout_warnings = warnings;
  if (warnings.length > 0) session.status = 'feedback';
  session.updated_at = new Date().toISOString();
  writeState(state);
  return warnings.length > 0;
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
  const state = readState();
  return state.sessions[key] ?? null;
}

export function listSessions() {
  return Object.values(readState().sessions);
}
