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

## Giving it a voice (optional)

Get a key from elevenlabs.io, then add it as a second secret:

```bash
npx wrangler secret put ELEVENLABS_API_KEY
```

or, if terminal paste mangles it, set it in the dashboard under
**Workers & Pages -> orb-brain -> Settings -> Variables and Secrets**.

Without this key `/speak` returns 501 and the orb mouths a scripted reply in
silence. Everything else still works.

To choose a voice, `GET /voices` on the Worker lists what the account actually
has -- open the URL with `/voices` on the end in a browser. Put the id you want
in `wrangler.toml`:

```toml
[vars]
ELEVEN_VOICE_ID = "..."
ELEVEN_MODEL_ID = "eleven_turbo_v2_5"   # low-latency tier
```

If either id is wrong, ElevenLabs' own error is passed straight through to the
page rather than swallowed.

## What it does

`POST /` with `{"messages": [...]}` — the Anthropic messages array, sent whole
each turn, since the API is stateless. It replies with the answer as a plain
text stream, so the orb can start its mouth on the first clause instead of
waiting for the full sentence.

`POST /speak` with `{"text": "..."}` returns audio/mpeg. The page plays it and
routes it through an analyser, so the speaking state is driven by the real
voice rather than a scripted syllable clock.

The `show` tool takes exactly one of `text` (a word, a short phrase, or a single
emoji), `shape` (`face`), or `shell` (a firework: `peony`, `ring`, `willow`,
`palm`, `shock`). The page routes all three through one entry point, so the
brain reaches the same effects a spoken trigger word does.

`GET /persona` returns the system prompt that is actually live, so an edit can
be confirmed from a phone.

## Who it is

Nothing about the orb is emergent. It knows its name because `src/index.ts`
tells it, in a system prompt sent with every single request — text the person
talking never sees, which the model reads as *who it is* rather than as
something someone said to it. "I'm Orb" and "a field of particles" are those
sentences coming back in its own words. Anything it says about itself that is
**not** in that prompt is improvised, and should not be believed.

The prompt is deliberately two halves:

- **`PERSONA`** — who it is. Meant to be rewritten.
- **`PROTOCOL`** — how the voice pipeline works. Not up for negotiation, and
  kept in code: a personality that says "answer in bullet points" or "use
  emoji" gets read aloud, literally, by a text-to-speech engine.

**`ORB_MODEL`** is a dashboard variable too, for the same reason: the model is
the one knob worth trying against your own ear. Unset it is **`claude-haiku-4-5`**.

It used to be `claude-opus-5`, and the timing line on the page is what changed
it: Opus was taking 5.0–5.7 seconds to its first token, three quarters of the
whole wait and more than every other leg put together, for a reply that the
protocol caps at two sentences. That is not a question a bigger model answers
better, and the wait is the whole experience — somebody is stood in a room
listening to silence. Set this to `claude-opus-5` to put it back; that is what
the dial is for, and it needs no deploy.

The request adapts to whatever is set rather than sending parameters the model
will reject — fast mode exists on Opus 5 and 4.8 only, and `effort` is rejected
outright by Haiku 4.5 and Sonnet 4.5. Sending either to a model that will not
take it costs a 400 and a wasted round trip before the fallback, which on a
voice assistant is exactly the thing being optimised away.

An attempt that fails is now **retired for the life of the isolate** rather than
retried on every turn, and every attempt is timed and reported back to the page
alongside the reply. A failed attempt was previously billed into the same number
as the one that worked, so a wasted round trip was indistinguishable from a slow
model — from a phone, with no access to the Worker log, it was invisible. A 400
retires the attempt outright; a 429 is a limit that lifts, so that one stands
off for a minute instead. `GET /persona` reports which model is live.

### Colin's own personality

`ORB_PERSONA_COLIN` is his, and `worker/persona-colin.md` is a first draft to
paste into it and then argue with. What that variable replaces is the PERSONA
half only -- the protocol still gets appended, and it now knows whose scene it
is: with a character id in the request it says the body in the room is YOURS
rather than describing it in the third person as something you hover over. That
distinction is not cosmetic. Without it the model is told who it is twice and
given two different answers, and no amount of personality text survives that.

### Changing the personality without deploying anything

Set an **`ORB_PERSONA`** variable in the Cloudflare dashboard — Workers &
Pages → `orb-brain` → Settings → Variables and Secrets → Add. Whatever is in
it replaces `PERSONA` wholesale; `PROTOCOL` is still appended. Save takes
effect on the next question. No terminal, no build, no computer. `GET /persona`
confirms what took.

It is a plain text field with room for a few thousand characters, so it can
hold real detail — how it talks, what it cares about, what it should never say,
facts about whoever owns it. That is all a "custom agent" is: a paragraph of
text in front of the conversation. There is no training and no memory beyond
the twenty messages the page sends each turn.

`keep_vars = true` in `wrangler.toml` is what stops a later `wrangler deploy`
from deleting that variable. Do not add `ORB_PERSONA` to `wrangler.toml` — the
file would then win over the dashboard on every deploy, which is exactly the
thing being avoided.

### What it can see

The voice and the page used to be two programs that shared a user: ask it to
play something and it plays, ask it what is playing and it says it has no
music, because the half that answers had never been told anything the half that
plays knows.

The page now sends a `state` snapshot with every turn — what is playing, whose
figure is on screen and at what build stage, whether the room or the menu or a
picture is up — and the Worker renders it into a few lines of the system prompt
labelled as *what you can see, not something to report*. Without that label a
model reads a status line as an announcement, and nobody wants to be told what
is on their own screen.

It is rebuilt key by key rather than passed through. The snapshot arrives from a
request anybody can make and it lands in a system prompt, so nothing reaches the
model that is not asked for by name: unknown keys are dropped, strings are
scrubbed and bounded, and booleans must be exactly `true`. The worst a forged
one can do is lie about which song is playing.

Nothing is sent when nothing is happening, so an idle question costs no extra
prompt at all. With a track and a figure up it is about 150 bytes.

### More than one character

The orb is not the only one who talks. When the avatar's body is on screen the
page sends `persona: "colin"` with the turn, and the Worker looks that id up in
`CASTS` to find two dashboard variables:

| Variable | What it holds |
| --- | --- |
| `ORB_PERSONA_COLIN` | his character file — same plain text field as `ORB_PERSONA`, same few thousand characters |
| `ELEVEN_VOICE_COLIN` | the ElevenLabs voice id he speaks in (a cloned voice, say). `GET /voices` lists the account's |

Both are optional. An unset persona falls back to the orb's, an unset voice to
`ELEVEN_VOICE_ID` — so a character can be added with a voice before he has been
written, or written before he has a voice, and neither state is an error.

Adding another character is a row in `CASTS` plus two variables. That row is
the only part that needs a deploy; the writing and the voice never do.

**The page sends an ID, never a prompt.** The site is public, so every field in
the request is something a stranger can set to anything. An id is a key into a
table — the worst a forged one can do is pick a character that already exists,
or miss and get the orb. If the page could send prompt text, anyone with the
endpoint could run whatever system prompt they liked on this account's
Anthropic and ElevenLabs credits.

The voice resolves in four steps, most specific first: an explicit `voice` in
the request (the tuning panel, so auditioning a voice is never overruled by
whoever is on screen), then the character's own, then `ELEVEN_VOICE_ID`, then a
stock id so a fresh deploy makes a sound.

### Deploying: already automatic

**This Worker is connected to the repo and deploys itself.** Workers & Pages →
`orb-brain` → Settings → **Build** → connected to this repo with **root
directory** `worker`. Every push to `main` builds and deploys it. There is
nothing to run and no computer to be at. `npx wrangler deploy` is the manual
fallback, not the normal path.

The connection lives entirely in the Cloudflare dashboard, so it leaves **no
trace in this repo** — no `.github/workflows`, nothing in `wrangler.toml`.
Reading the repo and concluding "this has not been deployed" is wrong, and has
been got wrong from inside a sandbox more than once — including once after
reading this very paragraph, by an agent that then told him to go and run
`wrangler deploy`. There is no `.github/workflows` because there does not need
to be one. The absence is the design, not a gap. Nor can it be checked by
curl from every environment: sandboxed sessions may have a network policy that
403s `*.workers.dev` at the proxy before the request leaves the machine.

**How to actually check what is live**, from anything with a browser:

```
https://orb-brain.<you>.workers.dev/persona
```

Look for a distinctive sentence from `PROTOCOL` — currently *"short is for
saying the thing quickly. It is never for saying less of it."* `PROTOCOL` is compiled
into the code and is appended after `PERSONA`, so unlike the persona half it
**cannot** be overridden by the dashboard's `ORB_PERSONA` variable. That makes
it a true test of whether the code deployed, rather than of what somebody typed
into a text field.

Change the marker whenever `PROTOCOL` changes, or the check silently passes on
the build before last: any sentence still present in both is a test of nothing.

The one real failure mode: a build that **failed** leaves the previous version
serving, silently. `tsc` has broken twice here on backticks inside template
literals. If the marker sentence is missing, the Worker's Deployments tab has
the failed build and its log — a different problem from "nobody deployed it".

The dashboard's inline editor is not an option here — this Worker has an npm
dependency and needs a build step.

## Choices worth knowing

- **Fast mode first.** The same model at up to 2.5x the output tokens per
  second — a research preview, Opus 5 only, with its own rate limit separate
  from standard and billed at $10/$50 per MTok rather than $5/$25. A 429 falls
  through to standard rather than failing.
- `effort: "low"` — voice wants an answer back fast far more than it wants a
  deeper one. Raise it to `"high"` if you would rather have considered replies
  than quick ones. Thinking stays **on**: it is on by default on Opus 5 and it
  costs latency, but disabling it is worse than it looks — with thinking off the
  model sometimes writes a tool call into its visible *text* rather than a
  `tool_use` block, which here means the orb saying the word "show" out loud and
  drawing nothing.
- `max_tokens: 1024` — deliberately small. This gets spoken aloud, and a long
  reply means a long speaking animation.
- A refusal is caught and turned into one short sayable line, rather than
  reaching the page as an empty stream.
- A wordless turn gets a line too, and which line depends on why. Claude can
  answer with only a `show` call and no text; that used to come back as "I had
  nothing to say to that", which was a lie about a perfectly good answer. A
  turn that drew something says so; a genuinely empty one asks you to repeat.
- Errors are caught and turned into something sayable, so a failure never
  leaves the orb stuck mid-state with nothing to say.

## Porting

Nothing here is Cloudflare-specific except the export shape. On Vercel or
Netlify, keep the body and swap `export default { fetch }` for that platform's
handler signature.
