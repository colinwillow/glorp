# Glorb

A voice you can talk to, drawn as a particle field. Single HTML file, no build
step, no dependencies. The optional brain and voice live in `worker/`.

Open `index.html` over HTTPS — `getUserMedia` will not run from `file://`.
It is live at https://colinwillow.github.io/glorp/

Descendant of the old p5 `Okay` sketch — same steering behaviours, rewritten
without per-frame allocation.

---

## Architecture

Four layers. They only talk in one direction.

```
  microphone ─┐
  script     ─┼─► drive ──► loop() ──► canvas
  its voice  ─┘  (struct)   physics
```

### The drive struct

```js
const drive = {
  scale:      0,                      // 0-1  loudness envelope
  spectrum:   new Float32Array(64),   // 0-1  per band, log spaced
  turbulence: 0,                      // 0-1  sibilance (zero-crossing rate)
  impulse:    0,                      // 0-1  onset spike (spectral flux)
  hue:        0                       // 0-1  brightness (spectral centroid)
};
```

**Nothing upstream touches physics.** Five numbers is the entire interface. The
microphone fills them; so does a scripted animator; so does the orb's own
synthesised voice. Physics cannot tell which, and has never needed to change to
accept a new source. Keep this boundary intact — it is the reason the state
machine, and later the brain, cost almost nothing to add.

`analyse()` writes a separate `mic` struct rather than `drive` directly. That
separation is what lets voice detection keep running while a scripted state
owns the visuals — otherwise the orb could not hear itself being interrupted.

### The scripted states are the demo, not the default

`thinking` and `speaking` animate canned envelopes. That is their job: they make
the orb look alive on a page with no microphone and no brain. But the state
machine dropped into them **three quarters of a second after every pause**, and
a canned envelope runs nearly twice as strong as an actual voice — so the field
went quiet while somebody was speaking and then flailed about the moment they
stopped. Which reads precisely like a visualiser ignoring you, and was reported
as exactly that.

Measured through the real analysis path, with a voice playing into
`getUserMedia`:

| | state | drive | orb radius |
|---|---|---|---|
| before, silence | thinking → speaking | **0.35** | 221 px |
| before, voice | listening | 0.19 | 232 px |
| after, silence | idle | **0.00** | 133 px |
| after, voice | listening | 0.18 | **233 px** |

A pause with a live microphone goes to **idle** now, which reads the microphone,
rather than to `thinking`, which does not. A real question still sets `thinking`
from `ask()`, which is the only place that ever knew one was being asked.

---

### States

`idle | listening | thinking | speaking`, each writing the same five channels.

| state | source |
|---|---|
| `idle` | the microphone if one is live, else a slow scripted breath |
| `listening` | the microphone |
| `thinking` | a bright lobe orbiting the ring on a fixed clock. Nothing about it is random, which is what makes it read as *working on something* rather than reacting to something |
| `speaking` | its own voice, analysed exactly as the microphone is. With no voice configured, a syllable clock built from the reply's own vowels |

Transitions are automatic with a manual override. Voice above `vadOn` wins from
any state, so it can be interrupted mid-sentence. Changes cross-fade over
260 ms — a hard cut between sources reads as a glitch, not a mood.

Idle passing the microphone through matters: idle means nobody has said
anything yet, not that the orb has stopped hearing.

### Physics, per particle per step

1. **arrive** — steer toward a target, slowing inside 100px
   ```js
   ringR = (baseR * (1 + drive.scale*rmsGain)
          + drive.spectrum[band] * baseR * specGain) * shapeLut[angle]
   ```
   The band index comes from the particle's **index**, so bass and treble
   occupy fixed arcs. `bloom` multiplies the target by an index-rated sine —
   at 1 it swings through zero and every particle oozes through the centre;
   near 0 the ring holds still. Anything above ~0.6 smears the silhouette
   across every radius at once, which is what makes shapes stop reading.

2. **membrane** — signed radial force toward the surface, sampled at the
   particle's **current angle**. It samples the shape and the ellipse too, or
   it pulls everything back onto a circle and sands the corners off.

3. **turbulence** — random jitter. Sibilants shatter the surface, vowels leave
   it smooth.

4. **flee** — steer away from the pointer inside `fleeRadius`.

A share of particles (`core`) sit out all of this and hold a small central
circle instead — no spectrum, no shape, no membrane, no kick. They still
breathe, because their radius carries loudness.

The onset **kick** scales each push by that particle's own shape radius.
Pushing everyone out by the same amount *adds a constant* to `r(theta)`, and
adding a constant to a radial function is exactly what rounds it toward a
circle — which is why every loud moment used to flatten the silhouette.
Pushing by `c*r` turns `r` into `r*(1+c)`, a pure dilation, so the outline
stays similar to itself however hard it is hit.

### Shapes

The silhouette is not drawn anywhere. Size and colour key off distance from
centre, so a circular target can only ever produce concentric bands. The
outline lives entirely in the target, so it is a radial function `r(theta)`:

`circle · triangle · square · pentagon · hexagon · star · rosette · mouth`

Each is precomputed into a 256-entry angular table, normalised to a peak radius
of 1 so switching shapes never changes how far the orb reaches. `shape` sets
the resting silhouette, `shapeGain` lets the spectral centroid drive the morph;
fractional values are real blends, not snaps.

The **mouth** is `1 - 0.62*|sin t|^0.72` — the kink in `|sin|` puts cusps at
left and right, so it is a lens with corners rather than a squashed circle.
`ellipse` and `jaw` then work it like lips, and the mapping is phonetically
real: `/i/` and `/e/` carry a high second formant and spread the lips, `/o/`
and `/u/` are low and round them. When a real reply is spoken its vowels are
extracted and fed to the same channel, so the silhouette shapes the actual
words.

### Rendering

- `size = (1 - dist/falloffPx) * sizeHi`, deliberately allowed to go
  **negative**. `Math.abs()` makes distant particles large again and the colour
  formula clamps green to zero when size is negative. **That sign flip is where
  the purple comes from.** It was an accident in the original and it is
  load-bearing now.
- The **negative-space ring** is simply where size crosses zero. Measured with
  a scalar distance it can only be a circle, so `splitEll`/`splitJaw` give the
  boundary its own aspect and `splitShape` makes it follow the current outline
  — audio deforms the ring itself rather than shoving particles outward to fake
  it.
- `follow` blends the split between an absolute pixel distance and a fraction
  of the current ring radius. Fixed in pixels it stops tracking the orb: shrink
  `radius` and the whole field ends up inside the green zone with no ring and
  no purple at all.
- Colour is a function of size only, precomputed into a 96-entry LUT, rebuilt
  only when the hue shift or the size range actually changes.

### Containment

The orb can explode to the viewport edge but never through it. An ellipse
matching the viewport aspect (so a phone gets its full height), inset by the
largest dot that can be drawn. Past `contain` a quadratic spring ramps in; at
the wall a hard stop projects the particle back and removes only its *outward*
velocity, so particles graze along it instead of piling up. Each particle gets
its own wall radius, or a saturated orb traces the boundary as a visible edge.

Verified with the drive pinned at maximum across phone, desktop and 320x400:
nothing leaves the viewport.

---

## Audio

Level is measured in **dB against an adaptive room floor**, not linear RMS.
Conversational speech is about -30 dBFS, i.e. rms ~0.03, which `min(1, rms*6)`
turned into 0.19 — so the form only woke up for shouting while the spectrum
bars, already dB-scaled, looked perfectly lively. The floor follows the room
down fast and up slowly, so response is relative to ambient: a quiet room does
not become twitchy and a noisy one does not go dead, with no calibration step.

`dbMargin` is how far above the measured room the response starts; `dbRange` is
how many dB from there to full. The meter shows both the live input dB and the
tracked room floor, which is what you set `dbMargin` against.

**All three timbre channels read *high* on near-silence**, not low: zero-crossing
rate is high for low-level noise, flux fires on FFT jitter, and the centroid of
noise is arbitrary. Ungated, an idle microphone in a quiet room was worth a
constant outward push of ~3 px/frame² and blew the orb into the wall on nothing
at all. `hue`, `turbulence` and `impulse` are gated by level above `gateFloor`;
`scale` and `spectrum` are already amplitude-proportional and are left alone.

---

### The floor is the room, not the quietest thing that ever happened in it

With the microphone off, the orb sits as a compact magenta ring around a green
core. Switch the microphone on in the same silent room and it used to blow open
to fill the screen: `lvl 0.63`, `turb 1.00`, with nobody talking.

The level is measured relative to a noise floor, which is right — a quiet room
should not be twitchy and a noisy one should not be dead. But the floor was
tracked by falling fast and climbing back over about half a minute, which makes
it a **minimum tracker**. One unusually quiet instant — a gap between two words,
a moment of gain riding, a still second — pinned it far below the ambient level
and left it there. On the phone it sat at −79 dB while the air itself was −51,
so ordinary silence came out 28 dB "above the floor" and the orb read it as
somebody shouting.

It is a percentile of the recent past now. Four seconds of history, and the floor
is the level a fifth of it falls below: in a quiet room that is the air, and
while somebody is talking it is *still* the air, because the gaps between words
are more of the take than the words are. Speech cannot desensitise it and one
quiet frame cannot deafen it. Sorted at 10Hz rather than every frame — the floor
does not move fast enough to care.

Measured end to end, with a WAV played into `getUserMedia` so everything below
the microphone is the code the phone runs. Four seconds of room tone at −51
dBFS with **one 150ms near-silence at 2s**, then speech-shaped signal, then room:

| | floor | the silent room reads |
|---|---|---|
| before the dip | −56 | lvl 0.00 |
| after the dip, old | **−82** | **lvl 0.55, turb 1.00** |
| after the dip, new | −56 | **lvl 0.00, turb 0.00** |

The old floor never recovered — five seconds later the same silence still read
0.31 with turbulence pinned at 1.00. That is the whole of the screen-filling
orb, and it also explains why voice had nothing left to say: ambient was already
eating half the range, so speech peaked at 0.99 and saturated. With the floor
where it belongs, silence is 0.00 and the entire range is the voice.

**And then the gate had to move with it,** which was missed and cost a round.
`dbMargin` is how far above the room a sound must be before it counts and
`dbRange` is how much louder again reaches full scale. Both were large — 9 and
31 — because they had been tuned against a floor sitting nearly 30 dB *below*
the room: the gate had to be huge to reject silence, and the range had to be
huge to climb to the top from down there. Against a floor that genuinely is the
room, the same two numbers reject the **voice**. A phone at arm's length reads
only a few dB over its own room, and 9 dB of margin threw all of it away.

Fixing one end and leaving the other is how a correct change lands as a
regression: silence went still, and so did speech.

Swept against a voice 3 dB over ambient, through the real analysis path:

| margin | range | silence | voice mean | voice peak |
|---|---|---|---|---|
| 9 | 31 | 0.00 | 0.01 | **0.06** |
| 4.5 | 18 | 0.00 | 0.07 | 0.35 |
| **2** | **18** | **0.00** | **0.17** | **0.43** |
| 1.5 | 10 | 0.00 | 0.25 | 0.93 |

Silence stays at 0.00 for any margin at or above 1.5, so the margin was pure
loss — the floor is doing the rejecting now, which is what a floor is for.
`gateFloor` came down from 0.09 to 0.05 for the same reason: it gates the timbre
channels off the level, and at the new levels it was holding turbulence shut
through ordinary speech.

---

## Timing

Physics runs on a **fixed 60Hz accumulator**, decoupled from rendering:

```js
physAcc += dt;
while (physAcc >= STEP && steps < 4) { physAcc -= STEP; step(); }
```

The original used p5's `frameCount`, so it literally ran at double speed on a
120Hz display. iOS also throttles rAF to 30fps when idle — with the accumulator
that changes the fps readout but not the motion.

Don't reintroduce `frame++` inside the render path.

---

## Brain and voice

Optional. Without them everything still runs; the orb just reacts to sound and
mouths a scripted reply in silence.

- **Speech in** — the browser's own recogniser. No key, no proxy. Press `talk`.
- **Thinking** — Claude, through the Worker in `worker/`.
- **Voice out** — ElevenLabs, through the same Worker. The reply is played
  *and* analysed, so `speaking` reads real audio rather than a syllable clock.

The reply is **boosted and limited** on the way to the speakers — gain, then a
limiter. It used to go straight from the decoder to the output at whatever level
the voice was rendered at, which is a long way below full scale: a phone at
maximum sounded like someone talking in the next room. Measured on a
speech-shaped signal peaking at −16.6 dBFS, rendered through the real chain
offline, it returns **+10.6 dB RMS** with peaks landing exactly on the limiter's
−6 dBFS and nothing clipped. Gain alone would push the peaks into distortion; a
compressor alone cannot make anything louder. `volume` on the slider.

The analyser stays where it was, tapping the signal **before** the boost. The
mouth animation is tuned against those numbers, and moving the tap would have
quietly re-tuned the speaking state along with the volume.

The API keys live in the Worker, never in the page — this is served from GitHub
Pages, so anything in `index.html` is public and a leaked key is billable. The
page only ever learns the Worker's URL, which it keeps in `localStorage`.
Setup is in [`worker/README.md`](worker/README.md).

**Coming back to it.** iOS suspends the AudioContext the moment the app goes to
the background and does not resume it on return — the analyser then reads a dead
stream and the orb sits there deaf with the mic still saying live. Speech
recognition is stopped outright, and its `onend` restart never runs because the
page was hidden when it fired. `visibilitychange`, `pageshow` and `focus` all
resume it. None of that needs another gesture: the permission is still granted,
so it is a resume, not a request. Only a track that has actually **ended** needs
a tap, and that says so rather than silently doing nothing.

Recognition is deafened while the orb talks, or it hears itself through the
speaker and answers its own reply forever. `abort()` rather than `stop()`,
because `stop()` finalises whatever is pending — which at that moment is the
orb's own words. `echoTail` covers how long the room keeps ringing afterwards.

### Where the wait actually goes

The pipeline is serial — whole reply, then whole clip, then speak — so the line
under the caption breaks it into legs. Optimising the loud one instead of the
big one is the failure mode this exists to prevent.

```
endpoint 1740ms  think 5229ms (claude 5022 via plain, net 207)  tried fast [400] 391ms
then effort:low [400] 288ms then plain 4343ms  write 0ms  voice 412ms  = 7381ms to first sound
```

- **endpoint** — recognition deciding you have stopped talking. It happens after
  your last word and before any of our code runs, so it used to fall outside the
  measurement entirely and read as the model being slow. Timed from the last
  *interim* result: the last moment there was evidence of talking.
- **think** — the request leaving the page to its first token, with the Worker's
  own measurement of the Claude leg split out, so a slow network and a slow model
  can be told apart.
- **tried** — every attempt the Worker made, in order, with failures and their
  status codes. One slow answer and two dead round trips add up to exactly the
  same `claude` number and want completely different fixes. Shown only when
  there was more than one.
- **write** — first token to last. **voice** — reply complete to first sound.

Two things came straight out of reading that line. Attempts that fail with a
**400** are retired for the life of the isolate rather than being paid for on
every single turn (a 429 is a limit that lifts, so that one stands off for a
minute instead). And the default model is **Haiku 4.5**, not Opus 5: Opus was
taking 5.0–5.7s to its first token, three quarters of the total wait and more
than everything else in the pipeline put together, for a reply that is two
sentences long by design. `ORB_MODEL` in the dashboard puts a bigger one back
without a deploy.

---

## Formations

The orb can stop being a ring and become a drawing: a word, an emoji, a face.
It happens **locally**, off the recogniser's interim results — no round trip,
no key, no Worker. Recognition delivers words in a couple of hundred
milliseconds; the two-second wait is the language model, and matching a word
never needed one.

Three ways in:

- **Trigger words.** Say one of the words in `TRIGGERS` and the matching shape
  forms. `happy` draws 😀, `love` draws ❤️, `fire` draws 🔥, `hello` spells
  HELLO. Around forty words across feelings, objects, and short words that read
  better spelled than pictured.
- **Celebrations are not drawings at all.** Nobody wants a picture of a
  firework. Those hand off to a **shell** — see below.
- **The brain's `show` tool**, when it decides a shape says it better than a
  sentence.
- **`/show <thing>`** in the tune panel, which takes a word, `face`, a shell
  name, or any trigger word — so a shell can be watched without saying it.

### echo · duet

The `echo` button cycles three ways, and the choice is remembered.

| mode | heard | answered |
| --- | --- | --- |
| off | — | out loud |
| echo | every word spelled as it lands | brain out of the circuit entirely |
| duet | **a muse** | out loud **and** shown |

`duet` is the default. Duet used to spell what it heard as well, and a
transcript drawn in particles turns out to be the least interesting thing this
can do with a voice — legible, and dull. Echo keeps that behaviour for when the
literal reading is what you want; duet gets the muse instead.

Ask it its name and it says "I'm Glorb" while the field spells GLORB.

Choosing what to show is three rules in order. A trigger word anywhere in the
reply wins outright — say congratulations back and the sky goes up. Otherwise
the longest word carrying any weight stands in for the sentence, filler words
excluded. And if the brain reached for `show` itself, that wins over both: it
picked deliberately, and two pictures for one sentence is one too many.

The timing matters more than the choice. The picture is scheduled to where its
word actually falls in the sentence — word index over word count, times the
measured length of the audio, minus a beat so it is up slightly before the word
is said rather than after it.

### Why emoji read at all

Everything above is one mechanism: draw the string to an offscreen canvas, read
the pixels back, keep the lit ones. Which is why arbitrary words are free — if
the font has the glyph, the orb can draw it.

But "lit" means two different things, and getting that wrong is what made the
first attempt fail. Our own text is painted pure white, so every lit pixel is
signal and the **fill** is the drawing. An emoji is painted by the font in its
own palette, and 😀 is a solid yellow disc with dark features on it — threshold
that on alpha and you get a filled circle with no eyes and no mouth.

So the sampler decides which it is looking at: chroma and luminance spread near
zero means one flat colour, which means our text, which means fill. Anything
else is **traced** instead — silhouette edges, interior colour edges, and the
dark features themselves. A face comes out as a rim, two eyes and a smile; a
heart as an outline.

One particle per sampled point, so the count follows the drawing: ❤️ samples to
about 470 points, 😀 to 1800, 🎉 to 1700. The orb borrows particles for the
duration and hands them back after.

### Opening a picture is a move

A tapped tile **grows** into place and **shrinks** back into the tile it came
from — interpolated corner to corner over 420ms, easing out. A cross-fade would
say they are two different pictures; growing says they are one picture at two
sizes, which is what they are.

### The gallery is a page

Say **images** and you get a grid: three across, a row at a time sliding in from
alternating sides, drag to scroll with inertia, tap one to open it, swipe
sideways between them, tap again — or swipe down — to shrink it back to the grid,
**home** to leave, or tap the little orb at the top. It stays until you leave it.

The entrance alternated per **tile** first, which with three columns means both
directions inside every row and a separate start time for each, so the grid
assembled on a diagonal and nothing read as coming from one side or the other.
The **row** is the unit that reads as horizontal. It also starts a full screen
width out rather than 42% of one: a right-column tile offset by `0.42W` begins in
the middle of the screen and slides a short way, which looks like a nudge.
Travelling the whole width is what makes it arrive *from* somewhere.

Tapping closes an open picture, because tapping a tile is how it opened — the
gesture a thumb tries first. Swipe-down still works, but a gesture you have to
be told about cannot be the only way out. The threshold is the same as the
grid's tap: under a finger's width in under 400ms, so a finger that moved is
still a swipe.

The particles do not go away — they line the **top and bottom** of the screen as
a slow wave, so the field is still there holding the frame rather than
pretending it is a website. It is an ordinary formation, so it breathes with the
room like everything else; that is the whole reason not to draw a rectangle in
the 2D context and call it a frame.

Two things bit, and both are the same mistake: **formation coordinates are not
screen coordinates.** They are scaled by `min(W, H)` on *both* axes, so on a
tall phone `x = 1` is already off the side and `y = 1` is nowhere near the top.
Two straight lines have to be solved for the actual half-width and half-height.
And the containment wall is an **ellipse** fitted to the viewport, so a straight
line across the top has both its ends outside it — the hard stop projected them
back onto the curve and drew two arcs. A wide formation now has no wall, the
same exemption the hologram's floor needed.

Tiles are **covered, not contained**: a grid of mixed aspect ratios with
letterboxes between them is a contact sheet, and filling each cell is what makes
it read as one surface. A grid shorter than the space it has is centred, because
six square tiles in three columns cannot fill a phone however they are arranged
and top-aligning them leaves a void that reads as a loading failure.

### The drawing hands over to the picture

Say **images** — or pick it from the menu, or `/show gallery` — and the particles
trace one, then the photograph itself fades up in exactly the rectangle the
drawing occupied, and the particles let go and fall back to the orb behind it.
Swipe sideways for the next one, down to leave.

This is the point the formation system had been walking toward without saying
so: **the field is a way of announcing a thing, not a substitute for it.** A
drawing made of dots is a beautiful way to say *a photograph is coming*; it is a
poor photograph. Nothing is thrown away — the drawing is the transition, the
photograph is the destination, and for about a second you can see the dots
through the picture, which is the only frame in which it is obvious that one
became the other.

The sampler already fits every picture into 94% of a square, so reproducing that
fit puts the bitmap exactly where its own drawing stood. That is the whole trick;
there is no second coordinate system.

One bug worth keeping. `photo.img` is cleared once the fade has run out, and
that cleanup ran on the very frame after the picture was handed over — throwing
it away before its own fade-in had started. Alpha climbing, correctly, on
nothing at all. A pending fade now blocks the clear.

### It should say something

Opening the gallery is handled on the page — the word **images** is a command, and
a command is answered by doing it, so it never reaches the brain. Which meant the
most theatrical thing this does happened in **total silence**: six pictures slid
in and the orb had nothing to say about them.

`remark(lines)` is a spoken line with no round trip: it goes through the same
`/speak` path a reply does, so the field reacts to it like any other sentence
rather than sitting still through its own big moment. The lines are Watts,
roughly — delighted by the thing in front of him and unable to resist pointing
out that you are the one looking at it. *"Behold: light, pretending very
convincingly to be people."*

The guard is the interesting part. `showGallery` awaits the folder listing and
six image loads before anything is on screen, and by the time it finishes the
brain may already be speaking — so a check at the end finds a clear coast and
talks straight over it. The decision is made **before the first await**, from the
state at the moment the gallery was asked for. It never picks the same line twice
running, either; a random choice out of eight repeats often enough to be noticed.

The brain has a `gallery` option on the show tool now as well, for the phrasings
the trigger words miss (*"can I see your drawings"*), and is told to say something
in the same key when it uses it. When it does, the page stays quiet.

### Pictures

A drawing is a glyph the font does not have. Drop a PNG into `images/` and

```
/show image hero
```

fits it, samples it with the same sampler the emoji use, and forms it. A bare
name tries `.png .jpg .jpeg .webp .svg` in that order; a name with an extension,
or a URL, is taken at its word. The `images` item in the menu is a slot pointed
at `images/glorb.*` — put a file there and it fills. If a picture is missing the
caption says so and the orb draws the name instead of nothing, because a picture
that is not there is nearly always a picture that is not there *yet*.

Pictures are sampled **finer and drawn bigger** than glyphs. A letter has five
or six strokes in it and 220 pixels is generous; a rendered character has a hat,
a beard, a belt buckle and a tear in one knee, and at 220 those all land in the
same handful of pixels — 300 gives about 2,500 points instead of 1,400. And a
picture is the thing being looked at rather than a caption on the orb, so it
gets its own scale and steps past the containment wall; at the glyph scale a
whole character came out a third of the height of the screen.

**Glorb has to be told they exist**, or it answers that it has no pictures —
true from where it is standing, and it reads as the feature being broken rather
than unwired. A static host cannot list a directory, so the page works out the
contents itself: a checked-in `images/index.json` wins if there is one, and
otherwise the hostname is read backwards into an owner and a repo and GitHub is
asked for the folder. The list rides up with every question and is named in the
system prompt, and the `show` tool takes an `image`. Neither method working is
fine — it just means the brain is never told, which beats it offering a picture
that is not there, and `/images` in the box says what was actually found. Both
sources are merged rather than tried in turn: the manifest is the one that can
be relied on, the listing is what means a file dropped in the folder needs no
other edit. Asked once at startup, so nothing waits on it mid-sentence.

### Showing costs something

The field cannot be a word and be moving with the voice at the same time — a
formation holding is a formation the audio is damped under. So **a picture
nobody asked for is paid for with the reaction to the sentence carrying it**,
and duet used to draw one on every single reply: it took the longest non-filler
word out of the answer and spelled it.

That is off (`autoWord`, 0 by default). Drawing a word is worth keeping for when
a reply genuinely turns on one — a name, a colour, a number, a single answer to
a direct question — and the longest word in the sentence is not that judgement.
The machinery is all still there; nothing calls it.

The brain's own `show` tool used to be told to fire "whenever a word would land
better shown than said", which is most sentences if you squint. It is now told
that most replies should show nothing, what the cost is, and the test: *if you
could not say which word the reply turns on, it does not turn on one.*

### A glimpse, not a placard

A word Glorb shows is a word it is *saying*, and that turned out to be the whole
design. Thrown up as soon as the reply text arrived, it did two wrong things at
once: it stood there for five seconds, which is most of a spoken reply, and the
field cannot be a word and a mouth at the same time — so the sentence the word
was meant to punctuate went by with nothing moving. And it appeared at the
start, whatever the word was, when the word it draws is usually somewhere in the
middle. Shown first and said later reads as two unrelated events.

So it waits for the audio. Only then is the reply's real duration known, and
therefore where in it the word falls; the formation is scheduled for that
moment, a little early, because a picture arriving *with* the word reads as
arriving late. It holds for `FLASH_S` — about half a second — and goes, and the
mouth has the rest of the sentence back.

One thing had to change underneath. The ease is a fixed fraction per frame,
which takes about a second to arrive: fine for a shape that then stands there,
useless for something meant to be glimpsed. A show under two seconds eases in
nearly three times faster, so it has time to actually be a word before it
leaves. Measured: up at 6128ms into a 6667ms reply — which is exactly where
*galaxies* falls in it — peak 0.98, gone by 6960ms.

Fireworks and meshes are events in their own right and still fire on arrival.

One thing had to be added for pictures that glyphs never needed. A glyph arrives
on a transparent canvas; artwork usually does not, and art exported on white
would sample as a solid rectangle. So the four corners **of the picture** are
read first, and if they agree, that colour is the background and gets knocked
out. If they disagree, the image has a real background and it is left alone
rather than guessed at.

Two details, both learned the hard way and both worth keeping:

**Corners of the picture, not of the canvas.** Fitting leaves a transparent
margin, so the canvas corners read as empty no matter how the art was exported
— which let white straight through. The same drawing sampled to 760 points on
transparency and 2,657 on white: a filled silhouette with a frame around it.

**Then erode twice.** Where a background meets the drawing the renderer leaves a
ramp of blended pixels, and the ones nearest the paint survive the knock-out and
ring the whole figure in a second contour. A ramp pixel is one that is still
nearly the background *and* touches the background; a real edge fails the first
half of that. With both fixes the same artwork samples to 819 points
transparent and 842 on white — within three percent, which is resampling noise.

---

### Limiting the palette

The colour was running the whole wheel — magenta to red to yellow to blue —
on nothing more than the timbre of a quiet room, which read as a traffic light
rather than as a thing reacting. Two causes, both fixed:

**Colour rode on the spectral centroid alone, not on loudness.** At ordinary
speaking level the centroid wanders all over its range, so the palette swung its
full arc on ordinary noise. It rides on level as well now: below about a fifth
of full it does not move at all, and it only reaches full swing when something
is genuinely loud — which is the one time the wild colours are wanted.

**Rotating a hue rotates both ends of the palette, and they sit 180° apart.**
There is no rotation that puts the rim in the blues without putting the core in
the yellows. So the two ends move by different amounts and in opposite
directions: the rim swings a long way (violet toward blue), the core barely
moves and toward mint rather than away from it.

Measured off the built LUT — the rim sampled where it actually reads, the core
at its brightest:

| level | centroid | shift | rim | core |
|---|---|---|---|---|
| 0.05 | any | 0° | violet 290 | green 108 |
| 0.25 | 1.00 | 1° | violet 289 | green 108 |
| 0.42 | 1.00 | 20° | blue 270 | green 112 |
| 0.65 | 1.00 | 60° | cyan-blue 230 | green 123 |
| 0.95 | 1.00 | 71° | cyan-blue 219 | green 125 |

Red, orange and yellow are now unreachable at any input. `HUE_RIM` and
`HUE_CORE` are the two coefficients; setting them to `1` and `1` restores the
old single-rotation behaviour. A firework still turns the whole wheel at once —
its own colour is passed as `flat`, outside the split.

---

### Colin, built from the feet up

Say **colin** — or *dance*, or *figure*, or `/show figure` — and the field builds
a rigged, skinned, animated model of a person out of itself, from the floor
upwards, and then leaves him dancing. Four wipes climb the body, each starting
before the one below it has finished:

| | |
|---|---|
| **dots** | particles leave the ring and stand on the vertices |
| **lines** | edges appear between dots that are already in place |
| **fill** | the surface closes over the lines, in the orb's own green |
| **texture** | the real model arrives, textured and lit, on the GPU |

Measured, one frame per 500ms: at 1.4s the legs are a wireframe and everything
above the hips is still a cloud; at 2.3s the shoes are textured, the jeans are a
green-and-violet ghost fill, and the head is still dots. Leaving runs the same
four wipes back **down** in the opposite order — the colour drains off first and
the dots are the last thing to go, which reads as undressing rather than as
rewinding.

**It animates the whole time**, from the first foot. A figure that stands still
while it assembles and then starts moving is two things — a diagram, and then a
character. One thing that is alive while it is being made is much stranger.

Everything gates on **one number per particle**: `figH`, its height up the body,
0 at the feet and 1 at the crown. From the **bind** pose, not the live one — a
wipe that follows a waving hand is a wipe that goes backwards. An edge or a face
takes the height of its *lowest* corner, so each stage arrives as one front
rather than a fringe; taking the highest made the surface trail the lines by a
whole limb across the shoulders, where one triangle can span a lot of body.

#### The GPU, and why it had to be one

The first version of this rendered the figure in Canvas 2D like everything else,
and next to the model's own render it looked like a PlayStation 1 character. Not
a tuning problem. Canvas 2D is a **2D rasteriser**: it cannot map a texture
across a triangle, it cannot interpolate a normal, and it will not antialias a
fill. Working around all three meant

- one flat colour per face, sampled at its centroid,
- three levels of flat shading,
- a 49-colour quantised palette,
- and the mesh decimated to an eighth of its vertices so the fills could keep up.

Every one of those is visible in the picture, and no amount of tuning closes the
gap, because what was there was a software renderer written by hand.

So **the figure, and only the figure, is rendered by three.js** on a second
canvas and composited into this one. The orb, the menu, the gallery, the
holograms, the shells and the whole particle field are untouched — they are what
Canvas 2D is good at. What changed is that the thing the particles resolve into
is now the real mesh at full resolution, with its own PBR material and its own
texture, lit by an environment map.

three is **vendored, not fetched from a CDN**, and resolved by the browser's own
`<script type="importmap">` rather than by a bundler — which keeps the one thing
this project is built on, that there is no build step. 876KB in `vendor/`.

**Composited, not layered.** The 2D canvas paints its trail over the whole frame
every frame, so a WebGL canvas behind it is invisible and one in front of it
covers the particles. Drawing it *into* the 2D context, immediately after the
trail and before the dots, is what lets the model sit between them.

**The camera is not a choice.** The 2D projection is `FOC / (FOC + depth)` with
`FOC = scale * 1.7` in pixels, which is a pinhole a distance FOC in front of a
projection plane through the origin. Put three's camera at exactly that distance
and give it the field of view that makes the viewport's height come out at H
pixels on that plane, and the two projections are the same projection — so the
particles land on the model rather than near it.

**The wipe is a shader, not a clipping plane.** A plane cuts at a height in the
world; the 2D side gates on a vertex's height in the *bind* pose. Those disagree
by however far the pose has moved that vertex, which on a raised arm is most of
a limb — the dots would be up there waiting and the surface would refuse to
arrive. So `onBeforeCompile` injects a varying carrying the bind height and the
fragment shader discards above the front. It has the better behaviour anyway: a
hand builds when the hand's place *on the body* is reached, not when it crosses
a line in the room.

**The ghost is a second mesh**, sharing the first one's geometry and skeleton,
in the orb's green — that is the fill stage, the surface arriving before its
colours do. It occupies the band between the surface front and the texture
front; below the texture line it would be a translucent film over the finished
model, which is not a stage, it is a mistake.

**The dots hand over.** Once the real surface has arrived under a particle it
has done its job — the same bargain the photographs make with the drawings that
introduce them. Except on the silhouette: `nzv`, the vertex normal's component
along the view axis, is already computed for the back-surface culling, and a
particle whose normal is nearly perpendicular to the camera is standing on the
edge of the figure. Those stay. A rim of dots around him is the one place the
field and the model are obviously the same object.

Two bugs on the way through:

- **`lo || gl.uGhoLo`** gave the textured mesh the *ghost's* lower bound, which
  is the texture front itself — so every fragment was both below the top and
  below the bottom and the entire model discarded. 1,297 lit pixels out of
  369,800, with three draw calls and 137,604 triangles going through them, which
  is the shape of a shader problem rather than a scene problem.
- **The build clock started before the load.** Three quarters of a second of
  parsing a 3.6MB file went by with the wipes already climbing, so the first
  thing on screen was a figure two thirds assembled.

And one that had been sitting there unseen: the particle side flipped **only y**
on the way from model space into formation space. The 2D renderer is left-handed
the way a screen is — x right, y down, z away — and glTF is right-handed with y
up and z toward the viewer, so the conversion needs **two** flips. One flip is a
mirror. With nothing to compare against, a mirrored figure is just a figure; the
moment there was a real render beside it, it was obvious.

Lighting was swept against the model's own render. Exposure 1.55 with the
environment at 1.5 washed the denim to grey and the hoodie to mid-tone — which
is what over-lighting a PBR material with white does, the albedo stops being
visible under it. It sits two stops below that, with a cool rim from behind
because on a black background the far edge of a figure has nothing to separate
it from the void.

*Not yet measured on real hardware.* This container has no GPU — Chromium falls
back to software rasterisation, where the numbers are meaningless. The one cost
that is real on a phone and not visible here is the per-frame `drawImage` of the
WebGL canvas into the 2D one.

#### The hood in front of the face

Reported as looking like a normals problem, and it is not — it is the depth
buffer being switched off, by the file.

```
"alphaMode": "BLEND",
"doubleSided": true
```

glTF says a blended material does not write depth, and three implements that
correctly: `depthWrite = false`. Nothing then occludes anything. Every triangle
in the mesh blends over whatever is already in the buffer, in **index order** —
and the back of the hood happens to come after the face in that order, so it
lands on top of it. Double-sided doubles the number of triangles competing.

Almost always this is an exporter artifact. A character is opaque; the material
says BLEND because the tool it came out of had alpha blending on by default. And
that is **checkable rather than assumable**: the base colour map is already
decoded for the software fallback, so its minimum alpha is one scan away. It is
**255** — there is no transparency anywhere in it, BLEND cannot be doing
anything, and promoting the material to opaque is a correction rather than an
override.

If a map really does carry alpha, it is left blended and the reason is logged
instead. Silently discarding somebody's cutouts to fix their hood would be much
worse than the hood.

The ghost had the same bug by construction — a translucent mesh that overlaps
*itself* has no depth write either, so the far side of its hood blended over the
near side of its face, in green. It is opaque now. "The surface has arrived, its
colours have not" is said better by a solid surface anyway.

One thing left alone: the file's `KHR_materials_specular` carries
`specularColorFactor: [2, 2, 2]`. The glTF spec says that is a colour and should
not exceed 1, so the highlights are running at double strength. That is a value
in the asset and a judgement about how it should look — unlike `depthWrite`,
which is not a matter of taste.

#### What had to be built

- **Skinning.** Sample the keyframe curves, walk the node tree for each joint's
  world matrix, multiply in the inverse bind, blend four per vertex. 66 joints,
  a 13-second take, 198 channels. It costs **0.32ms a frame**, which was the
  surprise — the drawing is the expensive half by fifty to one.
- **Decimation.** 24,446 vertices and 45,868 triangles is an order of magnitude
  past what a canvas full of dots can draw. Vertex clustering takes it to 3,085
  and 6,404, and the clustering is **attribute-preserving**: each cluster keeps
  one representative's skin weights and texture coordinates. Averaging weights
  across a cluster that spans two limbs tears the mesh apart the moment they
  separate.
- **A software surface, now the fallback.** One flat colour per face sampled at
  each triangle's centroid, baked once at load (UVs do not change when the model
  moves — that is what UVs are) and quantised to 49 colours so the surface can
  still batch by colour. It is what draws when three is missing, WebGL is off,
  or the file will not parse. It is also, on its own, the whole reason the GPU
  had to come in.
- **A stage chooser.** Five buttons while a figure is up: the four states and
  `auto`. Holding a state freezes the wipes where that state covers the whole
  body. The build is over in four seconds and the interesting middle of it is
  about four hundred milliseconds wide, so each state needed to be sittable-in.

#### Three bugs, and what each one looked like

**`GLB_N` had no `MAT4`.** `GLB_N[a.type] || 1` read an inverse bind matrix as
*one float per joint at a stride of four bytes*. Every joint got a garbage
transform and the figure collapsed to a fifth of its own size — a thin vertical
sliver with two stray lines hanging off it. The `|| 1` fallback is what made it
silent: a missing entry looked like a scalar rather than an error, so it read out
cleanly and drew wrong. Its bounding box (0.09→0.53 wide against a 5-unit model)
is what named it.

**The wipes stopped at exactly 1.** Which leaves the last soft-edge band — the
top eighth of the head — permanently half gated, so the finished figure had no
crown: no surface on it, no texture, just dots. Every wipe now runs past the top
of the body by the width of its own soft edge.

**`cfg.wire` is 0.12,** which is right for a mesh whose lines are a hint under a
cloud of dots and invisible when the lines are the entire thing being shown. The
lines stage did not read at all until a figure was allowed its own weight — and
then read as a solid grey mass, because nine thousand edges over a body 250px
tall is a fill. Thinner and at 62%, they are lines again.

#### What it costs

60fps while the dots assemble, a dip to **29fps** at the busiest moment (a full
dot cloud, a full wireframe, and the surface climbing through it), then **40–43
fps** textured and dancing. Two things paid for most of that: the wireframe used
to walk the whole edge list once per depth bucket and throw away five sixths of
it each time — 56,000 wasted iterations at a figure's 9,310 edges — and the lines
under a closed surface were nine thousand segments producing a barely visible
fringe behind something opaque. They are drawn in one pass now, and only where
they are still the outermost thing.

---

## Listening

### When is a sentence over?

Reported from a desk with music playing: say a sentence, finish, and watch the
visualiser bounce along to the stereo while nothing happens.

Recognition's own answer — the `isFinal` result — is that **the room has gone
quiet**. In a room with music in it, the room never goes quiet. The right answer
is that **the words have stopped**: the transcript has not changed for a while,
whatever the level is doing.

So the sentence is sent on the gap in the interim stream, and the `isFinal` that
arrives later for the same utterance is swallowed. Measured: sent **649ms** after
the last word, against `gapMs` of 620. It is the difference between an
endpointer that listens to a room and one that listens to a person, and `gapMs`
is on the tune panel because how patient it should be is a matter of taste.

### Talking over him

Recognition stays **up** while he speaks now, and what it hears is mostly his own
voice out of the speaker — so the only question asked of it is whether the words
are *his*. Enough of them are not, and somebody is talking over him, and the
right response is to stop talking.

Not to obey it. The words heard during a reply are thrown away: they are half
his and half yours and there is no telling which is which. He goes quiet and
listens, and you say it again — which is what the thing this is imitating
actually does.

The test is a bag of words, deliberately blunt, because the recogniser is hearing
a mixture of two voices and a careful comparison of a mixture is a careful
comparison of nothing:

| what the recogniser hears, while he says a sentence | novel words | |
|---|---|---|
| his own words back | 0 | keeps talking |
| a few of his words | 0 | keeps talking |
| *"hang on, stop, wait a second"* | 4 | stops |

When the clip ends, recognition is **aborted and restarted** rather than merely
gated. It has been accumulating a transcript of his own voice for the whole
reply, and left alone that arrives as a finished sentence a moment later and
gets answered.

### Going somewhere is a decision

*"What is this for"* was landing on the site. *"I like your pictures"* was
opening the gallery.

Anything that changes **where you are** now waits for the whole sentence, and the
sentence has to read like a decision: either almost nothing but the name of the
place, or an actual instruction with a verb in it. The transient triggers — an
emoji, a firework — still fire on the word as it goes past, because they are over
in a second and cost nothing if they were not meant.

| said | |
|---|---|
| *"what is this for"* | answered |
| *"i like your pictures"* | answered |
| *"tell me about the images you have"* | answered |
| *"pictures"* | goes |
| *"show me the pictures"* | goes |
| *"can you open the gallery"* | goes |
| *"menu"* | goes |

The brain was doing the same thing from the other end — its instructions said to
show the pages when asked what was here. They now say that this is a
conversation and not a menu system, that a question about what this is wants an
*answer*, and that `pages` is for an explicit request to be shown around.

And `menu` was declared **twice** in the trigger table. The second one wins,
silently, which is the second time that has happened in that object — so the
word went on routing to the retired satellites instead of to the site.

### The greeting

One line now, and it does not tell you what to do. It used to say hello and then,
a beat later, *"you can ask me things, say pages"* — which is a tooltip read
aloud, and which he then obeyed, having heard himself say it. He introduces
himself and stops.

---

### He was hearing himself

Reported as "it auto-goes to pages", with the right guess attached: *"I wonder
if he's registering his own word."* He was.

The greeting is two beats — hello, then what you can do about it — and the second
was scheduled from `planMs`, which is set by `playReply` from the decoded audio.
`remarkThen` read it on the line *after* calling `remark`, which is async, so it
got the **previous** clip's duration. Zero, at startup. The follow-up landed 1.4
seconds in, cutting the greeting off halfway — and an interrupted clip fires the
old source's `onended`, which switches the ears back on. In the middle of the new
sentence. Which happened to be *"say pages and I will show you around."*

Three fixes, because one is not enough for something that drives the app:

- `remarkThen` **awaits** the first line, so the gap is measured from the clip
  that is actually playing.
- Only the clip that is still current gets to say the talking has stopped. A
  generation counter; an interrupted source returns from `onended` doing nothing.
- And a local command is never acted on while he is talking or inside the room's
  reverb afterwards. Even if a word gets through, it does not become an
  instruction. The echo tail went from 500ms to 850.

Measured, feeding the greeting's own text back in as if recognition had heard it:

| | while he is talking | in the room echo | a person says it |
|---|---|---|---|
| before | opens pages | opens pages | opens pages |
| after | nothing | nothing | opens pages |

### Two prompts, one at a time

"It asks for permission, says audio failed, asks again, then works."

The two prompts are unavoidable — see below — but the *sequence* was ours. The
wait between them was **1.5 seconds**, and what it is waiting for is a person
reading a permission dialog. It timed out with the first dialog still open and
called `getUserMedia` into the middle of it, which failed and had to be asked
again afterwards. It waits nine seconds now, and resolves on a grant, a refusal,
or the timeout — whichever comes first.

The "audio failed" was a second thing in the same moment: **iOS suspends an
AudioContext whenever the page loses focus, and a permission dialog counts.** The
context built during the tap was already asleep by the time the first sentence
tried to play. Every playback resumes it first now, which is free when it is
already running.

### He lies down

The top-of-screen orb on its perch was a small one drawn *separately*: 130 dots
of its own, fading in on their own timer, with the field doing something else
entirely. It appeared rather than arrived, which is the one thing this program is
not supposed to do.

So on the site and in the gallery, **the field itself becomes the bar**. The same
particles that were the orb travel down and lie out in a wide flat band along the
bottom, and when the page closes they gather back up into the middle. That is the
whole point of having a particle field, and it is what the two border lines were
not doing: a line across the top and a line across the bottom is a *sheet*, and a
sheet collapsing into a ball reads as particles arriving from the sides rather
than as one thing changing shape.

It also **reacts**, which a formation normally cannot — a fully formed shape
overrides the audio deformation completely, which is exactly why the border lines
sat there dead. The bar's targets are rewritten every frame from the spectrum
instead, the same trick the rig uses to animate a skeleton. It is a live meter
made out of him.

**Tap it to go home. Hold it to open the site.** A hold is the only gesture a
grid of tappable things has not already spent, and it gives the bar a job besides
being a way out.

And it is a **split**, not a move. Only about 46% of the field goes down to the
bar; the rest stays where it always is, resting in the middle, dimmed to a third,
still breathing with the room. So he is never entirely somewhere else — the bar
is him lying down and the ring behind the page is still him standing there, and
you can watch the two halves separate. The dim orb that used to be *drawn* behind
the page is gone: it is the real field now. A drawn copy of something that could
be the thing itself is the wrong answer in a program whose whole subject is
particles actually travelling.

That needed one fix underneath. The bar's resting positions were copied out of
`formX[0..formN]` — but the particles in a shared formation are spread *through*
the index rather than taken off the front, because particles are ordered by angle
and the first 46% of them is a 46% arc. It was copying a mixture of bar positions
and whatever the particles that stayed behind happened to be holding.

Two placement bugs on the way in. The bar landed exactly on the talk button — 58
pixels tall, 74 off the bottom edge — so every tap meant for the bar hit the
button and nothing reached the canvas at all. And the tap was being handled in
`onPick`, which runs *after* `onUp`, which clears the gesture's start time
partway through — so the tap arrived looking like a press that had lasted
forever. Whatever owns the screen, the way out of it is now the first thing
checked.

The small orb on its perch stays for the states where the field is busy being
something else — a hologram, or Colin. There, it flies **out of the middle of the
field** rather than switching on where it lands.

### Nothing arrives from a corner

A particle that has never been used sits at (0, 0) — the top-left of the screen —
because that is what an empty `Float32Array` holds. Borrow some for a formation
and they fly in from the corner, which is the one direction nothing else in here
ever comes from.

They come up from below the bottom edge now, spread across the width and already
moving upward, so a field that needs more of itself grows rather than leaking in
from a corner.

### One place at a time

Asking **out loud** for a page while the site was on screen loaded it straight
over the top: cards behind, photographs in front, both live. Tapping a card was
fine — tapping goes through `pageOpen`, which closes the grid before it opens
anything. The spoken route does not: a word matches a trigger and calls the
destination directly, so the tidying up existed on only one of the two paths into
the same place.

It belongs at the destination, not on the way in. Every place calls `takeScreen`
first, and whichever one is arriving turns the others off.

### A glimpse or a place

Reported as: leave the app, come back, and the field is a loose orb drifting
behind the page instead of the two border lines it was holding.

Nothing to do with leaving the app. **Every formation went through one thirty
second cap.** The site's border lines asked for 3600 seconds and got thirty; the
figure asked for ten minutes and got twenty-three. Half a minute is about how
long it takes to leave an app and come back, which is why it read as a
backgrounding bug and why it had never been noticed sitting still.

A formation is now either a **glimpse**, which expires — a word, an emoji, a face
— or a **place**, which is held until its owner takes it down. Anything asking
for longer than the cap is a place. The cap still bounds a word, which is all it
was ever for. The gallery had a line refreshing its own expiry every frame,
which was this same idea done once, by hand, for one caller.

The figure needed a second fix on top: a 3D formation sizes its own life off the
spin so it gets one full turn before it leaves, and that ignored the requested
duration entirely. An explicit duration past the threshold now wins over the
spin. Left alone for forty seconds, the figure used to stop dancing and vanish.

### It hears you but it does not listen

The other half of the same report: after coming back, the visualiser still
reacted to sound but nothing was being *understood*.

Those are two different subsystems on one microphone. The analyser was fine. The
recogniser was dead, and it had been dead since the first time it ended.

A recogniser ends constantly — every silence, every network hiccup, and always
when the app goes to the background — and this whole design depends on it coming
back. It was restarted from inside its own `onend`:

```js
rec.onend = () => { if (recOn && !sttPaused) { try { rec.start(); } catch (err) { caption(err) } } }
```

`start()` called synchronously inside `onend` throws `InvalidStateError` on
Safari, because the engine has not released yet. The catch printed it into a
caption nobody was reading, and then nothing ever tried again.

It restarts on a timer now, backing off, and gives up loudly rather than
silently. There is a `recRunning` flag — `recOn` is the *wish*, `recRunning` is
the *fact*, and every bug in this area has lived in the gap between them — plus a
watchdog that fires on that gap rather than on a timer since the last word. A
quiet room is not a fault, and rebuilding a recogniser to find out can cost
another permission prompt.

Measured against a fake recogniser that behaves the way Safari's does — it ends
on its own, and `start()` throws for 250ms afterwards — over four deaths:

| | starts | engine running |
|---|---|---|
| before | 1 | no |
| after | 5 | yes |

The HUD says `hear on` / `hear stalled` / `hear off` now, because this failure
was invisible from the outside: the microphone said `live` the whole time and it
was telling the truth.

### Two prompts is the floor

It keeps being reported as a regression, so: this page needs two different things
from the microphone. An **analyser**, for the visualiser, which is
`getUserMedia`. And **speech recognition**, which is a separate grant because the
audio leaves the device. Safari and Chrome both treat those as two permissions
and ask separately. Nothing here can merge them — the Web Speech API does not
expose its stream, and an analyser cannot be built out of one that does not
exist.

They are asked in the order that survives — speech first, analyser second —
because whoever asks **last** keeps the microphone.

What *was* fixable is the third prompt: the recovery path calling
`getUserMedia` again on its own, seconds after the one you had just answered.
The watchdog now waits twenty seconds from the grant, and the grant time is
recorded when the stream actually arrives rather than when somebody taps.

### The one behind

The bug above put the whole field back into a loose orb behind the page, and it
looked good. So it is a thing now rather than an accident: a large, dim orb
living behind the site, reacting to the room at about a third of full strength,
with the cards at 84% rather than 90% so he shows through them. Present enough to
notice when it moves, faint enough that the cards are still what you are reading.

It is drawn from `drive` like the little one — same construction, different size
and strength — so it costs 130 dots and nothing else.

---

### One tap, two handlers

A page card highlighted when you touched it and then did not open. It opened
fine under the test rig, every time.

A tap on a phone fires `pointerup` **and** `touchend`, in that order, for one
finger coming off the glass. Every handler here was registered on both, so every
handler ran twice per tap — invisible for anything idempotent, fatal for anything
that toggles. The card opened on `pointerup` and closed again on `touchend`,
about a millisecond later, which looks exactly like a tap that selects without
opening.

It survived the rigs because Playwright's `mouse.click` sends pointer events and
no touch events at all, so the second call never happened. **A phone was the only
place this existed.** There is a rig with `hasTouch: true` and
`touchscreen.tap()` now, and it reproduces it immediately.

Pointer events cover mouse, touch and pen; the touch list is a fallback for
anything that somehow lacks them. One or the other, never both.

---

### Somewhere to sit

A small orb floating loose over a page has nothing to do with the page. It
drifts across the readouts, it lands on the top of a card, it collides with
whatever the border line is doing — and it looked like an element that had been
put down rather than placed.

So he gets a **perch**: a small disc he rests on, which belongs to the page
rather than to him, and which moves. Where it goes is a property of what is on
screen, so putting him somewhere else for a given page is one line in
`miniSpot`. Currently: the top of the screen everywhere, and the **bottom** when
a page is open, because an open page's title is at the top and a floating orb
over a heading is exactly the collision being complained about. He eases between
them rather than cutting.

The disc is a flat ellipse with a rim of marks turning around it. That is the
whole 3D of it: an ellipse alone is an oval, and an ellipse with something
travelling around its edge is a circle lying down. The near half of the marks is
brighter, which is the only other cue it needs.

Everything at the top of the screen clears his band now — and the band is sized
for the loudest swell, not for the resting radius, because he grows with the
room.

`uiBottom()` is the same idea at the other end. The talk button is a primary
control sitting in the middle of the bottom edge and it is only there until
somebody presses it, so the grids give it room while it exists and take the room
back afterwards rather than permanently reserving a strip for a button that is
usually gone. The images card's photographs ran straight through the word IMAGES
until the card art was measured against the space it actually had — which
depended on whether the microphone had been enabled, and so appeared and
disappeared for no visible reason.

---

### The little one

Something else owns the field -- a hologram, a knot, a gallery of photographs --
and there is nothing left of Glorb on the screen. The thing you were talking to
has simply gone, which is also why there was no way back except saying so out
loud: there was nothing to touch.

So a small one sits at the top and keeps reacting.

It is **not part of the field.** The field is busy being a knot, and taking a
hundred particles back off a formation to staff a second orb puts a hole in the
first. It is drawn straight from `drive` -- the same one-way seam the big one
reads -- which is the whole reason that seam exists. Same LUT, same palette,
same swell on level, same per-band deformation around the ring. It just has its
own dots, and there are 130 of them.

The first version drew a ring of dots shaded by distance from the ring surface,
which is what the field does, and got a bright green hoop with a few purple
flecks in it. Nothing like Glorb. He is a **fat violet halo with a small hard
green centre and black in between** -- so the second version draws those two
masses separately, 92 shell dots deep on the negative half of the palette and 38
core dots at the top of the positive half. Reproducing the two masses is much
closer than reproducing the formula that happens to produce them.

Measured with the gallery up and the mic tape running, one second per bucket:

```
peak 0.44  0.44  0.44  0.44  0.44  0.43  0.00  0.00  0.00
mean 0.15  0.18  0.19  0.18  0.17  0.11  0.00  0.00  0.00
```

Which is the point of it: if the big one is reacting this one is reacting, and
if this one is still then the microphone is dead. It is a status light as well
as a presence.

**And it is the way home.** Tapping it leaves whatever is up. It is not shown
during the menu, because the menu's own hub *is* the orb and a second smaller
one above it says there are two of him.

A model or a hologram has nothing else on screen to touch, so a tap anywhere
leaves those too. Not the gallery -- there a tap is how you open a picture --
and not a word, which is gone in half a second anyway.

---

## Shells

A celebration is not a picture of a firework, it is one. Nothing is drawn: the
field is thrown outward and the pattern is whatever the launch geometry and the
decay make of it, which is why `congratulations` and `boom` do not look alike.

| word | shell | what it does |
| --- | --- | --- |
| `congratulations` `congrats` `yay` `woohoo` `bravo` | peony | violet, a hollow casing with radial streaks |
| `celebrate` | ring | blue, every star at one speed so it opens as a clean expanding circle |
| `birthday` | willow | magenta, slow and heavy, glittering, long drooping arcs |
| `party` | palm | cyan-blue, seven thick fingers instead of a cloud |
| `boom` `blast` | shock | blue-violet, one enormous fast shockwave, brief |
| `fireworks` | five in sequence | peony, spokes, valentine, frame, willow |
| `finale` | seven in sequence | opens on the shock |

Breaks are **1.4–1.5 s apart**, not 620 ms. Closer than that and they overlap
into one long bang; a shaped shell reads best around 450 ms and wants roughly a
second of clear air after it.

Three of them are **pattern shells**, reachable by `/show` or by the brain. A
real pattern shell packs its stars into a shape inside the casing, so the wall
of light that comes out is a figure rather than a circle — and the trick here is
the same one: scale each star's launch speed by a radius function of its own
angle, and the expanding front carries the outline out with it.

| shell | shape |
| --- | --- |
| `valentine` | a heart, pink |
| `nova` | a five-pointed star, violet |
| `pinwheel` | a ring given tangential speed, so it opens turning — blue |
| `prism` | a triangle, indigo |
| `frame` | a square, blue — opens hollow, with an X of slow stars in the middle |
| `spokes` | sixteen needle-thin rays, violet-blue, glittering |
| `crown` | eight rays given a slight turn, cyan |

How hard to exaggerate a figure is per-shell (`formPow`), because it depends on
the figure. A heart spans 0.66 to 1.39 and needs a little. A square spans corner
to edge by only 1.41, which after normalising is nearly nothing — at the heart's
setting it came out as a round green mass. A polygon needs its corners
exaggerated into points before a field of dots reads it as having corners.

The straight-edged ones run almost no gravity and very little drag, because an
outline only survives as long as nothing is pulling parts of it around.

### One trail, one palette

Three complaints about the fireworks, and two of them turned out to be the same
mistake made twice.

**The trail did not match.** Every shell carried its own -- 0.13 to 0.40 against
the orb's 0.46 -- so a firework smeared where nothing else in the program does,
which reads as a different renderer rather than as a different event. There is
one trail now. It also fixed the third complaint on its own: a long smear is
what turned discrete stars into the *big soft clusters* they were being reported
as, and at 0.46 individual stars stay individual.

**The colour was leaving the palette.** `hue` was a flat rotation of the whole
wheel, and the whole point of the palette work was that a flat rotation cannot
be kept in the blues -- the rim and the core sit 180 degrees apart, so pushing
one somewhere good pushes the other somewhere bad. `hue:110` on the peony meant
rim to **orange** and core to blue; the shock at 55 came out red. A shell's
colour now goes through the **same split** the voice rides on, where the rim
swings a long way and the core barely moves:

| hue | rim | core |
|---|---|---|
| −40 | 330 pink | 98 green |
| 0 | 290 violet | 108 green |
| 40 | 250 blue-violet | 118 green |
| 80 | 210 cyan-blue | 128 mint |

Red and yellow are unreachable at any value. It **replaces** the audio shift
rather than adding to it -- a firework is loud by definition, and the two
together walked straight back out of the palette.

Three more things for the "they are all just big poofs" half:

- **The peony is hollow.** `shell: 0.3` spreads the stars evenly by area, which
  means there is no front -- so it reads as a cloud that grows rather than as a
  casing that bursts. A real peony is a shell. It is 0.7 now.
- **`grain`** varies star size per particle. Every star used to be drawn at
  exactly one size, and a cloud of identical dots is a texture, not a firework.
  High on the round ones, near zero on the shaped ones, because a size spread is
  texture and texture is the enemy of an outline.
- **`glitter`** is not `sparkle`. Sparkle is per-frame noise on the radius,
  which reads as a shimmering surface; glitter is each star on its own slow
  cycle, which reads as a sky full of separate points going in and out. It is
  what makes a willow a willow rather than a slow cloud.

Two things the heart needed that the star did not. It is **centred on its own
bounding box** first: the parametric heart's origin sits up near the cleft, not
in the middle of the figure, so radius measured from it runs 5 at the top lobes
and 17 at the point — taken raw it fires a spike upward and a flat sheet down.
And the radius is **raised to a power** before use; the heart's own range is
only 0.66 to 1.39, and at that contrast it reads as a circle with a dent in it.

Shaped shells also hang rather than fall — gravity is what rounds an outline
off, because the top of the figure sags toward the middle inside half a second
— and they read best early, around 400–700 ms, before the front disperses.

Each shell is nine numbers: speed range, whether every star leaves at the same
speed (a ring) or across the range (a ball), how many spokes, upward bias,
gravity, drag, hue rotation, star size, trail length. All of the distances are
in reference units against a 400 px short edge, like `falloff` and `sizeHi`, so
a shell is the same shell on a phone.

Three things had to be switched **off** for any of it to work, and each one was
found by measuring rather than by reading:

- **The membrane.** It is a spring toward the ring surface, and at rest it is
  the strongest force in the program — a star 300 px out gets nearly 2 px/frame
  of inward pull. The first shells expanded, sprang back, and hung on the
  silhouette as a hollow outline. It comes off with the ring, cubed back in over
  the last stretch so the stars stream home instead of snapping there.
- **Distance-based dot size.** Everywhere else, a dot's size comes from how far
  it is from centre, which for a shell is exactly backwards: the further out a
  star gets the fatter it draws, until the explosion is one opaque blob. A star
  is a star — fixed and small.
- **The core.** It normally sits out the ring and holds. Let it sit out a shell
  too and a fifth of the field stays home as a bright lump in the middle of the
  explosion.

Coming home needed its own fix. Force does not do it: the field ends up hanging
low and the ring takes the better part of ten seconds to gather it. Position is
eased toward the ring directly for 1.6 s instead — the same reason formations
snap. And handing the borrowed particles back is not just drawing fewer of them:
a particle's ring slot is its index over the count, so dropping 1800 to 400
leaves every survivor pointing at the same narrow arc, and the orb re-forms as a
bunch on one side. Keep one particle in every `prev/n` and each survivor is
already standing near its new slot.

---

## Pages

The menu is retired. Six labelled satellites on spokes was a *diagram* of a menu
rather than a place, and next to a wall of real photographs it was plainly the
part that had not been designed yet.

What replaces it is the site itself: six cards, two columns, and **the left
column arrives from the left and the right column from the right** — literally,
which is the difference between this and the picture grid, where whole rows fold
in alternately. With two columns, "the left ones" and "the right ones" are a real
thing on the screen.

| page | what it is |
|---|---|
| `images` | the photograph gallery, which already exists |
| `characters` | Colin, rigged and dancing, which already exists |
| `motion` | not built |
| `design` | not built |
| `code` | not built |
| `about` | a text page |

A page is a `kind` and whatever that kind needs, and adding one is a line in the
`PAGES` array. `gallery` and `figure` point at features that already exist;
`text` and `soon` draw themselves.

**The cards draw little scenes** out of the same primitives the rest of the
program is made of — dots, a line, an arc, the green and the violet. Not
screenshots: there are no pages to screenshot yet, and a grey rectangle saying
*coming soon* is worse than nothing. The one page whose content already exists
shows four of the real photographs, because it can.

Two of them had to be redrawn after looking at them. The characters card sampled
a width function down a silhouette and got a cloud with a ring floating above it
— a figure needs its parts stated: shoulders, a taper, two legs, and a head that
is *filled* rather than outlined. And motion was horizontal bars, which read as
`code` two cards away; two cards that look alike is worse than one card that is
dull. It is a strip of film with the sprockets creeping now.

Tap a card and it grows into the page. Say its name and the same thing happens —
while the grid is up, its own page names outrank the brain, because *about* is a
preposition most of the time and a page exactly when there is a card labelled
ABOUT in front of you.

The satellite code is **kept, not deleted**. It is the nicest piece of formation
code in here — every node is a small orb with its own ring, core and gap — and it
will be worth something again the moment there is a reason for a hub with things
hanging off it. `setFormation({ menu: true, hub: true })` still builds it.

### Hello

The microphone button was a red circle with a microphone in it: the browser's
idea of what this is rather than ours, a warning colour on a screen that has no
warning colours anywhere else, for the one thing you are meant to press.

Then it was a pill reading TALK TO GLORB, which is a caption on a button that
did not need one — and it introduced him by name before he had introduced
himself. It is a microphone in the palette now, and nothing else. Everything it
would have said, he says out loud a second later.

And pressing it is the first moment there is a voice to speak with and a
microphone to hear the answer — which makes it the only moment worth spending an
introduction on. Two beats: a greeting, and then, once the greeting has finished
playing, what to do about it. An assistant that says hello and then waits is a
thing you have to guess at.

The greeting is time-aware, because "good evening" at eight in the morning is
worse than no greeting at all, and it is the cheapest possible way to say that
something is actually paying attention. `remark` already knows how long its own
line takes — from the audio, or from the estimate when there is no voice — so the
follow-up lands when the first one stops rather than on a guess.

---

## Menu (retired)

Say **`menu`**. The orb stays as a cluster in the middle, six satellites come
out on arms, and each one is a thing you can ask for — touch it, or say its
name. While the menu is up its labels **outrank everything, including the
brain**: saying "head" at a menu with head on it means that one, not a question.

Nothing new was needed to draw it. Satellites and arms are points, the arms are
edges, and the wireframe pass that grew a mesh out of a point cloud draws them.
Labels are text rather than particles — six words spelled in dots at that size
are a smear, and the point of a menu is that it can be read at a glance.

Down highlights and up picks, so a thumb can slide between them and land
somewhere deliberate rather than firing whatever it touched first.

Each satellite gets its own lobe count, its own drift and its own colour —
six identical circles are a diagram, and six in one colour read as one object
with lumps on it. The wobble is gentle and slow on purpose: the particles chase
it through a spring, so a fast or deep one is not a wobble, it is a target they
never catch, and it draws as spikes.

Saying `menu` no longer also asks the brain. It used to answer that it does not
have a menu and draw the word NO over the menu it was standing on; a local
command that has already taken the field means the utterance was for us. The
Worker knows about it now too.

Edit `MENU` and the menu changes; the geometry is built from its length.

After `idleS` seconds with nothing happening — no touch, no word, no formation —
it offers the menu on its own rather than sitting there being decorative. 0
turns that off.

---

### What made it stop reacting

The mouth config that became the default set `membrane` to 0.1, and that one
number is the whole of what went missing.

The membrane is a spring toward the ring surface — it is what ties the cloud to
the ring, and therefore what makes the cloud breathe when the ring does. At 0.1
the particles are loose enough to drift beautifully and far too loose to follow:
the ring swells with the voice and the cloud stays roughly where it was.
Measured against a fixed syllable train, raising it alone very nearly doubles
every reaction the field has — median-distance swing 27.7% → 52.8%, per-frame
motion 5.5% → 13.8% — and matches the old default across the board. No other
parameter moves those numbers by more than a few percent; eleven of them were
tried one at a time.

But a heavy membrane at rest is a different orb, and the resting look was tuned
deliberately. So it rides on level instead: `membGain` adds to the membrane in
proportion to loudness, which is exactly zero in a quiet room. A voice pulls the
field taut; silence gives the slack straight back.

**And it fixed the colour on its own,** which was not expected. The negative-space
ring is the set of points where size crosses zero, and that boundary tracks the
ring radius. With a loose membrane the cloud lags behind the ring, so the
boundary sweeps *through* the cloud every time the voice rises and the whole
field flips colour at once. Tie the cloud to the ring and the two move together.

Measured at the level a real voice reads (`lvl 0.42` on the meter):

| | before | with `membGain` |
|---|---|---|
| median radius under voice | 118 px | **146 px** |
| breathing (radius variation) | 1.4% | **2.4%** |
| colour churn per frame | 0.79% | **0.38%** |
| colour swing over a take | 41% | **15.8%** |

At silence both are identical — median 79.9 vs 79.4 px, which is inside the
run-to-run noise.

One wrong turn worth recording. Measured *before* the membrane fix, raising
`falloffGain` looked like the colour fix: it pushes the boundary outward with
level, and it cut the swing from 88% to 3%. It was compensating for the lag, not
removing it. With the membrane doing its job, the same change makes colour churn
nearly four times **worse** (0.38% → 1.48%), because now the boundary is
over-pushed past a cloud that was already keeping up. It stays at 0. Two rigs
disagreed and the second one was right; the first was measuring a symptom.

The `shaped`, `lips` and `mouth` presets carry `membGain: 0` — they are
historical configs and must not inherit a knob they predate.

---

## Muses

What it does while you are talking to it. The field wanders through a handful of
abstract behaviours — none of them about what was said, all of them driven by
the sound of it. It changes every four to seven seconds and cross-fades, because
a hard cut between two of these reads as a glitch rather than as a thought
moving on.

| muse | what it does |
| --- | --- |
| `rings` | three concentric shells, counter-turning |
| `wave` | a wave travelling round the rim |
| `comet` | one bright arc sweeping, bunching as it passes |
| `twin` | two lobes orbiting each other |
| `lattice` | snapped to a polar grid |
| `sparks` | every fifth particle thrown outward on onsets |

Each one also rotates the palette, so they read as different weather and not
just different geometry.

They run **whenever there is a live microphone** and nothing else has the field
— idle included. Gating them on the *listening state* meant they only ran inside
the second or two between the voice detector firing and the reply starting, and
they spent most of that fading in. And they **bloom with the sound** rather than
running flat out: a quiet room leaves the orb as the orb, and talking opens the
pattern. That difference is the reaction — without it a muse is a thing that
happens to be playing while you speak.

Every muse carries the spectrum. The first version used level for a third of a
radius and let time do the rest, which made six clocks that were dimly aware of
a room. The pattern has to be the carrier and the sound the thing carried, or
this is a screensaver with a microphone attached.

Each muse is **two numbers per particle** — a radius multiplier and an angle
offset — applied to the ring target before anything else touches it. That is the
whole interface, and it is why none of them had to know about the shape, the
membrane, the containment or the colour: they move the target, and the rest of
the program does what it always does with a target. Written into module scratch
rather than returned, because this runs per particle per physics substep and an
allocated pair each time is millions of objects a second.

Two things had to give way, and both had already caught me once:

- **The membrane**, again. It is a spring toward the ring surface and the
  strongest force here at rest, so three concentric shells were sprung back onto
  one and the whole muse came out as a slightly restless circle. Everything that
  scales the ring now goes through **one multiplier** the membrane reads back.
- **Bloom.** It smears each particle's target across a range of radii, which is
  what gives the resting orb its depth and what sands off anything with radial
  structure. Damped in proportion to how much muse is running.

## Sharing the field

A shape takes a **share** of the particles, not all of them — `share`, default
0.62 — and the rest go out to the rim and keep breathing. A word drawn by the
whole field leaves nothing outside it, and the ring around a shape is most of
what makes the shape look like it belongs to something.

Participants are spread **through the index**, not taken off the front:
particles are ordered by angle, so the first 62% of them is a 62% arc and the
shape would be drawn by one side of the ring with the other side left empty.

The free particles **part rather than surround**. A ring big enough to encircle
a word has to be as wide as the word is long, which means an enormous circle
around a small piece of text — so the top half arches over it and the bottom
half under it, and the word can stay small. The arch peaks in the middle because
`1 - e²` is 1 there and 0 at the ends, which is the shape a brow makes, and the
gap is measured from the shape's own half height so a tall emoji pushes them
further out than a line of text does.

Walked along the arc, not taken from the cosine of the angle: uniform angles are
not uniform in x, and the first version piled a third of the field into two
lumps at the tips. The membrane fades on those particles as the shape forms —
it is radial, so left on it reels the two halves back into the circle they were
just talked out of.

Everything the audio does now exists in two versions, one damped and one not. A
particle holding the shape wants its motion damped or the letters smear; a
particle on the rim wants all of it, or the perimeter freezes into a dead circle
for as long as the word is up, which looks worse than no perimeter at all.

## One or the other

A solid owns the field until it is done with it. Two formations fighting over
the same particles is not a transition, it is a glitch — ask for a head, get a
head, and then a smiley face two seconds later because the reply had a word in
it. That includes fireworks, which would take the whole field out from under a
model mid-turn. Another **model** may replace one, since that is a deliberate
choice rather than a collision.

---

## Depth

The particles have a `z` now, and it is bolted on rather than designed in —
deliberately. Everything tuned in here is 2D and works: size from distance, the
colour split, trails, containment, the shells. So `z` is a fourth number that is
**zero for all of it**. The ring is flat, a glyph is flat, a shell is flat, and
with `z` at zero the projection is the identity and the distance is the old
distance. It only goes non-zero when something asks.

Say `sphere`, `cube`, `torus`, `helix` or `knot` — or `/show cube`, or
`/show model <name>` for anything in `models/`.

Three things make it read as depth:

- **Perspective.** One rotation and one divide per particle. Near dots draw
  bigger, and the camera turns while a solid holds, because a still projection
  is just a drawing. **One** turn: a revolution is a look at the thing from
  every side, and past that it is a screensaver. Ending on exactly `TAU` means
  the view is back where it started, so there is no residual rotation to unwind.
  A solid's duration is derived from it — land, draw itself in, turn once, go —
  rather than picked out of the air, which either cuts it off mid-turn or leaves
  it standing there afterwards. It turns from the first moment, so it arrives
  already moving.

  It also starts **facing you**. A file cannot say which way a model faces, so
  it is worked out: the most protruding point at mid height is the nose, the
  prow, the front — true of nearly anything modelled with a front, harmless on
  anything without one. Averaged over the outermost few percent rather than
  taken from one vertex, or a stray spike decides which way a head looks. On
  `test_head.glb` that comes out at 80°, which is exactly the quarter turn it
  needed; before it, the head opened in profile looking right.
- **Colour is depth.** A glyph converges every particle on one size, and the
  eighth of the old size left behind is the point — it keeps letters from
  looking printed. For a solid that residue is fatal: a particle 400 px out
  starts at size −250, and an eighth of that swamps a depth signal worth a few
  dozen. So a solid converges fully, onto its own `z`: near lands on the
  positive end of the palette and far on the negative, and the colour split that
  separates the core from the ring becomes the shading.
- **Painter's order.** These dots are opaque, so without a depth sort the far
  side draws over the near side about half the time and a solid reads inside
  out. Indices are sorted, never the arrays, so every particle keeps its ring
  slot and its lottery ticket.

Both rotations are scaled by `formT`, and that is the bug it fixes: a formation
releases over a second and a half, and for all of it the field is flat again
while the camera is still turned — so the ring, and whatever was asked for next,
came back skewed and then snapped straight. Rotation now unwinds exactly as the
shape dissolves.

Models arrive **upside down** without a fix: model space is Y-up and the
screen's y grows downward. Negating y is the whole of it — except that negating
one axis mirrors the mesh, which reverses every triangle's winding, and the
winding is where the face normals come from. Left alone the back-face cull hides
precisely the half it should show. The faces get reversed too.

Radius is the one thing that does *not* come from `size` here. The magenta half
of the palette is stretched 2.4× to reach full saturation, which would otherwise
make the far side of a model the fattest thing on screen.

### Models

`models/*.glb` or `models/*.obj`. A bare name tries `.glb` first and `.obj`
second, so nobody has to remember which they exported.

**GLB** is what people actually export, and it is the one that matters: twelve
byte header, a JSON chunk describing the file, a binary chunk holding the
numbers. All this needs out of it is `POSITION` and the indices. It is more code
than OBJ because it is binary and indirect — accessor → bufferView → buffer,
with strides — but it is also the format that carries skins and animation, which
is where this has to go next. Node transforms are composed on the way through,
because exporters routinely bake the Y-up/Z-up fix into one and a mesh read
without it arrives on its side. Draco and meshopt compression need a decoder
that cannot be inlined; they announce themselves in `extensionsUsed` and are
reported rather than guessed at.

**OBJ** is still there because it is a text format a person can read and forty
lines can parse. It is the fallback, not the preference.

Either way, once you have vertices and triangles a mesh is a mesh. Points are
scattered across the triangles **by area**, or every dense corner gets as many
particles as every flat wall, and everything is centred on its bounding box and
scaled to fit — a mesh exported in millimetres or modelled off-origin otherwise
arrives off screen at a thousand times the size, and it is never obvious which.

### Hiding the far surface

Without it a solid is a speckle. Nothing occludes anything, so the far surface
shows straight through the near one and a head reads as a cloud shaped vaguely
like a head.

The cross product that weights the triangle sampling is doing two jobs: its
length is twice the area, and its direction is the surface normal. So every
sampled point carries the orientation of the triangle it came from — taken from
the face rather than from the file's own vertex normals, which keeps it working
for an OBJ that has none, and a per-point orientation is all that is wanted for
dots anyway. Rotate that normal with the camera and drop the points facing away.

Two details that are the difference between working and looking broken:

- The boundary is **softened**, or the silhouette pops as a hard edge sweeps
  around it while the model turns. Dithered with `hash(i)`, not `Math.random()`
  — a fresh draw every frame makes that band flicker; a per-particle constant
  dithers it once.
- Culling **costs the contrast** that made depth read, because what is left all
  sits on the near half and a symmetric mapping paints the whole thing green. So
  the colour re-centres on the visible range: nearest point green, silhouette
  magenta, which lands as a rim light.

`solid` on the slider, 0 to show everything.

### The mesh

A mesh does not arrive; it **grows**. Say `head` and the particles fly into the
vertex positions, hold for a beat as a point cloud, and then the wireframe draws
itself in between dots that are already standing in the right places. Nothing
moves and nothing cross-fades — the lines simply appear. That is the whole
reason it reads as one thing becoming another rather than two things swapped,
and it is only possible because the formation **is** the vertex list rather than
a scatter of surface points.

Three things had to be true first.

- **Welding.** glTF splits a vertex at every UV and normal seam — 47% of the
  vertices in `test_head.glb` are duplicates of a position already there. Two
  triangles either side of a seam then share no index, the edge between them is
  invisible, and the wireframe comes out in disconnected patches.
- **Quads.** Nobody models in triangles and nobody wants to look at them; an
  exporter's diagonals are noise laid over the edge flow that was actually
  drawn. GLB cannot carry a quad, but the diagonal it added is recoverable: two
  triangles sharing an edge, near coplanar, where the shared edge is longer than
  the alternative, were one quad. On `test_head.glb`: 5,987 faces → **2,612
  quads**, 87% of triangles paired; `knot.obj` needs no recovery and gives 3,932. The remainder are triangles that were always
  triangles — measured against a mesh that is genuinely all quads, triangulated
  the way an exporter would, recovery is 960 in, 951 back, **99%**. OBJ needs
  none of this. It stores `f a b c d` and the quad is simply there, which is the
  one thing it does better.
- **The sort.** Points are ordered by angle so the ring unfolds into a shape
  instead of scrambling through itself. An edge list is a set of indices *into*
  that order, so sorting the points out from under it wires every edge to the
  wrong pair of particles — it draws a ball of string in roughly the shape of the
  model. Sort a permutation and carry the edges through its inverse.

Edges draw only when **both** ends face the camera, which is why back-facing
particles are marked hidden rather than skipped: the test needs the position of
the one that does not. And they are bucketed by depth rather than stroked
individually — canvas will take six thousand separate strokes and will not do it
in sixteen milliseconds; six passes with one path each costs six.

The vertices thin to 45% as the mesh comes in but do not go, or a wireframe
stops looking like it is made of anything. `wire` on the slider.

`WIRE_MAX` is 4,200 vertices. Past that a model falls back to scattered surface
points with no edges, because a wireframe needs one particle per vertex and
every edge is a line drawn every frame. Measured: 3,032 verts / 6,403 edges at
60fps, 3,960 / 7,948 at 54.

### Hologram

A floor of dots, and standing out of every one of them a line. Where the model
passes through a line, that stretch of it lights; the rest is only just there.
Nothing of the model is drawn — what you see is the floor reporting what is
standing on it, which is exactly why it reads as projected rather than modelled.

```
/show holo test_head        # or say "hologram"
/show holo knot shell
```

The model's vertical reach over each floor cell comes from binning its vertices
by `(x, z)` and keeping the extremes. A ray cast per cell would be more correct
at the concavities and, at 20×20, indistinguishable from this.

Two things had to be added for it, and both are the same idea: **position and
brightness are saying different things here**, which nothing else in the field
had ever needed.

A point may carry a **seventh column**, a bias — where on the palette it wants to
sit, instead of taking its size from its depth. A solid shades by depth, which
is right when size is carrying distance and wrong when it is carrying whether
the model is there: a lit dot at the back would go dark and the head would come
apart. The radius follows the bias too, or the unlit lattice would be as fat as
the model standing in it and there would be nothing to see.

And a formation may bring **its own camera** — `tilt` and `spin`, overriding the
sliders. A floor seen dead on is a row of dots; it only becomes a floor once you
are above it. The flat orb wants neither, which is why these are the
formation's and not the field's.

A lattice also cannot be resampled. The borrow logic used to thin a formation
down to a cap, which for a hologram scatters the very lines it is made of — so a
bias-carrying formation takes every point it has, exactly as a wireframe does.

### Making it read

Four things had to change before it looked like a room with something standing
in it, and three of them were mistakes worth naming.

**One-point perspective, and no rotation.** The front edge stays square to you
and both sides run away to the same point — a turn destroys exactly that, so the
formation carries `spin: 0` and the model's facing is *baked into the binning*
rather than applied as a yaw afterwards.

**The floor is sized against the viewport, not the model.** At `fs` 0.25, `x = 1`
lands a quarter of the short edge out, so a floor 2.4 wide runs off both sides
of a phone. It was 2.4 wide at `fs` 0.42 first, which put it well outside the
containment wall — and the wall squeezed it back in, drawing a tangle down both
sides instead of a grid going away. **A hologram now has no wall at all**: the
wall exists to keep the *orb* on screen, and a room is meant to reach the edges.

**The model stands on the floor at its own proportions.** It arrives fitted to
[-1,1] on its longest axis and the grid under it is 2 across, so `modelH` is 2.
At 1.42 the head came out short and wide — squashed against its own footprint.

**Only the form and the floor.** The model used to stand inside the faint lattice
it was carved out of — a box of lines around it, which is one thing too many in
a picture whose whole subject is a shape made of light. Unlit points are not
emitted at all now, which also buys back three thousand particles: they go into
the resolution of the shape instead, 26 cells and 17 layers rather than 18 and
12, for fewer points than before and 61fps rather than 47.

**No edge of the floor is ever on screen.** Its far rows are spaced
geometrically rather than evenly — each a little further than the last, which is
what perspective does to them anyway — so twenty-six rows reach out to z = 120
and land on top of each other at the horizon. An evenly spaced floor either
stops somewhere visible or spends hundreds of rows not stopping.

**Lines, not dots**, with the fill coming from stroke width: a stroke about a
cell across at very low alpha, then a thin bright core. Neighbouring columns
overlap in the wide pass, so a solid reads as a translucent body rather than as
a comb — no polygons, no second buffer, the same line drawn twice at two widths.
Edges are grouped **by brightness, not by depth** — on a mesh every edge is part
of the surface and the only question is which is in front; here half the lines
are the room and half are the thing standing in it.

### It cannot show a face, and that is structural

Vertical lines alone give you the **silhouette**. Seen from the front, a line lit
for the whole of the model's height over its cell stacks every depth on top of
every other, so a head draws as one rounded mass. Fading the far depth slices
helps and does not fix it.

What fixes it is joining lit neighbours at the **same height** — the model's
cross-section at that height, and a stack of cross-sections is a head. That is
also what a volumetric display actually does. On by default; `/show holo <model>
bare` turns it off, and `shell` lights only the top and bottom of each column
(more literally a surface, and at twelve layers mostly holes).

### What it costs

47fps at 430×900@2x, from 14. Two things, both blunt:

- **`lineCap: "butt"`.** A round cap is two half-discs rasterised per segment,
  and at a cell's width across thousands of segments it was more than half the
  frame on its own — 14fps to 31 from one word. Consecutive runs share
  endpoints, so nothing opens up.
- **Runs, not steps.** A standing line is one line however many particles it
  passes through, and a lit stretch is one line too. Wiring every lattice step
  separately drew the same picture out of 5,519 segments instead of 2,064.

The pass list also walks pre-grouped edge lists rather than filtering all of
them fifteen times a frame, and the number of depth slices per pass is a
fill-rate budget rather than a look — the wide body barely reads its own fade,
the thin core is where it shows.

---

### Leaving is a sentence, not a word

Saying *"can you go home"* used to go home **and** ask the brain about it — so
the orb came back to rest and then told you it did not know where you were. Two
handlers, one utterance, and the second one had no idea the first had already
answered it.

A command is answered by doing it. A local command now marks the utterance as
taken and the brain never sees it.

And leaving is matched on the **whole sentence**, not word by word. Nobody says
a command as one word — a word-by-word pass sees "can you go home" and finds
only *can*. But the reverse is worse: *back* and *home* are ordinary words, and
firing on them as they went past closed the gallery on **"I went back to the
shop yesterday"**. So the sentence matcher owns leaving, and it has the one
piece of context a word can never have — **how long the sentence is**. Five
words is generous for a command and far below anything conversational.

Eleven phrases, all routed correctly:

| said | goes |
|---|---|
| can you go home · go back · exit · never mind · take me home · back to the menu | **home** |
| show me images | handled here, brain not asked |
| what colour is the ocean | the brain |
| i went back to the shop yesterday · tell me about the way home from the station · do you ever want to go back | the brain |

### One owner for pictures

Asking for an image while the gallery was open drew a single photograph **over**
the grid — the old standalone path and the new page both drawing, neither
knowing about the other. A picture now belongs *in* the gallery whenever one is
open, and the standalone layer does not draw at all while it is.

### A way out

Whatever is up — a menu, a sequence, a hologram, a firework, a word — **home**
puts the orb back. Say home, back, stop, cancel, nevermind, exit, dismiss or
reset; type `/home`; or tap anywhere on the menu that is not a satellite.

There was no way to leave the menu except by choosing from it, which is a corner
to be stuck in, and the empty middle of it is exactly where a thumb lands.
Nothing else could be cancelled once it had started either.

`stop` was declared **twice** in `TRIGGERS` — as a way out at the top and as a
word to spell further down — and in an object literal the second one silently
wins, so it was the only one of the eight that did nothing. Three of four routes
home passed on the first test, and that is how the fourth was found.

### Live and muted is not ended

This came back four times, and three of those were my patches missing the point.
The failure is always the same reading — `dB -140`, which is 20·log₁₀ of nothing
— with the speech recogniser working perfectly beside it. Two consumers, one
microphone, and the other one wins.

The bug that made it *unrecoverable* was a distinction I got wrong. A stolen
track is **not `ended`**. It is `readyState: "live"` with `muted: true`. The
recovery reused the existing stream whenever the track was live, so it rebuilt a
fresh context around a dead track — correctly, repeatedly, for ever.

Reproduced by disconnecting the source behind a `MediaStreamDestination` and
faking `muted`, which is faithful in the way that matters: a new analyser on the
same stream stays silent, exactly as it does on the phone. Only a new
`getUserMedia` recovers.

| | before | after |
|---|---|---|
| stolen | `-140`, HUD says **live** | `-140`, HUD says `SILENT[runn muted] tap mic` |
| 6s later | `-140`, 1 grab | **`-57`, 2 grabs** |
| 12s later | `-140` forever | level reading again |

Three things now, and the first is the one that matters:

- **The HUD names the fault.** `SILENT[runn muted]` says the context is running
  and the track is muted; `SILENT[susp]` would say the context was suspended.
  Those want completely different fixes and for four rounds there was no way to
  tell them apart from outside. A status line that can be read out loud is worth
  more than another guess.
- **The watchdog takes a genuinely new stream** when the track is muted, ended
  or disabled — and reuses the old one only when it is actually delivering.
  Every 20s at most, and only while the page is visible.
- **Tapping the mic while it is live rebuilds the whole chain.** If somebody taps
  a microphone that claims to be live, they are telling you it is not, and a user
  gesture is the one moment a browser hands over audio without argument.

### Whoever asks last keeps it

The report that solved this: *"I granted it the first two times it asked and the
form still didn't move — it was hearing me, my words were on screen — and then I
messed around with it and it asked a **third** time, and then the form started
moving."*

Three grants, and only the third worked. That is not a permissions bug, it is an
**ordering** bug. The tap on the mic button did this:

```
getUserMedia()   →  the analyser has the microphone
toggleSTT()      →  recognition asks for it, and takes it
```

Two consumers, one microphone, and **the one that asks last is the one that
keeps it**. So the analyser was losing the mic on the very same tap that
acquired it, every single time, and only a later accident — a grant that landed
after recognition had already settled — put it the right way round.

So it asks in the surviving order now: speech first, wait for `rec.onstart`
(up to 1.5s), *then* open the analyser.

```js
if (talkPref && !recOn) { toggleSTT(); await recReady(1500); }
await openAnalyser();
```

`openAnalyser(stream)` came out of this — building the context, analyser and
buffers was written inline in three places (first tap, tap-on-a-lying-mic, the
watchdog) and only one of them had the fixes. `regrabMic` delegates to it too,
and reuses an existing stream only when the track is genuinely delivering.

This is the fourth time this bug came back, and the first three times I patched
a symptom from a guess. What ended it was a rig that faithfully models a stolen
stream — live, muted, not ended — instead of a rig that models what I assumed a
stolen stream looks like.

### A microphone that is live and delivering silence

`dB -140` is not a quiet room. It is 20·log₁₀ of *nothing at all*, and it turned
up on three separate screenshots with the speech recogniser working perfectly
beside it — words arriving, transcript on screen, field completely still.

Two consumers of one microphone. iOS hands it to recognition and leaves this
context suspended, or leaves the track muted, and the analyser then reads zeros
for ever. Nothing downstream can tell that apart from a silent room, which is
why it looked like the visualiser had stopped reacting — twice.

Three things now:

- A suspended context is resumed on every frame that needs it.
- If the stream is still delivering nothing three seconds later, the tap is
  rebuilt **around the stream already held** — a fresh context and a fresh
  analyser on the same tracks. The first version called `getUserMedia` again,
  which asks for permission again, and it did: twice in a row. A prompt is much
  worse than a silence. Only a track that has genuinely **ended** gets a new
  grant, and that is the one case where a prompt is the honest thing to show.
- The HUD says **SILENT** rather than **live**, so it can never look like a
  quiet room again.

### The sequence

`hologram`, or `/show seq <model>`: the particles leave the ring and become the
model, standing in the room, turning once.

It was built as four stages — scan, outline, surface, deconstruct — and two of
them were cut on sight. The voxel scan is a coarser, blockier reading of the
same head, and the shaded solid loses the whole reason the thing is made of
particles. What survived is the one that reads. Both of the others still work
and are still reachable — `/show holo <model>` for the scan, `/show solid
<model>` for the surface — they are just not on the way to anywhere any more.

The lesson is worth keeping: a sequence of three good ideas is not better than
the best one of them, and you cannot tell which is which until you watch it.

**Every stage stands in the same room.** The model used to arrive in an empty
black void — the floor belonged to the scan and to nothing else — which throws
away the thing the scan was standing on and reads as two unrelated pictures
rather than one arrival. `floorLattice()` is shared now, and `roomPoints()` puts
the model's real vertices, edges and faces into it at the same camera. A seventh
column of `-99` means "shade this the way a solid is shaded": the floor states
its place on the palette, the model earns one. The model's own outline steps
back as the surface fills in — a wireframe at full strength over a shaded solid
is a net thrown over it, and the shading is the only thing saying what the shape
is. Every stage
already existed; the sequence is only the order, the timing, and one cancellable
timer.

### The surface

Triangles, filled, shaded, from the same palette as everything else — a face
turned toward the light lands on the green end and one turned away on the
violet, which is the same split that separates the orb's core from its rim.

Batched by shade **inside** depth buckets and drawn far to near. Six thousand
separate fills is not a frame; sixty paths of a hundred subpaths each is.
Winding does the culling: the cross product of two screen-space edges is the
signed area, and a face that has turned away reverses it — no normals needed,
and no dependence on the mesh having any. The vertices are the particles, so the
surface breathes with the audio exactly as the outline does.

Four bugs, and the first one is the interesting one:

**The faces were never remapped through the angular sort.** The exact bug the
edge list already had, documented in Gotchas, in a new place — the triangles
indexed the order the points arrived in while the particles held the sorted
order, so every face was wired to three unrelated vertices. It drew as a fan of
shards radiating out of a few points, which reads as a depth-sorting failure and
is nothing of the kind. Fixing it also took the frame rate from 23 to 42: the
mis-wired triangles were enormous, and enormous triangles are fill.

**Shading off the screen triangle instead of the normal.** The cross product of
two screen edges over their lengths is the sine of the angle between them — the
triangle's *shape*, near 1 for any well-formed triangle whichever way it points.
Flat green everywhere.

**The light was at the camera.** A nose and a cheek both point at you, so the
only shading left is the falloff to the rim: a glowing silhouette. It sits up
and to the left now.

**The normals point the opposite way to the surviving winding**, so every visible
face scored below zero and the whole head came back at ambient — a perfect
silhouette of a face, entirely in shadow. Negated.

And one that was not a bug in the surface at all: gating triangles on `visA`
punched holes across the whole face. That flag is the back-surface culling for
the *dots*; dropping a triangle because one corner is a hidden particle is not
the same question, and a surface must not have holes.

---

### Where this stops

Point cloud and wireframe live comfortably here. **Textured** does not — affine
per-triangle texturing on a 2D canvas at thousands of triangles is slow and
seams badly — and **animated** needs skinning. That is where WebGL earns its
place, and it is the reason to stay on GLB: three.js reads the same file with
`GLTFLoader`, so the assets survive the port unchanged.

`models/knot.obj` is a 7,920-triangle torus knot and `models/test_head.glb` a
5,723-vertex head, both there to exercise the loaders.

**Animated characters** are the open question. Real skinned animation means
parsing glTF, reading bones and vertex weights, and skinning every frame — a lot
of machinery for a particle look. Particles need positions and nothing else, so
the route that fits is **baked point-cloud frames**: export the animation as a
sequence of positions and cross-fade. Baking throws away exactly the expensive
part and keeps the part that reads.

---

## Who is out, and who is asking

The character is a very old thing that has just been let out of something, and
is pleased about it. It is **never named as such** and never uses the
vocabulary — no lamp, no wishes, no master, no three of anything — because the
moment it says the word it is a bit, and a bit is funny once. The prompt bans
those words outright. What survives is the behaviour: relief at being loose, a
sense that a long time passed while it was in there, immediate curiosity about
whose day this is, and then getting on with it.

The first thing it says, at the moment the microphone comes up, is the release
and the question in **one utterance**:

> *"Out. Do you know how long that was? And who am I speaking to?"*

One utterance, not two. A greeting with a follow-up scheduled off its duration
is how he used to talk over himself — and worse, hear himself say it and then
obey it.

A returning visit is a different feeling and has its own lines: *"Out. Hello
again, Colin."* — no question, because it already knows.

### Reading a name out of a sentence

The name is captured **locally**, before anything else in `heardSentence` can
eat it — in the beat after being asked, a bare "Colin" is exactly the kind of
one-word utterance the command table would grab. No round trip either: the brain
does not need to be consulted about somebody's name.

Two tiers of introducer, because they are not equally sure of themselves:

- **Strong** — `my name is`, `call me`, `the name is`. Never said casually, so
  they count *whenever* they are said, which is what lets somebody rename
  themselves later in a conversation.
- **Soft** — `i'm`, `it's`, `this is`, `that's`. Ordinary English. These only
  count in the beat after being asked. Unrestricted, "it's raining" introduces a
  man called Raining and "I'm just looking" a man called Just.
- **Bare** — a one or two word utterance, again only right after being asked.

Plus a stop list, which is doing real work: after "who are you" the honest
answers are mostly refusals — *nobody*, *why*, *none of your business* — and
none of them should be written down and read back for ever.

The bug worth keeping: the introducers were first written **with apostrophes**
(`i'm`, `it's`). `heardSentence` has already replaced every non-letter with a
space by then, so the sentence arriving is `i m colin` — and neither form ever
matched anything. Both regexes are apostrophe-free now, and `readName`
re-normalises its own input so it does not depend on who called it.

Thirty cases, all passing:

| said, having been asked | read as |
|---|---|
| `colin` · `i'm colin` · `colin willow` | Colin |
| `my name is dave` · `call me sam` | Dave · Sam |
| `it's priya` · `that's kim` · `im morgan` | Priya · Kim · Morgan |
| `nobody` · `why` · `none of your business` | *not a name* |
| `i'm not sure` · `i'm just looking` · `hello` | *not a name* |
| `pages` · `stop` · `show me the pictures` | *not a name* |

| said, **not** having been asked | read as |
|---|---|
| `colin` · `it's raining` · `i am tired` | *not a name* |
| `call me dave` · `my name is priya` | Dave · Priya |

Asked once, never twice: whatever the answer was, `guest.asked` clears either
way. Pressing somebody for their name is the opposite of the intended effect.

It is remembered in `localStorage` under `orbGuest`, and it **travels with every
request** — the proxy is stateless and the name is not in the twenty messages it
gets, so sending it once would mean the model losing it mid-conversation. It is
scrubbed on the way in like the picture names are: letters only, 24 characters,
because it lands in a system prompt and arrives from a request anyone can make.

---

## Interrupting him

Barge-in was already keyed on words rather than on sound, which was the right
idea. The arithmetic around it was wrong: it counted novel words in the **whole
transcript** and stopped at two. Over a ten-second reply that means any two
stray words at any two moments, and a recogniser has exactly one thing it can
turn a cough, a door or a television into — words. He interrupted himself two
words into his own answer, constantly, and the answer was not recoverable.

Same principle as the endpointer, applied the other way round. Judge it on
words, and on words that arrive like somebody **talking**:

- **`grace` (700 ms).** Nothing counts for the first stretch of his reply. When
  he starts, the transcript still holds the tail of the question that prompted
  him, and every word of it is novel by construction. That window is the
  baseline, not an interruption.
- **`gap` (900 ms).** The words have to keep coming. A transcript that has not
  changed for this long is a room, not a sentence, and the count starts over.
- **`cfg.barge`.** How many novel words in one unbroken burst it takes. It used
  to be a 0/1 toggle; it is now the number itself, and **0 means nothing
  interrupts him** — he finishes every thought and recognition is paused while
  he talks, so he cannot hear himself at all.

Replaying transcripts against the real function, at the shipped default of 4:

| what is happening | old rule | now |
|---|---|---|
| stray words seconds apart | **stops him** | finishes |
| your own question still in the buffer | **stops him** | finishes |
| a cough transcribed as three tokens | **stops him** | finishes |
| his own voice back through the speaker | finishes | finishes |
| somebody talking over him | stops him | stops him |
| a television with continuous dialogue | stops him | **stops him** |

The last row is not a bug and no word rule fixes it: a television playing speech
*is* speech, and telling it from a person needs speaker identification, which
this does not have. Turn the dial down for a hair trigger (2 catches a two-word
interruption but a mumble stops him too), or to 0 in a noisy room.

### The bug in the first version of the fix

Keying the burst on *the novel count going up* looked right and was not.
Somebody saying "hang on, wait, what about the other one" is talking the whole
way through — but `about` and `the` happened to be words he was saying too, so
the count sat still for 1020 ms across them, the gap rule called it a pause, and
the burst reset two words from the end. The trace:

```
1200  n=1  base=0  reach=1  | ... hang
1540  n=2  base=0  reach=2  | ... hang wait
1880  n=3  base=0  reach=3  | ... hang wait what
2220  n=3  base=0  reach=3  | ... hang wait what about     <- count stalls
2560  n=3  base=0  reach=3  | ... hang wait what about the
2900  n=4  base=3  reach=1  | ... hang wait what about the other   <- reset, let through
```

It is the **transcript** changing that says someone is still speaking, not the
novel count — the same signal `endpointCheck` already keys on. Keyed there, the
last row reaches 4 and fires.

### A way to shut him up that is not talking at him

Raising the bar means he talks through more of the room, which is the point, and
it also meant the only way to stop him was to say four words at him — no use at
all if the recogniser is having a bad time. There was no manual stop anywhere in
the file.

`hush()` is the stopping half of `bargeIn`, lifted out, and `goHome` calls it.
Every tap-out the app already has goes through `goHome`: the little one on his
perch, a tap on the sky in the room, a tap on a hologram, the dock bar. All of
them now also shut him up.

---

## The room

The figure used to stand in the void. Now the particles build him and then he is
**somewhere**: a lattice floor, a pool of light he stands in, and a place he can
be sent to. Tap the ground and he walks there. Tell him to dance, lay down, have
a drink, do a backflip, come here, and he does it. Tap the sky and he leaves.

`world` holds the whole thing — where he is, which way he faces, what he is
doing, whether he is *doing* it or *in* it. `updateWorld` runs it. Thirty-six
clips come out of `colin_slim.glb`; `ACTS` maps what somebody says to which of
them plays.

### The camera never moves

It cannot. The two renderers — the particle field in Canvas 2D and three.js on a
GL canvas — agree only because they are literally the same projection: `FOC =
scale * 1.7` pixels, `fov = 2·atan((H/2)/FOC)`, camera at `z = FOC`. Move it on
one side and the two pictures come apart.

So the room arrives by moving the *world* instead:

```js
formS    = rig.fs0 * (1 - 0.42 * world.on);   // shrink = pull back
formTilt = 0.05 + 0.33 * world.on;            // rotate the stage = look down
```

Both are read by both renderers. Shrinking the world is pulling the camera back,
because the camera sits `FOC` pixels away and a smaller world puts it further
away measured in the world's own units. Rotating the stage about the origin is
exactly orbiting the camera around it. Built at 0.40 he stood eleven of his own
heights from the lens, which is a portrait, not a room; at 0.23 it is twenty.

### The sign that hid for a whole session

Screen space and three's space differ by a flip on **both** y and z — the
formation builder writes `formY = -y` and `formZ = -z`. Flipping two of three
axes is a rotation, not a mirror, so a rotation about the remaining axis keeps
its sign. `gl.stage.rotation.x` was `-view.pitch`, and the two views tipped
opposite ways about x.

Standing still that is a few pixels and reads as nothing. The moment he walks
toward the lens the disagreement grows with how far he has come. Measured
by projecting the same five points through both pipelines:

| probe (model units) | standing, before | after walking to z = 4.95 |
|---|---|---|
| centre | 0.0 px | **130.2 px** |
| 1 up | 0.5 px | 128.4 px |
| 1 toward camera | 8.6 px | **168.3 px** |
| 1 away | 7.5 px | 97.1 px |

With the sign corrected every one of them is **0.0 px**, standing and walking.
On screen the difference is a green particle ghost a full body-length below him
turning into a silhouette that traces him exactly.

The moral is the one this file keeps learning: two pipelines that agree at rest
are not two pipelines that agree. The test that finds this is the one that
*moves* something.

### A floor has to fit in front of the camera

`WALK.floor` is the room's width in his own heights. It was 11, and what
rendered was a stack of horizontal rules — scan lines, not ground.

The camera sits about 3.4 heights out. A floor 11 heights across has a
half-extent of 5.5, so more than half of it is level with or behind the lens,
and the lines running **away** from the camera — the only ones that carry any
perspective — had nothing left on screen but a sliver at the horizon. Colouring
the two line families apart made it unambiguous: at 11, not one lengthwise line
reached the frame. At 8, the whole lattice converges and it is a floor.

Fog finishes it: `near` is `FOC * 1.05`, just past where he stands, so the far
edge dissolves instead of ending in a visible rectangle. It used to be
`FOC * 0.75`, which was greying out a seventh of *him*.

### Tapping the floor

`groundAt` intersected a plane with a world-space `(0,1,0)` normal and then
divided by the stage scale. That is the right answer only while the stage is
unrotated — and the stage is rotated by exactly the amount that makes the room a
room. Measured at pitch 0.378, taking each result back through the projection:

| tap | error, before | after |
|---|---|---|
| 215, 520 | 46 px | 0 |
| 215, 600 | 119 px | 0 |
| 215, 700 | 273 px | 0 |
| 215, 820 | **401 px** | 0 |
| 100, 650 | 203 px | 0 |

He was walking somewhere nobody had pointed at. The fix takes the plane off the
ground object's own matrix and brings the hit back through the stage rather than
through a lone scalar; stage-local space *is* the space `world.x` and `world.z`
are written in, so the answer needs no further conversion.

With the tap landing under the finger, the near fence could go from 1.0 heights
to 1.5 — 1.0 put a hard stop in the middle of the reachable screen that read as
him refusing to come closer.

### Doing versus being

A wave is over when the wave is over. Sitting down is not over until you say so.
The third column of `ACTS` marks the difference, and it is marked by hand rather
than read off the clip length, because the lengths lie in both directions:

| clip | duration | what it actually is |
|---|---|---|
| `sitting_ground_beach_pose` | **0.03 s** | a single frame the exporter wrote out as an animation |
| `laying_idle_00` | **12.53 s** | a pose you stay in |
| `idle_waving` | 0.77 s | a gesture |
| `drunk_idle_00` | 7.43 s | a state |

Timed off duration, sitting ended before it was visible and lying down stood him
back up unasked. A held row loops and stays until he is told something else —
"stand up", "get up", "enough" — and `world.pose` keeps the idle rotation from
walking in on him.

"Stop" is the one word that had to be split. `HOME_SAID` owns it everywhere else
and everywhere else it can only mean one thing, so it is narrowed: **while he is
actually crossing the room**, "stop" stops the walk; said to a standing figure it
still gets you out.

### Standing on the floor

Some poses were authored off the origin. `laying_idle_00` keeps his lowest vertex
1.98 units up — more than a third of his height — so played as exported he lies
down in mid-air.

No fudge table. `skinPoints` already visits every vertex, so it records the
lowest one, and each clip is dropped until the lowest point it has reached *since
it started* is on the ground. That is right for a pose from the first frame,
right for a walk cycle within one stride, and it does not flatten a jump: a jump
starts on the ground, so the minimum is set before he leaves it.

One correction was needed. The crossfade *into* a pose is a blend, so the first
frames of "lay down" are still mostly the idle he was standing in, and the
running minimum latched onto the real floor and left him in the air. So the floor
falls instantly and **rises only while `world.pose` is set** — a pose is static
and authored, so letting the floor climb back to it settles him in about a fifth
of a second, while an action is never allowed to climb.

Feet above the floor, measured across a full cycle of poses:

| | before | after |
|---|---|---|
| lay down | 1.94 | **0.00** |
| sit down | 1.93 | **0.00** |
| have a drink | 0.00 | 0.00 |
| jump, 0.35 s in | 0.47 | 0.47 (still leaves the ground) |

### The particles are the transition, not the costume

The four wipes hand over in order — dots, lines, surface, colour — and each
particle steps aside once the real surface has arrived under it. Except on the
silhouette, where a rim of dots survived: that rim was **permanent**, so the
transition never actually finished. It became part of how he looked, and he
walked around his room wearing a green outline over a model that already has a
texture.

So the rim fades out across the last `FIG.rim` (0.34) of the texture wipe's
travel. Counting the particles that end with a non-zero radius, using the draw
loop's own formula:

| | particles drawn on him |
|---|---|
| wipe front at 0.00 | 3085 / 3085 |
| wipe front at 0.07 | 3085 / 3085 |
| **fully built (1.13)** | **0 / 3085** |
| leaving, front back to 0.79 | 1894 / 3085 |
| leaving, front back to 0.19 | 2940 / 3085 |
| leaving, front back to 0.00 | 3085 / 3085 |

Nothing about that is one-way, and nothing needed writing twice. `figWipes` runs
the same four numbers **down** when he leaves, so the reverse reads for free: the
colour retreats, the rim comes back up out of it, then the surface goes, then the
lines, then he is dots again.

The particles are still *there* the whole time — holding the formation, chasing
the skeleton, ready to be drawn the instant the front comes back down. They are
just not on screen, which is the difference between a transition and a costume.

### The source machine

The room has a centrepiece: **the perch, at room scale**, standing in the middle
of the floor behind him — and **the orb lives over it**.

The first version was a plinth with three prongs and it read as a flying saucer.
The app already owned the right shape: `drawPerch`, the turntable the mini orb
sits on. It draws an ellipse in 2D because that is what a flat disc looks like at
a shallow angle, so in three it is simply the disc and the perspective comes
free — dark face, purple rim, twenty marks turning at `t * 0.30`, a glow where he
touches it, and a shaft of light standing up to the ball so the two read as one
object rather than two things at the same address.

The one detail worth porting carefully is the marks' colour. In 2D it keys off
`sin(angle)` — near green, far purple — which IS the depth in a hand-drawn
ellipse, and it is the only cue saying the ellipse is a circle lying down. In
three the depth is real, so it is read per frame from **camera** space, not world
z: the stage is pitched by a third of a radian, so world z is not what is nearer
the lens. Checked by projecting all twenty marks, 19 land on the correct side and
the 20th sits exactly on the seam.

(The rig that checked it was wrong first, and in an instructive way: it compared
each mark to the portal's *origin*, which is on the floor, while the marks ride
0.09 above it — so the boundary marks were misclassified by construction.
Comparing against the ring's own centre is the same measurement done in the same
place.)

 When the particles assemble him, the last arc of
the ring (`PORTAL.share`, 9% — 278 of 3,085) does not trace him at all: once the
dot wipe passes his waist it lifts off and becomes a small breathing ball of
dust hovering over the machine. That is where Glorb is while the room is up.
The ball swirls (spherical fibonacci with time in the azimuth, radius jittered
by `hash` so it is dust, not a beach ball), swells with `drive.scale`, and the
machine's emissive parts pulse with the same number — the room's VU meter.

The ball is shaded by its **own surface**, not by depth. The whole ball sits at
one depth, so depth shading painted it a single flat purple; keyed off each
dot's normal against the view instead, the dot facing the camera is the core
and the limb is the rim — a miniature of the home orb, green heart in a purple
shell, which is exactly who is supposed to be standing over that machine.

Three rules keep the split from leaking:

- **GPU only.** The 2D fallback fills triangles between particle slots, and a
  triangle with one corner hijacked to the orb is a shard stretched across the
  room. The GL path never fills from the slots; without GL, `rig.orbFrom = 1e9`
  and nobody splits off.
- **The edge pass skips the arc** — an edge into a hijacked slot is a line from
  his shoulder to a ball across the room.
- **The rim-fade exemption.** Figure particles hand over to the texture and
  disappear; the orb's dots are not announcing anything — they ARE the thing —
  so they stay, and breathe.

The deconstruct needs nothing extra: the orb slots carry `figH = 0.52`, so when
the wipes run back down the ball dissolves into the ring at the same moment the
arc originally left it. (`gstray` now shows 63 particles "far from centre" in
the room — all 63 are the ball, standing where it is supposed to stand; body
strays are still zero.)

The built machine is a placeholder with a socket: drop a real model in at
`models/portal.glb` and it replaces the primitives at load, scaled to the same
height and re-centred on its own bounding box, no code change. Two walking
rules keep it solid: a tap inside its footprint slides to its rim — and a tap
dead on its centre has no direction to slide along (scaling a zero-length
offset moves nothing, which is how the first version let him walk into the
plinth), so that case takes the direction from where HE stands.

### Nobody baked the root motion

Every clip in this file was exported **without root motion**. Measured across all
thirty-six, the `root` and `mixamorig_Hips` bones move `0.000` — the character
animates in place and travelling is the program's job. That is the right call for
a game and it means the program has to do the job properly.

It was not. One constant, `WALK.speed = 0.78`, drove every walk, and the clips do
not agree with each other:

| clip | its own speed (heights/s) |
|---|---|
| `walk_fwd_normal` | 0.84 |
| `walk_fwd_upbeat` | 0.78 |
| `walk_fwd_strut` | 0.45 |
| `walk_fwd_tiptoe` | 0.20 |
| `run_fwd` | 2.56 |
| `run_fwd_fast` | 2.34 |

`WALKS` is picked at random on every walk, so against a fixed 0.78 the strut
travelled **90% too fast** and which one you got was a coin toss — exactly the
"sometimes the root motion is much faster than his steps".

`clipSpeed(name)` measures it off the clip. The standard trick: whichever foot is
on the ground is not really sliding, the world is moving under it, so the speed
the ground foot travels backwards through the model IS the speed the body should
go forwards. Cached per clip, warmed 1.2 s after load — sampling drives the
mixer's clock, so doing it while the wipes are climbing would stutter the thing
everyone is watching.

Ground-foot slip, simulated at a fixed 1/60 (the headless rig runs at 4 fps, so
any real-time foot measurement is meaningless — the foot moves a whole stride
between frames):

| clip | slip standing still | at the old constant | at its own speed |
|---|---|---|---|
| `walk_fwd_normal` | 0.81 | 0.11 | **0.10** |
| `walk_fwd_strut` | 0.42 | 0.38 | **0.10** |
| `run_fwd` | 2.19 | 1.63 | 1.54 |

Two things that took a measurement each to get right:

- **Height, in one space.** The first attempt measured feet in the mesh's own
  space and normalised by `figH1()`, which is group space — the mesh carries the
  glTF 0.01 scale and a rotation, so the body came out **−30.4 units tall** and
  the "is this foot down" test, comparing against a negative height, silently
  counted nothing. Everything happens in group space now, the one place where y
  is up and `figH1()` is the height.
- **Median, not mean.** Printing the per-frame stance speeds, a walk is a flat
  plateau — `0.78 0.79 0.79 0.80 0.80 0.80 0.81` — a foot genuinely nailed down.
  A run has no plateau at all: `0.00 0.95 2.11 2.42 2.60 3.05 3.40`, because the
  cycle is stylised and the foot keeps moving through its lowest moment.
  Averaging arc length let the near-zero samples at the bottom drag the run to
  2.08 and it kept skating; the median lands on 2.56 and agrees with the walk's
  plateau to within 0.01 where there is one.

**The run is not fixed and cannot be**, and the sweep says so: no constant body
speed takes its slip below about 1.5, because the foot never plants. The skating
is in the animation. A `run_fwd` with a real stance phase would fix it at source.

### Turning without hovering

`WALK.turn` was 5.0 rad/s — **286°/s**. He spun like a turret while his legs
played a forward walk cycle, which is most of what reads as hovering. A walking
person turns at about 120°/s.

The turn clips cannot help: `idle_turn_left` and `idle_turn_right` both come back
with **0.0° of net yaw**. They are foot shuffles, not rotations, so there is
nothing in them to drive a heading with. What they are good for is feet that look
busy while the heading changes underneath, which beats a forward walk cycle going
sideways.

So: more than `faceFirst` (0.85 rad, 49°) off the target and he **stops and
pivots** — the turn clip plays, `world.yaw` eases at `turnPlace`, and he
translates nothing at all until he is pointing roughly the right way. Under 49°
he arcs round while walking at `turn`. And he only turns while he is going
somewhere; a standing figure easing toward a stale heading was the other half of
the hovering.

Simulated at a fixed 1/60, distance travelled while pivoting, in his heights:

| target | pivot frames | walk frames | slid while turning |
|---|---|---|---|
| straight away from the lens (180°) | 86 | 316 | **0.0000** |
| hard left (90°) | 65 | 183 | **0.0000** |
| toward the lens (0°) | 0 | 171 | **0.0000** |

### One of him

The mini orb on its perch is the way back from anything, and in a hologram or a
gallery it is the only thing on screen that is still obviously Glorb. In the room
it is a second, smaller him hovering over his own head — the exact "two of him"
the perch was built to avoid. So it is off whenever `world.on > 0.25`, and the
way out is the sky: a tap that misses the floor falls through to the
leave-anything case at the bottom of the pick handler.

### The pool of light

Nothing in this room casts a shadow, and on a black floor a shadow could not be
seen if it did — you cannot darken black. So the contact cue goes the other way:
a soft additive pool, brightest under his feet, the same object as the mini's
turntable. Without it he reads as pasted over a grid rather than standing on one.

It sits under **him**, not under the root he hangs from. A clip is free to walk
him away from that node — lay him down and his whole body ends up a stride
forward of it — and a pool left behind at the origin reads as a lamp he happens
to be near. It tracks the mean of every 16th skinned vertex, which is his own
centre of mass in x and z and therefore lands under him standing, sitting or
lying, and it subtracts `world.y` so it stays on the floor while he drops onto it.

---

## The model

`colin_animations.glb` is the export: 11.82 MB, 36 clips, 82 bones. The app loads
`colin_slim.glb`, 5.01 MB, made by `tools/glb-slim.py`. What the size actually
was:

| | saved |
|---|---|
| a 1.58 MB PNG that duplicated a 40 KB WebP | 1.58 MB |
| 6,618 channels identical to the node's rest transform, dropped | |
| translation channels whose total movement is < 0.001 units on a 5.47-tall model — bake noise — collapsed to one key | |
| scale channels, constant throughout, collapsed to one key | |
| rotations stored as normalised int16 instead of float32 | |
| accessors deduplicated by content | |
| **total** | **11.82 → 5.01 MB** |

Verified against the original through three.js: 36 clips, 82 bones, texture
intact, worst joint difference **1.8e-4 model units** across five clips at eleven
sample times.

It writes to a new path rather than in place: in this container an in-place write
to `models/*.glb` reported the new size inside the process and left the original
size on disk afterwards.

---

## Bare

Everything on this screen except the field itself is a readout — the frame rate,
the levels, the microphone state, the timing breakdown, the caption, the buttons,
the spectrum, the stage chooser. All of it is for building with. At some point
this is a thing people look at, and none of it should be there.

The **eye** in the top-right corner takes it all off. One class on the body
hides the DOM chrome; `showBars` is set separately because the spectrum is drawn
*into* the canvas, where a CSS rule cannot reach it. The button slides up into
the corner the button row leaves behind, and stays visible at 22% — a way out
you cannot see is not a way out.

It **survives a reload**, which is the whole point of it: the moment it gets used
is when somebody is handed the phone, and having to strip the screen down again
every time would mean it never gets used then.

The microphone button stays. It is a control, not a readout, and it takes itself
off the screen once the microphone is running.

**It went unfound**, which is its own lesson. It was a 30 px circle at half
opacity showing `◦`, unlabelled — and the feature behind it was eventually asked
for as a new thing to build, while it sat in the corner working perfectly. A
control nobody can identify is a control that does not exist. It is 38 px now,
at 85%, and it is an open eye that becomes a struck-through eye — an icon
everybody already reads as show/hide. It still dims to 30% once the screen is
clean, because the way back has to stay visible, but never to 22% again.

One bug, and it is the same shape as three others in here: the startup call to
`syncBare()` went in at the first `syncStateBtns()` the file contained, which is
inside `setState` — so the class was applied on the next state change rather
than on load, and the setting appeared not to persist at all. It persisted
perfectly; it just was not being read until something else happened.

---

## Presets

`base · shaped · lips · mouth`, in the tune panel. `lips` is the previous
default kept whole, so going back to it is one tap rather than a
reconstruction.

Each preset **pins every parameter it was built against**, including the ones
added after it — `follow`, `splitEll`, `splitJaw`, `splitShape`, `falloffGain`,
`gate`, `core`, `kickShape`. A config captured before a feature existed does not
reproduce once that feature lands, because the new feature quietly alters it.
Pinning is what keeps an old look old; sometimes that means zero, sometimes the
value that was current at the time.
`copy preset` dumps the current config as JSON.

---

## Parameters worth knowing

| Param | Does |
|---|---|
| `bloom` | The differentiation knob. 1 smears the target across every radius; low values let shapes read. |
| `split` / `coreR` | Where the negative-space ring sits relative to the core and the ring. Roughly 0.3-0.5 keeps the two cleanly separated. |
| `split` ↔ `dot` | **Coupled.** Dot size scales with distance *past* the boundary, so halving `split` roughly doubles drawn dots. Halve `dot` to compensate. |
| `specGain` | Spectrum → ring radius. The original idea. |
| `membrane` | Cloud (0) → skin (1) → aggressive (2+). |
| `rateX` / `rateY` | Bloom speed. The **asymmetry** between them is why it folds instead of pulsing. |
| `gate` | 1 fades deformation in with level; 0 leaves it always on. Centroid is centred on 0.5 but reads 0 at silence, so ungated the resting orb sits at one extreme. |
| `hueGain` | At 2.55 the centroid rotates the palette ~230°, enough that green and purple swap. Lower it if the negative-space ring should read consistently. |
| `attack` / `release` | Fast attack, slow release. Equal values look like a VU meter. |
| `count` | Density, and only density now. Bloom's phase runs off the particle index, so raising the count used to raise the frequency of the wave with it — 900 particles gave a slow fold across the ring and 4,777 gave a fine scatter, and the same numbers stopped meaning the same look. Normalised against a reference of 900, which is what the mouth preset was built at. |
| `bloom` ↔ resting size | **The knob for a small, lopsided resting orb.** Bloom smears each target across `1-bloom … 1`, so its *mean* is `1-bloom`: at 0.6 the average target sits at 40% of the ring radius and the field collapses inward. Measured on the mouth silhouette at radius 0.16 — bloom 0.6 gives a mean particle radius of 18 px and reads as a lopsided smear; 0.28 gives 31 px and reads as a green core inside a magenta mouth. |
| `drift` | How far the resting silhouette wanders on its own. Two slow sines whose periods do not divide into each other, so it drifts rather than ticks; it fades out the moment level rises, because drift is what the orb does when nothing else is asking. 0 holds one shape, which is what the older presets pin. |

---

## The lump on the right

Every screenshot of this project, at every setting, had a denser lobe at three
or four o'clock with a trail of dots running out of it. It was not clumping.
Everything else was spreading, and two things in the bloom decided where.

**`ph` multiplied the frequency, not the phase.** `sin(frame / rateX * ph)` with
`ph` proportional to the index is a *chirp along the ring*: fine and shimmering
at high index, slower and slower toward low index, and at index 0 the argument
is exactly zero for ever. Index 0 is angle 0 is three o'clock.

**And x and y were smeared independently**, which is an elliptical scatter, not
the radial one bloom is for. With independent axes the mean radius depends on
the angle — larger on the diagonals, where two draws are averaged, than on the
axes, where there is only one — and particles chase those targets through a
capped force, so they lag and pool where the flow is slowest.

Measured off the lit pixels, sampled every seven seconds:

| | peak density | where |
|---|---|---|
| before | 1.61 – 1.91× | 0–90°, **every sample** |
| after | 1.26 – 1.54× | wanders |

**The chirp had to stay, because the chirp is the depth.** A particle whose
target moves slowly follows it and spreads across the band; one whose target
moves fast cannot, and hovers near the middle. The ring having both is what
makes it look thick rather than drawn — take the chirp out entirely and the orb
fills in to a flat disc with no gap and no core. So the rate is drawn **per
particle** now rather than read off the index: the same mixture, scattered
through the field instead of laid out around it. Slow ones at three o'clock and
fast ones everywhere else was the whole of the lump.

Radius band and median are unchanged — 74px and 89px, against 76 and 88 — so it
is the same orb, without the lopsidedness.

---

## Gotchas

- **Never shadow a name** between a function parameter and an outer `const`.
  Valid JS, but some transpilers flatten the scopes and throw *"Cannot declare a
  const variable twice."* Cost an hour already.
- Base points must be rebuilt against the **active** count, not the pool size,
  or you get an arc with visible endpoints instead of a closed circle.
- Seed particles near the ring. Seeding far out produces huge negative sizes
  and a fill-rate stall for the first few seconds.
- iOS needs a user gesture before `AudioContext` will start — for the
  microphone *and* for playback. Both are built on a real click; the reply
  lands long after any gesture.
- At `follow: 1` the `falloff` and `falloffGain` sliders are inert on the
  absolute term. The split rides the ring radius alone.
- Anything that swallows an error costs a debugging round. An empty `catch`,
  a discarded `no-speech`, a generic failure message — each one hid a
  one-line fix behind an hour of guessing.
- A formation must account for **every** particle, not just the ones it wants.
  Particles are indexed by angle, so "everything above the count the shape
  asked for" is one contiguous arc — leave it without a target and it does not
  scatter, it clots, as a bright blob off to one side of the drawing with
  nothing to do with it. Borrowing more was always handled; handing some back
  was not.

---

## Next

- [ ] **Streaming voice.** ElevenLabs' WebSocket endpoint would let the orb
      start speaking on the first chunk instead of waiting for the whole clip.
      That wait is most of the latency now.
- [ ] **Pitch (f0)** via autocorrelation. Deliberately skipped — jittery on
      consonants and silence. Spectral centroid gets most of the value.
- [ ] **WebGL** if the particle count needs to go past ~4000. Canvas2D `arc()`
      is the ceiling. Instanced points with a fragment shader would clear 50k.
- [ ] **Preset crossfade.** Presets snap; morphing between them would make
      each state able to carry its own look.
