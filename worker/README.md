# orb-brain

The proxy that lets the orb talk to Claude.

It exists for one reason: `index.html` is served from GitHub Pages, so anything
in it is public. An `ANTHROPIC_API_KEY` in the page would be readable by anyone
who opens dev tools, and it is billable. The key lives here instead, on the
server, and the browser only ever sees this Worker's URL.

## Deploy

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY     # paste the key when prompted
npx wrangler deploy
```

`wrangler deploy` prints a URL like `https://orb-brain.<you>.workers.dev`. Paste
that into the **brain endpoint** field in the orb's tune panel; it is remembered
in `localStorage`.

Before going public, set `ALLOWED_ORIGIN` in `wrangler.toml` to the page's
origin. Left as `*`, any site on the internet can spend your tokens through it.

## What it does

`POST /` with `{"messages": [...]}` — the Anthropic messages array, sent whole
each turn, since the API is stateless. It replies with the answer as a plain
text stream, so the orb can start its mouth on the first clause instead of
waiting for the full sentence.

The system prompt is in `src/index.ts`. It is written for speech: one or two
sentences, no markdown, no lists, no emoji. Change it there.

## Choices worth knowing

- `effort: "low"` — voice wants an answer back fast far more than it wants a
  deeper one. Raise it to `"high"` if you would rather have considered replies
  than quick ones.
- `max_tokens: 1024` — deliberately small. This gets spoken aloud, and a long
  reply means a long speaking animation.
- Refusal fallbacks are on. A policy decline re-runs the turn on a fallback
  model inside the same call rather than returning nothing.
- Errors are caught and turned into something sayable, so a failure never
  leaves the orb stuck mid-state with nothing to say.

## Porting

Nothing here is Cloudflare-specific except the export shape. On Vercel or
Netlify, keep the body and swap `export default { fetch }` for that platform's
handler signature.
