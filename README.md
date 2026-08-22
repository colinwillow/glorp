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

## Shells

A celebration is not a picture of a firework, it is one. Nothing is drawn: the
field is thrown outward and the pattern is whatever the launch geometry and the
decay make of it, which is why `congratulations` and `boom` do not look alike.

| word | shell | what it does |
| --- | --- | --- |
| `congratulations` `congrats` `yay` `woohoo` `bravo` | peony | gold, a filled ball with radial streaks |
| `celebrate` | ring | cyan, every star at one speed so it opens as a clean expanding circle |
| `birthday` | willow | orange, slow and heavy, long drooping arcs that hang and fall |
| `party` | palm | green, seven thick fingers instead of a cloud |
| `boom` `blast` | shock | hot pink, one enormous fast shockwave, brief |
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
| `valentine` | a heart, hot pink |
| `nova` | a five-pointed star, violet |
| `pinwheel` | a ring given tangential speed, so it opens turning |
| `prism` | a triangle, indigo |
| `frame` | a square, cyan — opens hollow, with an X of slow stars in the middle |
| `spokes` | sixteen needle-thin rays, orange |
| `crown` | eight rays given a slight turn, lime |

How hard to exaggerate a figure is per-shell (`formPow`), because it depends on
the figure. A heart spans 0.66 to 1.39 and needs a little. A square spans corner
to edge by only 1.41, which after normalising is nearly nothing — at the heart's
setting it came out as a round green mass. A polygon needs its corners
exaggerated into points before a field of dots reads it as having corners.

The straight-edged ones run almost no gravity and very little drag, because an
outline only survives as long as nothing is pulling parts of it around.

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

## Menu

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

### The sequence

What a character arriving is supposed to be, and it is all one command —
`hologram`, or `/show seq <model>`:

1. the particles gather into a **scan** on the floor
2. the scan resolves into an **outline** — a different point set, so they
   genuinely fly between the two, which *is* the transition
3. the **surface** fills in behind the outline and turns once
4. it drains back out to the outline, and the outline back to the orb

Stages 3 and 4 are the same point set with the fill easing over it, which is why
those read as one object changing rather than two objects swapping. Every stage
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
