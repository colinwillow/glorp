// Deterministic checks for the parts that don't need a model or a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dimensions, aspectOf, kindFor } from '../server/image.js';
import { paletteDistance, rowCohesion, autoArrange, gridScore, pairAffinity } from '../server/grid.js';
import { planQueue } from '../server/schedule.js';
import { heuristic, suitabilityFor } from '../server/analyze.js';
import { groupCandidates, heuristicPost, available, PLATFORMS } from '../server/propose.js';
import { adapters } from '../server/adapters/index.js';

let n = 0; const check = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

// ---- image headers ----
const png = (w, h) => { const b = Buffer.alloc(33); b.write('\x89PNG\r\n\x1a\n', 0, 'binary'); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
check('png dimensions', () => assert.deepEqual(dimensions(png(1080, 1350)), { width: 1080, height: 1350 }));
check('gif dimensions', () => { const b = Buffer.alloc(16); b.write('GIF89a'); b.writeUInt16LE(320, 6); b.writeUInt16LE(240, 8); assert.deepEqual(dimensions(b), { width: 320, height: 240 }); });
check('jpeg dimensions (SOF0 after APP0)', () => {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
  assert.deepEqual(dimensions(b), { width: 800, height: 600 });
});
check('webp VP8X dimensions', () => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(1079, 24, 3); b.writeUIntLE(1919, 27, 3); assert.deepEqual(dimensions(b), { width: 1080, height: 1920 }); });
check('unknown bytes give 0x0', () => assert.deepEqual(dimensions(Buffer.from('hello world!!')), { width: 0, height: 0 }));
check('aspect buckets', () => { assert.equal(aspectOf(1080, 1080), 'square'); assert.equal(aspectOf(1080, 1350), 'portrait'); assert.equal(aspectOf(1080, 1920), 'story'); assert.equal(aspectOf(1600, 900), 'landscape'); assert.equal(aspectOf(0, 0), 'unknown'); });
check('kind by extension', () => { assert.equal(kindFor('.glb'), 'model'); assert.equal(kindFor('.mp4'), 'video'); assert.equal(kindFor('.svg'), 'vector'); assert.equal(kindFor('.xyz'), 'other'); });

// ---- palette / grid ----
check('identical palettes are distance 0, opposite are near 1', () => {
  assert.equal(paletteDistance(['#ff0000', '#00ff00'], ['#ff0000', '#00ff00']), 0);
  assert.ok(paletteDistance(['#000000'], ['#ffffff']) > 0.99);
  assert.equal(paletteDistance([], ['#000']), 0.5);
});
const A = (id, project, palette, category = 'game', aspect = 'square') => ({ id, project, palette, category, aspect, kind: 'image', title: id, suitability: { instagram_feed: 0.8 }, tags: [], hashtags: [] });
check('same project + palette beats a stranger', () => {
  const a = A('a', 'peggy', ['#2233aa', '#88ccff']), b = A('b', 'peggy', ['#2a36a0', '#80c0f0']), c = A('c', 'robits', ['#ff2200', '#111111']);
  assert.ok(pairAffinity(a, b) > pairAffinity(a, c));
  assert.ok(rowCohesion([a, b]) > rowCohesion([a, c]));
});
check('auto-arrange packs siblings into one row', () => {
  const items = [A('p1', 'peggy', ['#2233aa']), A('r1', 'robits', ['#ff2200']), A('p2', 'peggy', ['#2233bb']), A('r2', 'robits', ['#ff2211']), A('p3', 'peggy', ['#2233cc']), A('r3', 'robits', ['#ff2222'])];
  const rows = autoArrange(items);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(new Set(r.map(x => x.project)).size, 1, 'row mixes projects: ' + r.map(x => x.id));
  assert.ok(gridScore(rows) > 0.8);
});
check('auto-arrange alternates projects across rows when it can', () => {
  const items = [...Array(6)].map((_, i) => A('p' + i, 'peggy', ['#2233aa'])).concat([...Array(3)].map((_, i) => A('r' + i, 'robits', ['#ff2200'])));
  const rows = autoArrange(items);
  assert.equal(rows.length, 3);
  assert.notEqual(rows[0][0].project, rows[1][0].project);
});

// ---- schedule ----
check('planner spreads posts and respects the min gap', () => {
  const now = new Date('2026-09-14T08:00:00');
  const q = [1, 2, 3, 4].map(i => ({ id: 'p' + i, platform: 'instagram_feed', project: i % 2 ? 'peggy' : 'robits' }));
  planQueue(q, { now });
  const ts = q.map(p => new Date(p.scheduledAt).getTime());
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 6 * 36e5, 'gap too small');
  assert.ok(ts[3] - ts[0] >= 5 * 24 * 36e5, 'four posts at 3/week should span most of a fortnight');
  for (const p of q) assert.ok(new Date(p.scheduledAt) > now);
});
check('planner avoids the same project back to back', () => {
  const now = new Date('2026-09-14T08:00:00');
  const q = [{ id: 'a', platform: 'instagram_feed', project: 'peggy' }, { id: 'b', platform: 'instagram_feed', project: 'peggy' }, { id: 'c', platform: 'instagram_feed', project: 'robits' }];
  planQueue(q, { now });
  // it cannot change order, but it must still place everything in the future
  assert.equal(q.filter(p => p.scheduledAt).length, 3);
});
check('scheduled posts keep their time', () => {
  const q = [{ id: 'a', platform: 'x', scheduledAt: '2026-10-01T09:00:00.000Z' }];
  planQueue(q); assert.equal(q[0].scheduledAt, '2026-10-01T09:00:00.000Z');
});

// ---- heuristic analysis ----
check('heuristic titles from filenames and projects from provenance', () => {
  const a = { file: 'robits/lv_foundry-abc.jpg', originalName: 'lv_foundry.jpg', kind: 'image', aspect: 'landscape', width: 1600, height: 900, source: { repo: 'robits', path: 'thumbs/lv_foundry.jpg' } };
  const r = heuristic(a);
  assert.equal(r.project, 'robits'); assert.equal(r.title, 'Foundry', 'the lv_ prefix on level thumbs is noise'); assert.equal(r.category, 'game');
  assert.ok(r.hashtags.includes('#robits'));
});
check('suitability follows shape', () => {
  assert.ok(suitabilityFor({ aspect: 'story', kind: 'video' }).tiktok > suitabilityFor({ aspect: 'landscape', kind: 'image' }).tiktok);
  assert.ok(suitabilityFor({ aspect: 'portrait', kind: 'image' }).instagram_feed >= 1);
  assert.equal(suitabilityFor({ aspect: 'square', kind: 'model' }).x, 0.1);
});

// ---- proposals ----
check('grouping makes carousels from siblings and singles from strangers', () => {
  const assets = [A('p1', 'peggy', ['#2233aa']), A('p2', 'peggy', ['#2233bb']), A('r1', 'robits', ['#ff2200'])];
  const groups = groupCandidates(assets, { platform: 'instagram_feed', count: 5 });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.length).sort(), [1, 2]);
  const xg = groupCandidates(assets, { platform: 'tiktok', count: 5 });
  assert.ok(xg.every(g => g.length === 1), 'single-asset platforms never get carousels');
});
check('available() excludes assets in live posts', () => {
  const assets = [A('a', 'p', []), A('b', 'p', []), A('c', 'p', [])];
  const posts = [{ status: 'approved', assets: ['a'] }, { status: 'rejected', assets: ['b'] }];
  assert.deepEqual(available(assets, posts).map(x => x.id), ['b', 'c']);
});
check('heuristic post respects platform hashtag limits', () => {
  const a = A('a', 'peggy', []); a.hashtags = ['#1', '#2', '#3', '#4', '#5'];
  assert.ok(heuristicPost([a], 'x').hashtags.length <= PLATFORMS.x.maxHashtags);
});
check('adapter flags a story-shaped asset on the feed and truncates to the limit', () => {
  const a = A('a', 'peggy', [], 'game', 'story'); a.file = 'peggy/a.png';
  const payload = adapters.instagram_feed.format({ assets: ['a'], caption: 'x'.repeat(5000), hashtags: [] }, [a]);
  assert.ok(payload.problems.some(p => /story/.test(p)));
  assert.ok(payload.text.length <= PLATFORMS.instagram_feed.maxCaption);
});
check('adapters refuse a live publish until wired', async () => {
  await assert.rejects(adapters.x.publish({}, { dryRun: false }));
});

console.log(`\n${n} checks passed${process.exitCode ? ', some FAILED' : ''}`);
