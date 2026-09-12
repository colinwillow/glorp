// Publishing adapters. Every adapter has the same shape:
//   { id, label, limits, format(post, assets) -> payload, publish(payload, {dryRun}) }
// Today all of them are dry-run: they validate, render the payload, and write
// it to outbox/<post id>/ so you can see exactly what would go out. Wiring a
// real API is filling in publish() and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from '../env.js';
import { PLATFORMS } from '../propose.js';
import { assetPath } from '../store.js';

function baseFormat(post, assets, platform) {
  const spec = PLATFORMS[platform];
  const media = post.assets.map(id => assets.find(a => a.id === id)).filter(Boolean).slice(0, spec.maxAssets);
  const caption = (post.caption || '').trim();
  const tags = (post.hashtags || []).slice(0, spec.maxHashtags).join(' ');
  const text = [caption, tags].filter(Boolean).join('\n\n').slice(0, spec.maxCaption);
  const problems = [];
  if (!media.length) problems.push('no media');
  for (const m of media) if (!spec.aspects.includes(m.aspect)) problems.push(`${m.id} is ${m.aspect}; ${spec.label} wants ${spec.aspects.join('/')}`);
  if (text.length >= spec.maxCaption) problems.push('caption truncated to platform limit');
  return { platform, text, media: media.map(m => ({ id: m.id, file: m.file, kind: m.kind, altText: m.altText || m.title })), scheduledAt: post.scheduledAt || null, problems };
}

function makeAdapter(id, extra = {}) {
  return {
    id, label: PLATFORMS[id].label, limits: PLATFORMS[id],
    format: (post, assets) => baseFormat(post, assets, id),
    // Real publishing lands here. Until then every adapter is a dry run.
    async publish(payload, { dryRun = true } = {}) {
      if (!dryRun) throw new Error(`${PLATFORMS[id].label}: live publishing is not wired yet — run with dryRun`);
      return { ok: true, dryRun: true, platform: id, at: new Date().toISOString() };
    },
    ...extra,
  };
}

export const adapters = Object.fromEntries(Object.keys(PLATFORMS).map(id => [id, makeAdapter(id)]));

// Writes the rendered post to outbox/<id>/ with the media copied beside it,
// so a dry run leaves something you can open and check.
export async function publishPost(post, assets, { dryRun = true } = {}) {
  const adapter = adapters[post.platform];
  if (!adapter) throw new Error('Unknown platform ' + post.platform);
  const payload = adapter.format(post, assets);
  const dir = path.join(DIRS.outbox, post.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ post, payload }, null, 2));
  fs.writeFileSync(path.join(dir, 'caption.txt'), payload.text);
  for (const [i, m] of payload.media.entries()) {
    const a = assets.find(x => x.id === m.id);
    if (a) fs.copyFileSync(assetPath(a), path.join(dir, `${String(i + 1).padStart(2, '0')}-${path.basename(a.file)}`));
  }
  const result = await adapter.publish(payload, { dryRun });
  fs.appendFileSync(path.join(DIRS.outbox, 'log.jsonl'), JSON.stringify({ ...result, postId: post.id, problems: payload.problems }) + '\n');
  return { payload, result, dir };
}
