// Moves everything in inbox/ into library/, describes it, and writes sidecars.
//   node server/ingest.js            # move + analyse (Claude if a key is set)
//   node server/ingest.js --no-ai    # heuristic only
//   node server/ingest.js --keep     # copy instead of move (leave inbox alone)
// Subfolders inside inbox/ are a project hint: inbox/peggy/foo.png -> project "peggy".
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './env.js';
import { dimensions, aspectOf, kindFor, mimeFor } from './image.js';
import { slug, shortId, sha256, saveAsset, rebuildIndex, knownHashes } from './store.js';
import { analyze } from './analyze.js';

const SKIP = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db']);

export function* walk(dir, rel = '') {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.') || e.name.endsWith('.source.json')) continue;
    const p = path.join(dir, e.name), r = path.join(rel, e.name);
    if (e.isDirectory()) yield* walk(p, r); else yield { abs: p, rel: r };
  }
}

// Files one buffer into the library. Shared by the CLI and the upload route.
export async function ingestBuffer(buf, originalName, { project, originalPath = '', source = null, ai = true, known = knownHashes() } = {}) {
  const hash = sha256(buf);
  if (known.has(hash)) return { skipped: true, asset: known.get(hash) };
  const ext = path.extname(originalName).toLowerCase();
  const kind = kindFor(ext);
  const { width, height } = kind === 'image' || kind === 'video' ? dimensions(buf) : { width: 0, height: 0 };
  const id = shortId(hash);
  const proj = slug(project || (originalPath.includes('/') ? originalPath.split('/')[0] : '') || source?.repo || 'misc');
  const name = `${slug(path.basename(originalName, ext))}-${id}${ext}`;
  const file = path.join(proj, name);
  fs.mkdirSync(path.join(DIRS.library, proj), { recursive: true });
  fs.writeFileSync(path.join(DIRS.library, file), buf);
  const asset = {
    id, file, originalName, originalPath, source,
    addedAt: new Date().toISOString(), bytes: buf.length, hash, mime: mimeFor(ext),
    kind, width, height, aspect: aspectOf(width, height), project: proj,
    palette: [], tags: [], hashtags: [], rating: null, hidden: false,
  };
  await analyze(asset, { ai });
  saveAsset(asset);
  known.set(hash, asset);
  return { skipped: false, asset };
}

export async function ingestInbox({ ai = true, keep = false, project = null, log = console.log } = {}) {
  const known = knownHashes();
  const added = [], skipped = [];
  for (const f of walk(DIRS.inbox)) {
    const buf = fs.readFileSync(f.abs);
    // tools/harvest.mjs and tools/screenshot.mjs leave a <file>.source.json
    // beside each file saying where it came from; that becomes provenance.
    let source = null;
    const sidecar = f.abs + '.source.json';
    if (fs.existsSync(sidecar)) { try { source = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {} }
    const r = await ingestBuffer(buf, path.basename(f.rel), { project, originalPath: f.rel, source, ai, known });
    (r.skipped ? skipped : added).push(r.asset);
    log(`${r.skipped ? 'dup ' : 'add '} ${f.rel} -> ${r.asset.file}${r.asset.analyzeError ? '  (ai: ' + r.asset.analyzeError + ')' : ''}`);
    if (!keep) { fs.unlinkSync(f.abs); fs.rmSync(sidecar, { force: true }); }
  }
  if (!keep) pruneEmptyDirs(DIRS.inbox);
  rebuildIndex();
  return { added, skipped };
}

function pruneEmptyDirs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    pruneEmptyDirs(p);
    if (!fs.readdirSync(p).length) fs.rmdirSync(p);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const r = await ingestInbox({ ai: !args.includes('--no-ai'), keep: args.includes('--keep'), project: opt('--project') });
  console.log(`${r.added.length} added, ${r.skipped.length} duplicates skipped`);
}
