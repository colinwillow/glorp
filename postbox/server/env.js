// Loads .env from the postbox root into process.env without a dependency.
// Existing environment wins over the file, so a shell export still overrides.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIRS = {
  inbox: path.join(ROOT, 'inbox'),
  library: path.join(ROOT, 'library'),
  outbox: path.join(ROOT, 'outbox'),
  ui: path.join(ROOT, 'ui'),
};

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env) && val) process.env[key] = val;
  }
}
loadEnv();

export const MODEL = process.env.POSTBOX_MODEL || 'claude-opus-5';
export const hasClaude = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
