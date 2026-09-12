# Postbox

Drop everything you make into one folder. Postbox files it, describes it,
proposes posts, plans the grid, and (when you say so) will post it.

It is a local tool: a Node server, a browser UI, and a folder tree. No build
step, no database. Everything it knows is a file you can open.

```
inbox/      drop things here (subfolder = project hint)
library/    where they end up: library/<project>/<name>-<id>.<ext> + a .json sidecar each
posts.json  proposals, the approved queue, the published log
grid.json   the planned Instagram grid, newest first, three per row
BRAIN.md    the tool's memory — voice, rules, and a log of every decision you make
outbox/     what a dry-run publish would have sent, one folder per post
```

## Run it

```sh
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY for the real analysis and captions
npm start                # http://localhost:8140
npm test                 # 21 deterministic checks, no network, no browser
```

Without a key everything still works on heuristics: titles from filenames,
projects from folders, palettes from pixels (extracted in the browser), fit
scores from shape. With a key, Claude looks at each image and fills in what
it actually is, and writes the captions in the voice from `BRAIN.md`.

## The loop

1. **Get things in.** Drag files onto the page, or put them in `inbox/` and
   press *Ingest*, or harvest from a repo:
   ```sh
   node tools/harvest.mjs ../peggy ../robits          # copies post-worthy images into inbox/
   node tools/screenshot.mjs http://localhost:8123 --project peggy --sizes square,portrait,story
   npm run ingest                                       # --no-ai to skip the model
   ```
   Duplicates are skipped by content hash, so re-running is safe.
2. **Library.** Filter by project, kind, shape, colour, text. Rate things
   (★ feeds the proposer), hide things, fix titles, re-analyse.
3. **Proposals.** Pick a platform, give it a line of direction if you want
   ("launch week for Peggy"), press *Propose*. Each card has a cover, the
   carousel order, a caption you can edit, hashtags, and the reason it chose
   that set. Approve, reject, or regenerate with a note. All three are written
   to `BRAIN.md`, so it learns what you keep.
4. **Grid.** A phone-shaped Instagram grid. Drag from the library, drag to
   reorder, or *Auto-arrange* which packs rows of three by project and palette
   and alternates projects between rows. Each row shows a cohesion score.
5. **Queue.** *Plan times* gives every approved post a slot from the
   engagement windows in `server/schedule.js`, at the cadence in `BRAIN.md`,
   never two on one platform inside six hours, never the same project back to
   back. Edit any time by hand. *Dry run* renders exactly what would be sent
   into `outbox/<post>/` and flags problems (wrong shape for the platform,
   caption over the limit).

Nothing publishes for real yet. `server/adapters/index.js` has one adapter per
platform with `format()` done and `publish()` throwing until it is wired; the
dry run exercises everything up to the API call.

## Where the AI is

| Job | Module | Without a key |
| --- | --- | --- |
| What is this image, tags, palette, mood, post-worthiness | `server/analyze.js` | filename + folder + shape heuristics |
| Group assets into posts, write title/caption/hashtags/hook | `server/propose.js` | project + palette grouping, description as caption |
| Grid arrangement | `server/grid.js` | pure maths, no model involved |
| Posting times | `server/schedule.js` | pure heuristics, no model involved |

The model reads `BRAIN.md` as its system prompt on every call, cached, so
editing that file is the steering wheel. Structured JSON output is used
throughout, so a bad answer is a parse error rather than a mystery.

## Generators (all stubs except text)

`server/generators/index.js` lists the pluggable makers with one interface:
OpenAI image (covers), Gemini image (variations), **Suno** (theme music — the
reason a reel posted by API can have a soundtrack at all, since the in-app
licensed library is not available to third-party posting), Tripo (image to 3D
turntable). Each is a documented `generate()` that throws until a key and a
few lines are added.

## Roadmap, roughly in order

- [ ] Live adapters: Instagram Graph API (needs a Business/Creator account +
      Meta app), X API v2, TikTok Content Posting API, YouTube Data API.
- [ ] Auto mode: a `POSTBOX_AUTO=1` loop that ingests, proposes at the cadence,
      auto-approves anything above a confidence threshold, and publishes at
      the planned time. Off by default forever.
- [ ] Reels: ffmpeg pipeline for 9:16 crops, text overlays, Suno bed.
- [ ] Cover composer: title text on a cover, project colour bar, consistent
      corner mark.
- [ ] Trend input: paste a screenshot of the current grid or a hashtag
      search and let the model factor it in.
- [ ] Cross-post variants: one approved post becomes per-platform versions
      (X caption from the Instagram one, story from the feed crop).
- [ ] Video thumbnails and dimensions for `.mov`/`.webm` via ffmpeg.
- [ ] Analytics back in: pull engagement per published post into BRAIN.md so
      the proposer learns from what worked, not just what you approved.

## Moving this to its own repo

It is self-contained; nothing outside `postbox/` is referenced.

```sh
cd glorp && git subtree split -P postbox -b postbox-main
# then in a fresh repo:
git pull ../glorp postbox-main
```
