// The hands. One registry of things that can be done to the library, the
// posts, the grid and the images. The chat gives these to Claude; auto mode
// runs them on a standing prompt; tests call run() directly. If it can be
// done in the UI it should be doable here, so the chat can do it for you.
import { z } from 'zod';
import { loadAssets, updateAsset, loadPosts, upsertPost, deletePost, loadGrid, saveGrid, getAsset } from './store.js';
import { autoArrange, rowCohesion, gridScore } from './grid.js';
import { propose, regenerate, PLATFORMS, available } from './propose.js';
import { planQueue } from './schedule.js';
import { deriveAsset, ASPECTS } from './edit.js';
import { sendToDiscord, hasDiscord } from './discord.js';
import { publishPost } from './adapters/index.js';
import { logFeedback, readBrain } from './brain.js';
import { ingestInbox } from './ingest.js';
import { analyze } from './analyze.js';
import { walkSidecars, saveAsset, rebuildIndex } from './store.js';

const brief = (a) => ({ id: a.id, title: a.title, project: a.project, category: a.category, kind: a.kind, aspect: a.aspect, size: `${a.width}x${a.height}`, palette: a.palette, mood: a.mood, tags: a.tags, rating: a.rating, hidden: a.hidden, derivedFrom: a.derivedFrom, postWorthy: a.postWorthy, description: a.description });
const briefPost = (p) => ({ id: p.id, status: p.status, platform: p.platform, project: p.project, title: p.title, caption: p.caption, hashtags: p.hashtags, assets: p.assets, cover: p.cover, scheduledAt: p.scheduledAt, confidence: p.confidence, rationale: p.rationale });

export const TOOLS = [
  {
    name: 'list_library', description: 'List assets in the library with optional filters. Returns ids, titles, projects, shapes, palettes, ratings. Use it before acting on anything.',
    schema: z.object({ project: z.string().optional(), category: z.string().optional(), aspect: z.enum(['square', 'portrait', 'landscape', 'story']).optional(), query: z.string().optional().describe('substring match on title/tags/description'), includeHidden: z.boolean().optional(), limit: z.number().int().optional() }),
    run: async (i) => {
      let list = loadAssets().filter(a => (i.includeHidden || !a.hidden) && (!i.project || a.project === i.project) && (!i.category || a.category === i.category) && (!i.aspect || a.aspect === i.aspect)
        && (!i.query || JSON.stringify([a.title, a.tags, a.description, a.mood]).toLowerCase().includes(i.query.toLowerCase())));
      return { count: list.length, assets: list.slice(0, i.limit || 60).map(brief) };
    },
  },
  {
    name: 'update_asset', description: 'Edit an asset\'s metadata: title, description, project, tags, hashtags, mood, rating (1-5), hidden.',
    schema: z.object({ id: z.string(), title: z.string().optional(), description: z.string().optional(), project: z.string().optional(), tags: z.array(z.string()).optional(), hashtags: z.array(z.string()).optional(), mood: z.string().optional(), rating: z.number().int().min(1).max(5).nullable().optional(), hidden: z.boolean().optional(), altText: z.string().optional() }),
    run: async ({ id, ...patch }) => { const a = updateAsset(id, patch); if (!a) throw new Error('no such asset ' + id); return brief(a); },
  },
  {
    name: 'edit_image', description: 'Make a new derived image from an asset: crop/resize to a platform aspect (square 1:1, portrait 4:5, story 9:16, landscape 16:9), optionally add a title/subtitle overlay and a project colour bar. Returns the new asset id. Use pad=true for logos and vector work that must not be cropped.',
    schema: z.object({ id: z.string(), aspect: z.enum(Object.keys(ASPECTS)).optional(), title: z.string().optional(), subtitle: z.string().optional(), position: z.enum(['top', 'center', 'bottom']).optional(), align: z.enum(['left', 'center', 'right']).optional(), color: z.string().optional().describe('hex colour for the bar'), textColor: z.string().optional(), size: z.number().optional().describe('title size as a fraction of height, default 0.07'), bar: z.boolean().optional(), band: z.boolean().optional(), pad: z.boolean().optional(), background: z.string().optional(), label: z.string().optional().describe('short label for the derived file name, e.g. "cover"') }),
    run: async ({ id, label, ...ops }) => { const src = getAsset(id); if (!src) throw new Error('no such asset ' + id); const a = await deriveAsset(src, ops, { label: label || ops.aspect || 'edit' }); return brief(a); },
  },
  {
    name: 'analyze_asset', description: 'Run (or re-run) the vision analysis on one asset so its description, tags, palette and post-worthiness are filled in.',
    schema: z.object({ id: z.string() }),
    run: async ({ id }) => { const a = [...walkSidecars()].find(x => x.id === id); if (!a) throw new Error('no such asset'); await analyze(a, { ai: true, force: true }); saveAsset(a); rebuildIndex(); return brief(a); },
  },
  {
    name: 'ingest_inbox', description: 'File everything currently in inbox/ into the library.',
    schema: z.object({ ai: z.boolean().optional() }),
    run: async ({ ai = true }) => { const r = await ingestInbox({ ai, log: () => {} }); return { added: r.added.map(brief), duplicates: r.skipped.length }; },
  },
  {
    name: 'list_posts', description: 'List posts (proposed, approved, scheduled, rejected, published, handed_off).',
    schema: z.object({ status: z.string().optional() }),
    run: async ({ status }) => ({ posts: loadPosts().filter(p => !status || p.status === status).map(briefPost) }),
  },
  {
    name: 'propose_posts', description: 'Generate new proposed posts for a platform from assets not already used in a live post. Optional direction steers the captions.',
    schema: z.object({ platform: z.enum(Object.keys(PLATFORMS)).optional(), count: z.number().int().optional(), note: z.string().optional() }),
    run: async ({ platform = 'instagram_feed', count = 4, note = '' }) => { const posts = await propose(loadAssets(), loadPosts(), { platform, count, note }); for (const p of posts) upsertPost(p); return { posts: posts.map(briefPost), stillFree: available(loadAssets(), loadPosts()).length }; },
  },
  {
    name: 'create_post', description: 'Create a post by hand from specific asset ids.',
    schema: z.object({ platform: z.enum(Object.keys(PLATFORMS)), assets: z.array(z.string()).min(1), cover: z.string().optional(), title: z.string(), caption: z.string(), hashtags: z.array(z.string()).optional(), rationale: z.string().optional() }),
    run: async (i) => { const a = getAsset(i.assets[0]); const post = upsertPost({ id: 'post_' + Date.now().toString(36), status: 'proposed', project: a?.project, cover: i.cover || i.assets[0], hashtags: [], ...i, generatedBy: 'chat' }); return briefPost(post); },
  },
  {
    name: 'update_post', description: 'Edit a post: caption, title, hashtags, asset order, cover, platform, scheduledAt (ISO), status.',
    schema: z.object({ id: z.string(), title: z.string().optional(), caption: z.string().optional(), hashtags: z.array(z.string()).optional(), assets: z.array(z.string()).optional(), cover: z.string().optional(), platform: z.enum(Object.keys(PLATFORMS)).optional(), scheduledAt: z.string().nullable().optional(), status: z.enum(['proposed', 'approved', 'scheduled', 'rejected']).optional() }),
    run: async ({ id, ...patch }) => { const p = loadPosts().find(x => x.id === id); if (!p) throw new Error('no such post ' + id); if (patch.status && patch.status !== p.status) logFeedback(patch.status, `${p.platform} "${patch.title || p.title}" (via chat)`); return briefPost(upsertPost({ ...p, ...patch })); },
  },
  {
    name: 'regenerate_post', description: 'Rewrite a post\'s caption/title/hashtags with a note of what to change. Keeps the assets.',
    schema: z.object({ id: z.string(), note: z.string() }),
    run: async ({ id, note }) => { const p = loadPosts().find(x => x.id === id); if (!p) throw new Error('no such post'); logFeedback('regenerate', `${p.id}: ${note}`); return briefPost(upsertPost(await regenerate(p, loadAssets(), { note }))); },
  },
  {
    name: 'delete_post', description: 'Delete a post outright.',
    schema: z.object({ id: z.string() }),
    run: async ({ id }) => { deletePost(id); return { ok: true }; },
  },
  {
    name: 'get_grid', description: 'The planned Instagram grid: ordered asset ids, newest first, three per row, with a cohesion score per row.',
    schema: z.object({}),
    run: async () => { const assets = loadAssets(); const cells = loadGrid().cells; const rows = []; for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3)); return { cells, rows: rows.map(r => ({ ids: r, titles: r.map(id => getAsset(id)?.title), cohesion: rowCohesion(r.map(id => assets.find(a => a.id === id))) })), score: gridScore(rows.map(r => r.map(id => assets.find(a => a.id === id)))) }; },
  },
  {
    name: 'set_grid', description: 'Replace the grid with an explicit ordered list of asset ids (first three = top row).',
    schema: z.object({ cells: z.array(z.string()) }),
    run: async ({ cells }) => { saveGrid({ cells: cells.filter(id => getAsset(id)) }); return TOOLS.find(t => t.name === 'get_grid').run({}); },
  },
  {
    name: 'arrange_grid', description: 'Auto-arrange the grid into cohesive rows of three by project and palette. Optionally give the asset ids to arrange; default is the current grid, or if empty the newest visible images.',
    schema: z.object({ ids: z.array(z.string()).optional(), fillTo: z.number().int().optional().describe('if the grid is empty, take this many newest images') }),
    run: async ({ ids, fillTo = 9 }) => {
      const assets = loadAssets();
      let items = (ids || loadGrid().cells).map(id => assets.find(a => a.id === id)).filter(Boolean);
      if (!items.length) items = assets.filter(a => !a.hidden && a.kind === 'image').slice(0, fillTo);
      const rows = autoArrange(items); saveGrid({ cells: rows.flat().map(a => a.id) });
      return TOOLS.find(t => t.name === 'get_grid').run({});
    },
  },
  {
    name: 'plan_times', description: 'Give every approved post a posting time from the engagement windows and cadence rules.',
    schema: z.object({ reset: z.boolean().optional() }),
    run: async ({ reset }) => { const posts = loadPosts(); const queue = posts.filter(p => p.status === 'approved' || (p.status === 'scheduled' && (!p.scheduledAt || reset))); if (reset) for (const q of queue) q.scheduledAt = null; planQueue(queue, { existing: posts.filter(p => p.status === 'scheduled' && p.scheduledAt && !reset) }); for (const q of queue) upsertPost({ ...q, status: 'scheduled' }); return { scheduled: queue.map(briefPost) }; },
  },
  {
    name: 'hand_off', description: 'Send a finished post to the Discord channel (the handoff to whatever posts it for real). Falls back to a dry run into outbox/ when no webhook is configured.',
    schema: z.object({ id: z.string() }),
    run: async ({ id }) => {
      const p = loadPosts().find(x => x.id === id); if (!p) throw new Error('no such post');
      const assets = loadAssets();
      if (hasDiscord()) { const r = await sendToDiscord(p, assets, { platformLabel: PLATFORMS[p.platform]?.label }); upsertPost({ ...p, status: 'handed_off', handedOffAt: r.at, discordMessageId: r.messageId }); return r; }
      const r = await publishPost(p, assets, { dryRun: true }); upsertPost({ ...p, lastDryRun: r.result.at, problems: r.payload.problems }); return { ok: true, dryRun: true, outbox: r.dir, problems: r.payload.problems };
    },
  },
  {
    name: 'remember', description: 'Append a line to BRAIN.md\'s feedback log — a preference, a rule, something the artist said to keep in mind.',
    schema: z.object({ kind: z.string().optional(), detail: z.string() }),
    run: async ({ kind = 'note', detail }) => ({ line: logFeedback(kind, detail) }),
  },
  {
    name: 'read_brain', description: 'Read the full BRAIN.md.',
    schema: z.object({}),
    run: async () => ({ text: readBrain() }),
  },
];

export const toolByName = Object.fromEntries(TOOLS.map(t => [t.name, t]));
export async function runTool(name, input) {
  const t = toolByName[name]; if (!t) throw new Error('no such tool ' + name);
  return t.run(t.schema.parse(input || {}));
}
