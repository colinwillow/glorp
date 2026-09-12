# Postbox

Drop everything you make into one folder and talk to it. It files the work,
describes it, drafts posts, plans the grid, crops and titles images, and hands
finished posts to a Discord channel. Whatever posts them for real reads that
channel; that is not this tool's job.

Local: a Node server, a browser UI, a folder tree. No build step, no
database. Everything it knows is a file you can open.

```
inbox/         drop things here (subfolder = project hint)
library/       library/<project>/<name>-<id>.<ext> + a .json sidecar each; edits are new files with derivedFrom
posts.json     drafts, approved, scheduled, handed off
grid.json      the planned Instagram grid, newest first, three per row
BRAIN.md       its memory: voice, rules, an "## Auto mode" prompt, and a log of every decision
chat.json      the conversation so far
outbox/        dry-run handoffs, one folder per post, when no Discord webhook is set
```

## Run it

```sh
npm install
cp .env.example .env     # ANTHROPIC_API_KEY for the conversation; DISCORD_WEBHOOK_URL for the handoff
npm start                # http://localhost:8140
npm test                 # 33 checks: headers, grid maths, scheduling, image edits, tools, handoff, offline chat
```

Without a key it still runs on heuristics and the chat becomes a command line
(`arrange`, `propose`, `crop <id> portrait "Title"`, `approve <id>`…). With a
key, the chat is Claude with every tool below and `BRAIN.md` as its brief.

## Talk to it

The 💬 button opens a panel that has hands. Things it can do, because these
are the tools it is given (`server/tools.js`):

| Say | It calls |
| --- | --- |
| "put the three robits levels on the top row" | `get_grid`, `list_library`, `set_grid` |
| "tidy the grid so each row is one project" | `arrange_grid` |
| "crop Foundry to 4:5 with the title on it, bar in the project colour" | `edit_image` |
| "make a story version of every peggy logo, padded, not cropped" | `list_library`, `edit_image` ×n |
| "draft three feed posts, lead with the hook swing" | `propose_posts` |
| "shorter caption on that one, drop the hashtags to five" | `update_post` / `regenerate_post` |
| "approve the first two and plan times" | `update_post`, `plan_times` |
| "send the Peggy one to Discord" | `hand_off` |
| "never lead a row with a logo" | `remember` → appended to `BRAIN.md` |
| "describe everything that has no description" | `analyze_asset` ×n |

Every call it makes is shown as a chip under the reply, and the UI reloads
after each turn, so you watch it work. Every tool is also a route
(`POST /api/tools/<name>`), so a script can use the same hands.

## Compose

Open any image and the drawer has *Compose*: crop to square / 4:5 / 9:16 /
16:9 with attention-based framing (or *fit whole image* for logos), a title
and subtitle band, a colour bar in the project colour. Live preview, then
*Save as new asset*. The original is never touched; the derived file records
its `derivedFrom` and the ops, so "same but smaller title" is one more call.
Server-side via sharp, so the chat and auto mode can do it too.

## Auto mode

*Auto → Run auto now*, or hit `POST /api/auto/run` on a timer. With a key it
runs the assistant on the standing prompt in `BRAIN.md`'s `## Auto mode`
section (default: ingest, describe, propose, arrange, approve above the
confidence threshold, plan times). Handoff to Discord is off unless the run
allows it. Without a key the same steps run as a fixed pipeline. Every run is
logged to `auto-log.jsonl` and shown in the Auto view.

## Handoff

`DISCORD_WEBHOOK_URL` set: *hand off* posts the title, caption, hashtags and
the media as attachments to that channel. Not set: it writes the same thing to
`outbox/<post>/` so you can see what would have gone. The per-platform
adapters in `server/adapters/` still validate shape and caption limits and
stay deliberately unwired for live posting.

## The rest of the UI

- **Library**: filters by project, kind, shape, text; palettes extracted in
  the browser; ratings and hides feed the proposer and the brain.
- **Proposals**: per platform, optional direction, editable cards; approve /
  reject / regenerate with a note, all logged.
- **Grid**: phone-shaped, drag to reorder, auto-arrange, cohesion per row.
- **Queue**: plan times from engagement windows at the brain's cadence.
- **Brain**: edit `BRAIN.md` in place.

## Getting work in

```sh
node tools/harvest.mjs ../peggy ../robits            # post-worthy images from repos → inbox/
node tools/screenshot.mjs http://localhost:8123 --project peggy --sizes square,portrait,story
npm run ingest                                        # --no-ai to skip the model
```
Or drag files anywhere onto the page. Duplicates are skipped by content hash.

## Where the AI is

| Job | Module |
| --- | --- |
| Conversation with tools, auto mode | `server/chat.js` (SDK tool runner) over `server/tools.js` |
| What is this image, tags, palette, mood, post-worthiness | `server/analyze.js` (vision, structured JSON) |
| Captions, covers, carousel order | `server/propose.js` (structured JSON) |
| Grid maths, scheduling, image edits | no model: `grid.js`, `schedule.js`, `edit.js` |

`BRAIN.md` goes in as a cached system prompt on every call. Editing it is the
steering wheel; the chat's `remember` writes to it too.

## Next

- [ ] Image-to-image generators behind the same `edit_image` shape (OpenAI /
      Gemini) for covers that need more than a crop and a title.
- [ ] Reels: 9:16 clips with a Suno bed, muxed by ffmpeg.
- [ ] A "post to Discord" that includes a contact sheet of the carousel (the
      renderer exists: `contactSheet()` in `edit.js`).
- [ ] Analytics back in from whatever reads the channel.

## Moving this to its own repo

Self-contained; nothing outside `postbox/` is referenced.

```sh
cd glorp && git subtree split -P postbox -b postbox-main
git pull ../glorp postbox-main     # from a fresh repo
```
