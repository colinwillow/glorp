// Turns the library into proposed posts. The heuristic proposer always works;
// with a key, Claude writes the captions and picks covers, reading BRAIN.md.
import { MODEL, hasClaude } from './env.js';
import { brainForPrompt } from './brain.js';
import { pairAffinity } from './grid.js';
import { shortId } from './store.js';

export const PLATFORMS = {
  instagram_feed:  { label: 'Instagram feed',  maxAssets: 10, maxCaption: 2200, maxHashtags: 30, aspects: ['portrait', 'square', 'landscape'] },
  instagram_reel:  { label: 'Instagram reel',  maxAssets: 1,  maxCaption: 2200, maxHashtags: 30, aspects: ['story'] },
  tiktok:          { label: 'TikTok',          maxAssets: 1,  maxCaption: 2200, maxHashtags: 10, aspects: ['story'] },
  x:               { label: 'X',               maxAssets: 4,  maxCaption: 280,  maxHashtags: 3,  aspects: ['landscape', 'square', 'portrait'] },
  youtube_shorts:  { label: 'YouTube Shorts',  maxAssets: 1,  maxCaption: 100,  maxHashtags: 5,  aspects: ['story'] },
  linkedin:        { label: 'LinkedIn',        maxAssets: 9,  maxCaption: 3000, maxHashtags: 5,  aspects: ['landscape', 'square', 'portrait'] },
};

// Assets that are free to use: visible, not already in a live post.
export function available(assets, posts) {
  const used = new Set(posts.filter(p => !['rejected', 'published'].includes(p.status)).flatMap(p => p.assets || []));
  return assets.filter(a => !a.hidden && !used.has(a.id) && a.kind !== 'audio' && a.kind !== 'model');
}

// Groups candidates into post-sized sets. Single strong pieces stand alone;
// siblings from the same project with a close palette become a carousel.
export function groupCandidates(assets, { platform = 'instagram_feed', count = 5 } = {}) {
  const spec = PLATFORMS[platform] || PLATFORMS.instagram_feed;
  const score = a => (a.suitability?.[platform] ?? 0.3) + (a.rating ? a.rating / 10 : 0) + (a.postWorthy ?? 0.5) * 0.5;
  const pool = assets.filter(a => a.kind === 'image' || a.kind === 'video').sort((a, b) => score(b) - score(a));
  const groups = [];
  const used = new Set();
  for (const seed of pool) {
    if (used.has(seed.id)) continue;
    const group = [seed]; used.add(seed.id);
    if (spec.maxAssets > 1) {
      for (const other of pool) {
        if (group.length >= Math.min(spec.maxAssets, 5)) break;
        if (used.has(other.id) || other.kind !== seed.kind) continue;
        if (seed.project === other.project && pairAffinity(seed, other) > 1.1) { group.push(other); used.add(other.id); }
      }
    }
    groups.push(group);
    if (groups.length >= count) break;
  }
  return groups;
}

export function heuristicPost(group, platform) {
  const cover = group[0];
  const spec = PLATFORMS[platform] || PLATFORMS.instagram_feed;
  const hashtags = [...new Set(group.flatMap(a => a.hashtags || []))].slice(0, Math.min(spec.maxHashtags, 8));
  // Without the model there is no description, so say what it is and where it is from.
  const what = cover.description || `${cover.title}${cover.project && cover.project !== 'misc' ? ', from ' + cover.project : ''}.`;
  const caption = [what, group.length > 1 ? `${group.length} frames.` : ''].filter(Boolean).join(' ').slice(0, spec.maxCaption - hashtags.join(' ').length - 2);
  return {
    id: 'post_' + shortId(cover.id),
    status: 'proposed',
    platform,
    project: cover.project,
    assets: group.map(a => a.id),
    cover: cover.id,
    title: cover.title,
    caption,
    hashtags,
    rationale: group.length > 1 ? 'Same project, close palette — reads as a set.' : 'Strong single piece for this platform.',
    theme: cover.mood || '',
    generatedBy: 'heuristic',
  };
}

let client = null;
async function getClient() {
  if (client) return client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  client = new Anthropic();
  return client;
}

const SYSTEM = `You write social posts for a working artist, in the voice from the brain file.
You are given candidate groups of assets (already grouped by project and palette) and a platform.
For each group produce one post. Keep the assets as given; you may reorder them and choose the cover.
Respect the platform's caption and hashtag limits. Be concrete about what the work is. No hype.
If a group would make a weak post, say so in rationale and set confidence low rather than padding it.

## Brain file
`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    posts: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          group: { type: 'integer' }, cover: { type: 'string' }, order: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' }, caption: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } },
          theme: { type: 'string' }, rationale: { type: 'string' }, confidence: { type: 'number' },
          hook: { type: 'string' },
        },
        required: ['group', 'cover', 'order', 'title', 'caption', 'hashtags', 'theme', 'rationale', 'confidence', 'hook'],
      },
    },
  },
  required: ['posts'],
};

function describe(a) {
  return `  - id=${a.id} kind=${a.kind} ${a.width}x${a.height} ${a.aspect} project=${a.project} category=${a.category}\n    title: ${a.title}\n    desc: ${a.description || '(none)'}\n    tags: ${(a.tags || []).join(', ')}\n    palette: ${(a.palette || []).join(' ')} mood: ${a.mood || ''}`;
}

export async function claudePosts(groups, platform, { note = '' } = {}) {
  const c = await getClient();
  const spec = PLATFORMS[platform] || PLATFORMS.instagram_feed;
  const body = [
    `Platform: ${spec.label} (${platform}). Caption limit ${spec.maxCaption} chars, hashtag limit ${spec.maxHashtags}, up to ${spec.maxAssets} assets.`,
    note ? `Extra direction from the artist: ${note}` : '',
    'Candidate groups:',
    ...groups.map((g, i) => `Group ${i}:\n` + g.map(describe).join('\n')),
  ].filter(Boolean).join('\n\n');
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM + brainForPrompt(), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: body }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  });
  if (res.stop_reason === 'refusal') throw new Error('Model declined: ' + (res.stop_details?.explanation || ''));
  const out = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  return out.posts.map(p => {
    const group = groups[p.group] || groups[0];
    const ids = new Set(group.map(a => a.id));
    const order = p.order.filter(id => ids.has(id));
    for (const a of group) if (!order.includes(a.id)) order.push(a.id);
    const cover = ids.has(p.cover) ? p.cover : order[0];
    return {
      id: 'post_' + shortId(cover), status: 'proposed', platform, project: group[0].project,
      assets: order, cover, title: p.title, caption: p.caption,
      hashtags: p.hashtags.slice(0, spec.maxHashtags), theme: p.theme, rationale: p.rationale,
      confidence: p.confidence, hook: p.hook, generatedBy: MODEL,
    };
  });
}

export async function propose(assets, posts, { platform = 'instagram_feed', count = 5, ai = true, note = '' } = {}) {
  const groups = groupCandidates(available(assets, posts), { platform, count });
  if (!groups.length) return [];
  if (ai && hasClaude()) {
    try { return await claudePosts(groups, platform, { note }); }
    catch (e) { return groups.map(g => ({ ...heuristicPost(g, platform), error: String(e.message || e) })); }
  }
  return groups.map(g => heuristicPost(g, platform));
}

// Re-writes one existing post, keeping its assets, with an optional note.
export async function regenerate(post, assets, { note = '', ai = true } = {}) {
  const group = post.assets.map(id => assets.find(a => a.id === id)).filter(Boolean);
  if (!group.length) return post;
  let fresh;
  if (ai && hasClaude()) {
    try { [fresh] = await claudePosts([group], post.platform, { note }); } catch (e) { fresh = { ...heuristicPost(group, post.platform), error: String(e.message || e) }; }
  } else fresh = heuristicPost(group, post.platform);
  return { ...post, ...fresh, id: post.id, status: post.status === 'rejected' ? 'proposed' : post.status, regenerated: (post.regenerated || 0) + 1 };
}
