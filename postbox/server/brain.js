// BRAIN.md is the tool's memory: who you are, how you talk, what you have
// accepted and rejected. Every AI prompt reads it, and every decision you make
// in the UI appends to it, so it gets more like you the longer you use it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

const FILE = path.join(ROOT, 'BRAIN.md');

export function readBrain() {
  return fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
}
export function writeBrain(text) { fs.writeFileSync(FILE, text); }

// Appends one line under "## Feedback log". Kept terse on purpose; the model
// reads this whole file on every call and a thousand verbose entries would
// drown the voice section that actually matters.
export function logFeedback(kind, detail) {
  const stamp = new Date().toISOString().slice(0, 10);
  let text = readBrain();
  const line = `- ${stamp} · ${kind} · ${detail}`;
  if (!/## Feedback log/.test(text)) text += '\n\n## Feedback log\n';
  text = text.trimEnd() + '\n' + line + '\n';
  writeBrain(text);
  return line;
}

// The section of BRAIN.md that goes into prompts. The feedback log is capped
// to its newest entries so the prompt stays a stable prefix and caches.
export function brainForPrompt(maxLogLines = 60) {
  const text = readBrain();
  const [head, log = ''] = text.split(/\n## Feedback log\n/);
  const lines = log.trim().split('\n').filter(Boolean).slice(-maxLogLines);
  return head.trim() + (lines.length ? '\n\n## Feedback log (newest last)\n' + lines.join('\n') : '');
}
