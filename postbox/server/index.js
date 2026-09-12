// The local server: serves the UI, the library files, and a small JSON API.
// No framework. Everything is a function of the files on disk, so restarting
// loses nothing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ROOT, hasClaude, MODEL } from './env.js';
import { mimeFor } from './image.js';
import { loadAssets, rebuildIndex, updateAsset, getAsset, loadPosts, upsertPost, deletePost, loadGrid, saveGrid, walkSidecars, assetPath, sidecarPath, saveAsset } from './store.js';
import { readBrain, writeBrain, logFeedback } from './brain.js';
import { analyze } from './analyze.js';
import { ingestInbox, ingestBuffer } from './ingest.js';
import { propose, regenerate, PLATFORMS, available } from './propose.js';
import { planQueue, WINDOWS, CADENCE } from './schedule.js';
import { autoArrange, rowCohesion, gridScore } from './grid.js';
import { publishPost, adapters } from './adapters/index.js';
import { listGenerators } from './generators/index.js';
import { chatTurn, loadChat, clearChat, runAuto, autoLog } from './chat.js';
import { TOOLS, runTool } from './tools.js';
import { deriveAsset, renderEdit, ASPECTS } from './edit.js';
import { hasDiscord } from './discord.js';

const PORT = Number(process.env.POSTBOX_PORT) || 8140;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function readJSONBody(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }

function serveFile(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': mimeFor(path.extname(file).toLowerCase()) === 'application/octet-stream' && /\.(html|css|js|mjs)$/.test(file)
    ? ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript' })[path.extname(file)]
    : mimeFor(path.extname(file).toLowerCase()), 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, pattern: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, raw: Boolean(opts.raw) });

// ---- status ----
route('GET', '/api/status', () => ({
  ai: hasClaude(), model: MODEL, discord: hasDiscord(), tools: TOOLS.map(t => ({ name: t.name, description: t.description })), aspects: Object.keys(ASPECTS), platforms: PLATFORMS, generators: listGenerators(),
  windows: WINDOWS, cadence: CADENCE, counts: { assets: loadAssets().length, posts: loadPosts().length },
}));

// ---- library ----
route('GET', '/api/library', () => ({ assets: loadAssets() }));
route('POST', '/api/library/rebuild', () => ({ assets: rebuildIndex() }));
route('POST', '/api/ingest', async (req, body) => ingestInbox({ ai: body.ai !== false, keep: Boolean(body.keep), log: () => {} }));
route('PATCH', '/api/assets/:id', (req, body, p) => {
  const a = updateAsset(p.id, body);
  if (!a) return [404, { error: 'no such asset' }];
  if ('rating' in body || 'hidden' in body) logFeedback(body.hidden ? 'hide' : 'rate', `${a.file} ${'rating' in body ? '★' + body.rating : ''}`);
  return { asset: a };
});
route('POST', '/api/assets/:id/analyze', async (req, body, p) => {
  const a = [...walkSidecars()].find(x => x.id === p.id);
  if (!a) return [404, { error: 'no such asset' }];
  await analyze(a, { ai: true, force: true });
  saveAsset(a); rebuildIndex();
  return { asset: a };
});
route('DELETE', '/api/assets/:id', (req, body, p) => {
  const a = [...walkSidecars()].find(x => x.id === p.id);
  if (!a) return [404, { error: 'no such asset' }];
  fs.rmSync(assetPath(a), { force: true }); fs.rmSync(sidecarPath(a), { force: true });
  rebuildIndex();
  return { ok: true };
});
// Drag-and-drop upload: raw body, name and project in the query string.
route('PUT', '/api/upload', async (req, body, p, url) => {
  const name = url.searchParams.get('name') || 'upload.bin';
  const project = url.searchParams.get('project') || null;
  const r = await ingestBuffer(body, name, { project, originalPath: name, ai: url.searchParams.get('ai') !== '0' });
  rebuildIndex();
  return r;
}, { raw: true });

// ---- posts ----
route('GET', '/api/posts', () => ({ posts: loadPosts() }));
route('POST', '/api/posts', (req, body) => ({ post: upsertPost({ id: body.id || 'post_' + Date.now().toString(36), status: 'proposed', ...body }) }));
route('DELETE', '/api/posts/:id', (req, body, p) => { deletePost(p.id); return { ok: true }; });
route('POST', '/api/propose', async (req, body) => {
  const posts = await propose(loadAssets(), loadPosts(), { platform: body.platform, count: body.count || 5, ai: body.ai !== false, note: body.note || '' });
  for (const p of posts) upsertPost(p);
  return { posts, available: available(loadAssets(), loadPosts()).length };
});
route('POST', '/api/posts/:id/regenerate', async (req, body, p) => {
  const post = loadPosts().find(x => x.id === p.id);
  if (!post) return [404, { error: 'no such post' }];
  if (body.note) logFeedback('regenerate', `${post.id}: ${body.note}`);
  return { post: upsertPost(await regenerate(post, loadAssets(), { note: body.note || '', ai: body.ai !== false })) };
});
route('POST', '/api/posts/:id/decide', (req, body, p) => {
  const post = loadPosts().find(x => x.id === p.id);
  if (!post) return [404, { error: 'no such post' }];
  const status = body.decision === 'approve' ? 'approved' : 'rejected';
  logFeedback(status, `${post.platform} "${post.title}"${body.note ? ' — ' + body.note : ''}${status === 'approved' && body.edited ? ' (caption edited by hand)' : ''}`);
  return { post: upsertPost({ ...post, ...(body.edits || {}), status, decidedAt: new Date().toISOString(), note: body.note || post.note }) };
});
route('POST', '/api/schedule', (req, body) => {
  const posts = loadPosts();
  const queue = posts.filter(p => p.status === 'approved' || (p.status === 'scheduled' && !p.scheduledAt));
  const existing = posts.filter(p => p.status === 'scheduled' && p.scheduledAt);
  if (body.reset) for (const q of queue) q.scheduledAt = null;
  planQueue(queue, { existing });
  for (const q of queue) upsertPost({ ...q, status: 'scheduled' });
  return { posts: loadPosts() };
});
route('POST', '/api/posts/:id/publish', async (req, body, p) => {
  const post = loadPosts().find(x => x.id === p.id);
  if (!post) return [404, { error: 'no such post' }];
  const r = await publishPost(post, loadAssets(), { dryRun: body.dryRun !== false });
  upsertPost({ ...post, status: r.result.dryRun ? post.status : 'published', lastDryRun: r.result.at, problems: r.payload.problems });
  return { ...r, dir: path.relative(ROOT, r.dir) };
});

// ---- grid ----
route('GET', '/api/grid', () => {
  const grid = loadGrid(); const assets = loadAssets();
  const rows = toRows(grid.cells.map(id => assets.find(a => a.id === id) || null));
  return { grid, rows: rows.map(r => ({ ids: r.map(a => a?.id || null), cohesion: rowCohesion(r) })), score: gridScore(rows) };
});
route('PUT', '/api/grid', (req, body) => { saveGrid({ cells: body.cells || [] }); return { ok: true }; });
route('POST', '/api/grid/arrange', (req, body) => {
  const assets = loadAssets();
  const items = (body.cells || loadGrid().cells).map(id => assets.find(a => a.id === id)).filter(Boolean);
  const rows = autoArrange(items);
  const cells = rows.flat().map(a => a.id);
  if (body.save !== false) saveGrid({ cells });
  return { cells, rows: rows.map(r => ({ ids: r.map(a => a.id), cohesion: rowCohesion(r) })), score: gridScore(rows) };
});
function toRows(list, cols = 3) { const rows = []; for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols)); return rows; }

// ---- chat / tools / auto ----
route('GET', '/api/chat', () => ({ turns: loadChat().turns || [] }));
route('DELETE', '/api/chat', () => { clearChat(); return { ok: true }; });
route('POST', '/api/chat', async (req, body) => chatTurn(String(body.text || '')));
route('POST', '/api/tools/:name', async (req, body, p) => ({ result: await runTool(p.name, body) }));
route('POST', '/api/auto/run', async (req, body) => runAuto({ threshold: body.threshold, handoff: Boolean(body.handoff) }));
route('GET', '/api/auto/log', () => ({ log: autoLog() }));

// ---- image edits ----
// Preview renders to the response without saving; commit files a derived asset.
route('POST', '/api/assets/:id/preview', async (req, body, p, url, res) => {
  const a = getAsset(p.id); if (!a) return [404, { error: 'no such asset' }];
  const { buffer } = await renderEdit(assetPath(a), body);
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(buffer);
  return null;
});
route('POST', '/api/assets/:id/edit', async (req, body, p) => {
  const a = getAsset(p.id); if (!a) return [404, { error: 'no such asset' }];
  const { label, ...ops } = body;
  return { asset: await deriveAsset(a, ops, { label: label || ops.aspect || 'edit' }) };
});
route('POST', '/api/posts/:id/handoff', async (req, body, p) => ({ result: await runTool('hand_off', { id: p.id }) }));

// ---- brain ----
route('GET', '/api/brain', () => ({ text: readBrain() }));
route('PUT', '/api/brain', (req, body) => { writeBrain(body.text || ''); return { ok: true }; });
route('POST', '/api/brain/log', (req, body) => ({ line: logFeedback(body.kind || 'note', body.detail || '') }));

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const body = r.raw ? await readBody(req) : (req.method === 'GET' ? {} : await readJSONBody(req));
      const out = await r.fn(req, body, m.groups || {}, url, res);
      if (out === null) return; // the handler wrote the response itself
      return Array.isArray(out) ? json(res, out[0], out[1]) : json(res, 200, out);
    }
    if (url.pathname.startsWith('/library/')) return serveFile(res, path.join(DIRS.library, decodeURIComponent(url.pathname.slice(9))));
    if (url.pathname.startsWith('/outbox/')) return serveFile(res, path.join(DIRS.outbox, decodeURIComponent(url.pathname.slice(8))));
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    return serveFile(res, path.join(DIRS.ui, path.normalize(p)));
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  server.listen(PORT, () => {
    console.log(`postbox  http://localhost:${PORT}   ai: ${hasClaude() ? MODEL : 'off (no ANTHROPIC_API_KEY — heuristics only)'}`);
  });
}
export { server };
