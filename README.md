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

The API keys live in the Worker, never in the page — this is served from GitHub
Pages, so anything in `index.html` is public and a leaked key is billable. The
page only ever learns the Worker's URL, which it keeps in `localStorage`.
Setup is in [`worker/README.md`](worker/README.md).

Recognition is deafened while the orb talks, or it hears itself through the
speaker and answers its own reply forever. `abort()` rather than `stop()`,
because `stop()` finalises whatever is pending — which at that moment is the
orb's own words. `echoTail` covers how long the room keeps ringing afterwards.

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
| duet | every word spelled as it lands | out loud **and** shown |

`duet` is the default. Echo was built as a way to watch recognition work with
the brain out of the way; duet is the same drawing put back on top of a real
conversation, so a question is answered in both directions at once. Ask it its
name and it says "I'm Orb" while the field spells ORB.

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
| `fireworks` | five in sequence | peony, nova, valentine, pinwheel, willow |
| `finale` | seven in sequence | opens on the shock |

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

## Presets

`base · shaped · mouth`, in the tune panel.

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
| `count` | Not just density — it sets the top of the index range, so it changes the wave's character. |
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
