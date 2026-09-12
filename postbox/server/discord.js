// The handoff. A finished post goes to a Discord channel via webhook: caption
// as the message, media as attachments. Whatever posts things for real later
// reads that channel; this tool's job ends here.
import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from './store.js';

export const hasDiscord = () => Boolean(process.env.DISCORD_WEBHOOK_URL);

export function renderMessage(post, assets, platformLabel) {
  const media = post.assets.map(id => assets.find(a => a.id === id)).filter(Boolean).slice(0, 10);
  const tags = (post.hashtags || []).join(' ');
  const content = [`**${post.title || 'Untitled'}** · ${platformLabel || post.platform}${post.scheduledAt ? ' · ' + new Date(post.scheduledAt).toLocaleString() : ''}`, '', post.caption || '', tags ? '' : null, tags].filter(s => s !== null).join('\n').slice(0, 2000);
  return { content, media };
}

export async function sendToDiscord(post, assets, { platformLabel, url = process.env.DISCORD_WEBHOOK_URL, fetchImpl = fetch } = {}) {
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set');
  const { content, media } = renderMessage(post, assets, platformLabel);
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content, attachments: media.map((m, i) => ({ id: i, filename: path.basename(m.file), description: m.altText || m.title })) }));
  for (const [i, m] of media.entries()) {
    const p = assetPath(m);
    form.append(`files[${i}]`, new Blob([fs.readFileSync(p)], { type: m.mime }), path.basename(m.file));
  }
  const res = await fetchImpl(url + (url.includes('?') ? '&' : '?') + 'wait=true', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  return { ok: true, messageId: body.id || null, at: new Date().toISOString(), content, files: media.length };
}
