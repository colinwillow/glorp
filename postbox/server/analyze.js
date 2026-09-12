// Turns a raw file into a described asset. Two analysers:
//   heuristic — filename, folder, dimensions, provenance. Always runs.
//   claude    — vision. Runs when a key is present, fills in the parts the
//               heuristic can only guess at (what it IS, palette, mood).
// Both write the same fields so the rest of the tool never cares which ran.
import fs from 'node:fs';
import path from 'node:path';
import { MODEL, hasClaude } from './env.js';
import { brainForPrompt } from './brain.js';
import { assetPath } from './store.js';
import { mimeFor } from './image.js';

const STOP = new Set(['final', 'export', 'copy', 'new', 'v1', 'v2', 'v3', 'img', 'image', 'images', 'screenshot', 'screen', 'shot', 'untitled', 'png', 'jpg', 'thumbs', 'thumb', 'lv', 'source']);

export function heuristic(asset) {
  // Prefer the real path from provenance over whatever the inbox called it.
  const named = asset.source?.path || asset.originalName || asset.file;
  const base = path.basename(named, path.extname(named));
  const words = base.split(/[^a-zA-Z0-9]+|(?<=[a-z])(?=[A-Z])/).map(w => w.toLowerCase()).filter(w => w && !STOP.has(w));
  const project = asset.project || guessProject(asset);
  const tags = [...new Set([project, asset.kind, ...words].filter(Boolean))];
  return {
    title: asset.title || titleCase(words.slice(0, 5).join(' ') || project),
    description: asset.description || '',
    project,
    tags,
    hashtags: asset.hashtags?.length ? asset.hashtags : defaultHashtags(project, asset.kind, words),
    mood: asset.mood || '',
    category: asset.category || categoryFor(asset),
    suitability: asset.suitability || suitabilityFor(asset),
    analyzedBy: 'heuristic',
  };
}

function guessProject(asset) {
  if (asset.source?.repo) return slugWord(asset.source.repo);
  const parts = (asset.originalPath || '').split(/[\\/]/).filter(Boolean);
  if (parts.length > 1) return slugWord(parts[0]);
  return 'misc';
}
function slugWord(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

function categoryFor(asset) {
  const n = (asset.originalName || '').toLowerCase();
  if (asset.kind === 'model') return '3d';
  if (asset.kind === 'vector') return 'vector';
  if (asset.kind === 'video') return 'video';
  if (asset.kind === 'audio') return 'audio';
  if (/icon|logo/.test(n)) return 'branding';
  if (/level|lv_|screenshot|gameplay/.test(n)) return 'game';
  if (/character|char_|portrait/.test(n)) return 'character';
  if (/texture|hdri|material/.test(n)) return 'texture';
  if (/laser|cut|print/.test(n)) return 'fabrication';
  return 'image';
}

function defaultHashtags(project, kind, words) {
  const base = ['#indiedev', '#madewiththree', '#gamedev', '#3dart', '#webgl'];
  const byKind = { model: ['#3dmodeling', '#blender3d'], video: ['#reels', '#gamedev'], vector: ['#vectorart', '#illustration'] };
  return [...new Set([...(byKind[kind] || []), ...base.slice(0, 3), ...(project && project !== 'misc' ? ['#' + project.replace(/-/g, '')] : [])])].slice(0, 8);
}

// A rough fit score per platform from shape alone. The vision pass adjusts it.
export function suitabilityFor(asset) {
  const a = asset.aspect;
  const v = asset.kind === 'video';
  const s = { instagram_feed: 0.5, instagram_reel: 0.2, tiktok: 0.2, x: 0.5, youtube_shorts: 0.1, linkedin: 0.3 };
  if (a === 'square') { s.instagram_feed = 0.9; s.x = 0.7; }
  if (a === 'portrait') { s.instagram_feed = 1.0; s.x = 0.5; }
  if (a === 'story') { s.instagram_reel = v ? 1.0 : 0.6; s.tiktok = v ? 1.0 : 0.5; s.youtube_shorts = v ? 0.9 : 0.2; s.instagram_feed = 0.4; }
  if (a === 'landscape') { s.x = 0.9; s.linkedin = 0.6; s.instagram_feed = 0.5; }
  if (v && a !== 'story') { s.x = Math.max(s.x, 0.8); s.instagram_reel = Math.max(s.instagram_reel, 0.5); }
  if (asset.kind === 'model' || asset.kind === 'audio') Object.keys(s).forEach(k => s[k] = 0.1);
  return s;
}

// ---- Claude vision ---------------------------------------------------------

let client = null;
async function getClient() {
  if (client) return client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  client = new Anthropic();
  return client;
}

const SYSTEM = `You catalogue a working artist's output for social media. You are given one image
and its filename/provenance. Describe what it actually is, in the voice from the brain file below.
Be specific and honest: if it is a UI screenshot, say so; if it is a work-in-progress, say so.
Never invent a story about the piece. The title is for the artist's own library, not a headline.

Return JSON with:
- title: 2-6 words, plain, no punctuation flourish
- description: 1-2 sentences of what is in the image and what is interesting about it
- altText: one plain sentence for screen readers
- tags: 4-10 lowercase words for filtering (medium, subject, style, colour, project)
- hashtags: 5-12 hashtags, mixing broad and specific, no spaces
- project: a short lowercase slug naming which body of work it belongs to (use the provenance hint if it fits)
- category: one of game, character, 3d, vector, branding, texture, ui, fabrication, video, photo, image
- palette: 3-5 dominant colours as hex strings, most dominant first
- mood: 2-4 words
- postWorthy: 0-1, how much this stands on its own as a post (a raw texture tile is low, a finished render is high)
- postIdea: one line on how you'd post it, if postWorthy > 0.5, else empty

## Brain file
`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, description: { type: 'string' }, altText: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } }, hashtags: { type: 'array', items: { type: 'string' } },
    project: { type: 'string' }, category: { type: 'string' },
    palette: { type: 'array', items: { type: 'string' } }, mood: { type: 'string' },
    postWorthy: { type: 'number' }, postIdea: { type: 'string' },
  },
  required: ['title', 'description', 'altText', 'tags', 'hashtags', 'project', 'category', 'palette', 'mood', 'postWorthy', 'postIdea'],
};

export async function claudeAnalyze(asset) {
  if (!hasClaude()) throw new Error('No ANTHROPIC_API_KEY');
  if (asset.kind !== 'image') throw new Error('Vision analysis only runs on images for now');
  const c = await getClient();
  const data = fs.readFileSync(assetPath(asset)).toString('base64');
  const ext = path.extname(asset.file).toLowerCase();
  const provenance = [
    `filename: ${asset.originalName}`,
    asset.source?.repo ? `from repo: ${asset.source.repo} (${asset.source.path || ''})` : '',
    asset.originalPath ? `dropped at: ${asset.originalPath}` : '',
    `${asset.width}x${asset.height} (${asset.aspect})`,
  ].filter(Boolean).join('\n');

  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM + brainForPrompt(), cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeFor(ext === '.jpeg' ? '.jpg' : ext), data } },
        { type: 'text', text: provenance },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  });
  if (res.stop_reason === 'refusal') throw new Error('Model declined: ' + (res.stop_details?.explanation || ''));
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const out = JSON.parse(text);
  return { ...out, analyzedBy: 'claude', analyzedAt: new Date().toISOString(), suitability: adjustSuitability(asset, out) };
}

function adjustSuitability(asset, out) {
  const s = { ...(asset.suitability || suitabilityFor(asset)) };
  const w = Number(out.postWorthy) || 0.5;
  for (const k of Object.keys(s)) s[k] = Math.round(Math.min(1, s[k] * (0.5 + w)) * 100) / 100;
  return s;
}

// Runs the heuristic, then the model if allowed. `force` re-runs the model on
// an asset it already looked at.
export async function analyze(asset, { ai = true, force = false } = {}) {
  Object.assign(asset, heuristic(asset));
  if (ai && hasClaude() && asset.kind === 'image' && (force || asset.analyzedBy !== 'claude')) {
    try {
      Object.assign(asset, await claudeAnalyze(asset));
    } catch (e) {
      asset.analyzeError = String(e.message || e);
    }
  }
  return asset;
}
