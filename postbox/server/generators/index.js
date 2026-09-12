// Generators make NEW material to go with a post: a cover, a theme song, a
// turntable model. They all share one interface so the UI can offer whichever
// ones have a key:
//   { id, label, kind: 'image'|'audio'|'model'|'text', ready(): bool, generate(prompt, opts) -> { file, meta } }
// Only the Claude text generator is live. The rest are documented stubs with
// the request shape written out, so wiring one is filling in one function.
import { hasClaude } from '../env.js';

export const generators = {
  claude_text: {
    id: 'claude_text', label: 'Claude (captions, titles, hooks)', kind: 'text',
    ready: () => hasClaude(),
    // Text generation lives in propose.js; this entry exists so the UI can show it.
  },
  openai_image: {
    id: 'openai_image', label: 'OpenAI image (covers, text overlays)', kind: 'image',
    ready: () => Boolean(process.env.OPENAI_API_KEY),
    async generate() { throw new Error('openai_image: not wired. POST https://api.openai.com/v1/images/generations {model:"gpt-image-1", prompt, size}'); },
  },
  gemini_image: {
    id: 'gemini_image', label: 'Gemini image (edits, variations)', kind: 'image',
    ready: () => Boolean(process.env.GEMINI_API_KEY),
    async generate() { throw new Error('gemini_image: not wired. POST generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent'); },
  },
  suno: {
    id: 'suno', label: 'Suno (theme music for reels)', kind: 'audio',
    ready: () => Boolean(process.env.SUNO_API_KEY),
    // The reason this exists: an auto-poster cannot use the in-app licensed
    // music library, so a reel posted by API has to bring its own soundtrack.
    async generate() { throw new Error('suno: not wired. Generate a 15-30s instrumental from the post theme, then mux with ffmpeg.'); },
  },
  tripo: {
    id: 'tripo', label: 'Tripo (image -> 3D turntable)', kind: 'model',
    ready: () => Boolean(process.env.TRIPO_API_KEY),
    async generate() { throw new Error('tripo: not wired. Image-to-3D, then render a turntable clip for a reel.'); },
  },
};

export function listGenerators() {
  return Object.values(generators).map(g => ({ id: g.id, label: g.label, kind: g.kind, ready: g.ready() }));
}
