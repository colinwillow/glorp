// Reads width/height straight out of file headers. No decoder, no native deps.
// Covers PNG, JPEG, GIF, WebP (VP8 / VP8L / VP8X) and MP4/MOV (moov > trak > tkhd).
// Anything else comes back { width: 0, height: 0 } and the UI measures it on load.

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
export const MODEL_EXT = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.3mf']);
export const VECTOR_EXT = new Set(['.svg', '.ai', '.eps', '.pdf', '.dxf']);

export function mimeFor(ext) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
    '.pdf': 'application/pdf', '.json': 'application/json',
  })[ext] || 'application/octet-stream';
}

export function kindFor(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (MODEL_EXT.has(ext)) return 'model';
  if (VECTOR_EXT.has(ext)) return 'vector';
  return 'other';
}

export function dimensions(buf) {
  if (buf.length < 12) return { width: 0, height: 0 };
  // PNG
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { width: (buf.readUIntLE(24, 3)) + 1, height: (buf.readUIntLE(27, 3)) + 1 };
    }
  }
  // JPEG: walk the segments to the first SOF marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  // MP4 / MOV: find a tkhd box anywhere (good enough for the first video track)
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const idx = buf.indexOf('tkhd', 0, 'ascii');
    if (idx > 0) {
      const version = buf[idx + 4];
      const off = idx + 4 + (version === 1 ? 88 : 76);
      if (off + 8 <= buf.length) {
        const w = buf.readUInt32BE(off) >>> 16, h = buf.readUInt32BE(off + 4) >>> 16;
        if (w && h) return { width: w, height: h };
      }
    }
  }
  return { width: 0, height: 0 };
}

// Buckets a ratio the way a feed does. 4:5 is the tallest Instagram feed crop,
// 9:16 is a story/reel, wider than 1.2 reads as landscape.
export function aspectOf(width, height) {
  if (!width || !height) return 'unknown';
  const r = width / height;
  if (r < 0.62) return 'story';
  if (r < 0.92) return 'portrait';
  if (r <= 1.2) return 'square';
  return 'landscape';
}
