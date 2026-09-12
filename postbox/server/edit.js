// Image edits, server side, via sharp. Every edit makes a NEW asset in the
// library with `derivedFrom` pointing back, so the original is never touched
// and the chat can iterate ("tighter crop", "smaller title") without loss.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DIRS } from './env.js';
import { assetPath, saveAsset, rebuildIndex, shortId, sha256, slug, walkSidecars } from './store.js';
import { aspectOf } from './image.js';
import { heuristic } from './analyze.js';

export const ASPECTS = { square: [1, 1], portrait: [4, 5], story: [9, 16], landscape: [16, 9], x: [16, 9] };
export const SIZES = { square: [1080, 1080], portrait: [1080, 1350], story: [1080, 1920], landscape: [1600, 900], x: [1600, 900] };

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Wraps text to a rough character width so a title never runs off the edge.
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/), lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines;
}

// An SVG overlay: title (and optional subtitle) in a band, plus a colour bar.
export function overlaySVG({ width, height, title = '', subtitle = '', position = 'bottom', color = '#f2c14e', textColor = '#ffffff', size = 0.07, bar = true, band = true, font = 'Helvetica, Arial, sans-serif', align = 'left' }) {
  const fs_ = Math.round(height * size), sub = Math.round(fs_ * 0.55), pad = Math.round(width * 0.06);
  const lines = title ? wrap(title, Math.floor((width - pad * 2) / (fs_ * 0.55))) : [];
  const blockH = lines.length * fs_ * 1.15 + (subtitle ? sub * 1.6 : 0) + pad * 1.2;
  const top = position === 'top' ? 0 : position === 'center' ? (height - blockH) / 2 : height - blockH;
  const x = align === 'center' ? width / 2 : align === 'right' ? width - pad : pad;
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  let y = top + pad * 0.6 + fs_;
  const t = lines.map(l => { const s = `<text x="${x}" y="${y.toFixed(0)}" font-family="${font}" font-weight="700" font-size="${fs_}" fill="${textColor}" text-anchor="${anchor}">${esc(l)}</text>`; y += fs_ * 1.15; return s; }).join('');
  const st = subtitle ? `<text x="${x}" y="${(y + sub * 0.4).toFixed(0)}" font-family="${font}" font-size="${sub}" fill="${textColor}" fill-opacity="0.85" text-anchor="${anchor}">${esc(subtitle)}</text>` : '';
  const bandRect = band && (title || subtitle) ? `<rect x="0" y="${top.toFixed(0)}" width="${width}" height="${blockH.toFixed(0)}" fill="#000" fill-opacity="0.45"/>` : '';
  const barRect = bar ? (position === 'top' ? `<rect x="0" y="${(top + blockH).toFixed(0)}" width="${width}" height="${Math.max(4, height * 0.012).toFixed(0)}" fill="${color}"/>` : `<rect x="0" y="${(top - Math.max(4, height * 0.012)).toFixed(0)}" width="${width}" height="${Math.max(4, height * 0.012).toFixed(0)}" fill="${color}"/>`) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bandRect}${barRect}${t}${st}</svg>`;
}

// ops: { aspect?, resize? [w,h], title?, subtitle?, size? (title height fraction), position?, color?, textColor?, bar?, band?, align?, pad?, background? }
export async function renderEdit(inputPath, ops = {}) {
  let img = sharp(inputPath, { animated: false }).rotate();
  const meta = await img.metadata();
  let w = meta.width, h = meta.height;
  if (ops.aspect && ASPECTS[ops.aspect]) {
    const [aw, ah] = ASPECTS[ops.aspect];
    const [tw, th] = Array.isArray(ops.resize) ? ops.resize : SIZES[ops.aspect];
    if (ops.pad) {
      // Fit the whole image and pad with a colour (or the dominant one) — for logos and vector work that must not be cropped.
      img = img.resize(tw, th, { fit: 'contain', background: ops.background || '#111214' });
    } else {
      img = img.resize(tw, th, { fit: 'cover', position: ops.gravity || sharp.strategy.attention });
    }
    w = tw; h = th;
    void aw; void ah;
  } else if (Array.isArray(ops.resize)) {
    img = img.resize(ops.resize[0], ops.resize[1], { fit: 'inside' }); w = ops.resize[0]; h = ops.resize[1];
  }
  if (ops.title || ops.subtitle || ops.bar) {
    const svg = Buffer.from(overlaySVG({ ...ops, width: w, height: h, size: Number(ops.size) || 0.07 }));
    img = img.composite([{ input: svg, top: 0, left: 0 }]);
  }
  const out = await img.png({ compressionLevel: 8 }).toBuffer();
  const m = await sharp(out).metadata();
  return { buffer: out, width: m.width, height: m.height };
}

// Renders and files the result as a new asset beside the source's project.
export async function deriveAsset(source, ops = {}, { label = 'edit' } = {}) {
  const { buffer, width, height } = await renderEdit(assetPath(source), ops);
  const hash = sha256(buffer);
  const dup = [...walkSidecars()].find(a => a.hash === hash);
  if (dup) return dup;
  const id = shortId(hash);
  const name = `${slug(source.title || path.basename(source.file))}-${slug(label)}-${id}.png`;
  const file = path.join(source.project, name);
  fs.mkdirSync(path.join(DIRS.library, source.project), { recursive: true });
  fs.writeFileSync(path.join(DIRS.library, file), buffer);
  const asset = {
    ...source, id, file, originalName: name, originalPath: '', hash, mime: 'image/png', kind: 'image', bytes: buffer.length,
    width, height, aspect: aspectOf(width, height), addedAt: new Date().toISOString(), derivedFrom: source.id, edit: ops,
    title: ops.title ? `${source.title} (${label})` : `${source.title} (${label})`, rating: null, hidden: false,
    suitability: undefined,
  };
  delete asset.updatedAt;
  Object.assign(asset, { suitability: heuristic({ ...asset, title: asset.title }).suitability });
  saveAsset(asset); rebuildIndex();
  return asset;
}

// A 3-wide contact sheet of a post's assets, the way the carousel would read.
export async function contactSheet(files, { cell = 360, cols = 3 } = {}) {
  const tiles = await Promise.all(files.map(f => sharp(f).rotate().resize(cell, cell, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer()));
  const rows = Math.ceil(tiles.length / cols);
  return sharp({ create: { width: cell * cols, height: cell * rows, channels: 3, background: '#111214' } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * cell, top: Math.floor(i / cols) * cell }))).png().toBuffer();
}
