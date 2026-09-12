// The library is a folder tree with a JSON sidecar beside every asset, and
// this module is the only thing that reads or writes them. index.json is a
// cache of the sidecars and is rebuilt on demand, so deleting it is safe.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS, ROOT } from './env.js';

const POSTS = path.join(ROOT, 'posts.json');
const INDEX = path.join(DIRS.library, 'index.json');

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
}
export function shortId(seed) {
  return crypto.createHash('sha1').update(seed + Date.now() + Math.random()).digest('hex').slice(0, 8);
}
export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- assets ----------------------------------------------------------------

export function* walkSidecars(dir = DIRS.library) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkSidecars(p);
    else if (e.name.endsWith('.json') && e.name !== 'index.json') {
      const a = readJSON(p, null);
      if (a && a.id && a.file) yield a;
    }
  }
}

export function sidecarPath(asset) {
  return path.join(DIRS.library, asset.file.replace(/\.[^.]+$/, '') + '.json');
}
export function assetPath(asset) { return path.join(DIRS.library, asset.file); }

export function saveAsset(asset) {
  asset.updatedAt = new Date().toISOString();
  writeJSON(sidecarPath(asset), asset);
  return asset;
}

export function rebuildIndex() {
  const assets = [...walkSidecars()].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  writeJSON(INDEX, { builtAt: new Date().toISOString(), assets });
  return assets;
}

export function loadAssets() {
  const idx = readJSON(INDEX, null);
  return idx ? idx.assets : rebuildIndex();
}

export function getAsset(id) { return loadAssets().find(a => a.id === id) || null; }

export function updateAsset(id, patch) {
  const a = [...walkSidecars()].find(x => x.id === id);
  if (!a) return null;
  // Only fields a person or the analyser is allowed to change. The file path,
  // hash and provenance stay put.
  const allowed = ['title', 'description', 'tags', 'hashtags', 'project', 'palette', 'mood',
    'rating', 'hidden', 'suitability', 'notes', 'altText', 'analyzedBy', 'width', 'height', 'aspect', 'category'];
  for (const k of allowed) if (k in patch) a[k] = patch[k];
  saveAsset(a);
  rebuildIndex();
  return a;
}

export function knownHashes() {
  const m = new Map();
  for (const a of walkSidecars()) m.set(a.hash, a);
  return m;
}

// ---- posts -----------------------------------------------------------------
// One file holds proposals, the approved queue, and the published log. Status
// moves proposed -> approved -> scheduled -> published, or -> rejected.

export function loadPosts() { return readJSON(POSTS, { posts: [] }).posts; }
export function savePosts(posts) { writeJSON(POSTS, { savedAt: new Date().toISOString(), posts }); return posts; }
export function upsertPost(post) {
  const posts = loadPosts();
  const i = posts.findIndex(p => p.id === post.id);
  post.updatedAt = new Date().toISOString();
  if (i >= 0) posts[i] = { ...posts[i], ...post }; else { post.createdAt = post.updatedAt; posts.push(post); }
  savePosts(posts);
  return i >= 0 ? posts[i] : post;
}
export function deletePost(id) { savePosts(loadPosts().filter(p => p.id !== id)); }

// ---- grid ------------------------------------------------------------------
// The planned Instagram grid: an ordered list of post ids (or asset ids for a
// quick sketch), newest first, three per row.
const GRID = path.join(ROOT, 'grid.json');
export function loadGrid() { return readJSON(GRID, { cells: [] }); }
export function saveGrid(grid) { writeJSON(GRID, grid); return grid; }

export { readJSON, writeJSON };
