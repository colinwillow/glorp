# Orb

Audio-reactive particle field. Single file, no build step, no dependencies.
Descendant of the old p5 `Okay` sketch — same steering behaviours, rewritten
without per-frame allocation.

Open `index.html` over HTTPS. `getUserMedia` will not run from `file://`.

---

## Architecture

Three layers. They only talk in one direction.

```
  microphone ──► analyse() ──► drive ──► loop() ──► canvas
                              (struct)   physics
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

**Audio never touches physics.** It writes these five numbers; physics only
reads them. That is the seam that makes the Jarvis states cheap later — a
scripted animator writes the same struct for "thinking" and "speaking" and
the visual system doesn't change at all. Keep this boundary intact.

### Physics, per particle per step

Four forces, summed into acceleration:

1. **arrive** — steer toward a target, slowing inside 100px
   ```js
   ringR = baseR * (1 + drive.scale*rmsGain)
         + drive.spectrum[band] * baseR * specGain
   target = centre + basePoint[i] * ringR * sin(frame * i / rateX)
   ```
   `basePoint[i]` is a unit circle point. Multiplying it by an index-rated
   sine is the bloom — every particle inflates and inverts on its own clock,
   which is what makes it ooze rather than pulse.

   The band index comes from the particle's **index**, so bass and treble
   occupy fixed arcs of the circumference. The spectrum carves the silhouette.

2. **membrane** — signed radial force toward the ring surface, sampled at the
   particle's **current angle** (not its index). Outward when inside, inward
   when outside. This is what makes it read as a skin rather than a cloud.

3. **turbulence** — random jitter scaled by `drive.turbulence`. Sibilants
   shatter the surface; vowels leave it smooth.

4. **flee** — steer away from the pointer inside `fleeRadius`.

`drive.impulse` is not a fifth force. It's an outward radial kick that lives
**inside the membrane branch** — so it only fires when `membrane > 0.001`.
Physically that's right (no skin, nothing to snap), but the sliders don't show
the coupling: dropping `membrane` to 0 silently kills onset response too.

### Rendering

- `size = (1 - dist/falloff) * sizeHi`, deliberately allowed to go **negative**
  past `falloff`. `Math.abs()` makes distant particles large again, and the
  colour formula clamps the green channel to zero when size is negative.
  **That sign flip is where the purple comes from.** It was an accident in the
  original and it's load-bearing now.
- Colour is a function of size only, so it's precomputed into a 96-entry LUT
  instead of building a string per particle. The LUT is only rebuilt when the
  rounded hue shift actually changes (`if (shift !== lastShift)`), so steady
  audio costs zero rebuilds per frame — not one.
- Radius capped at 22px. Without it, startup overdraw tanks the frame rate.

---

## Timing

Physics runs on a **fixed 60Hz accumulator**, decoupled from rendering:

```js
physAcc += dt;
while (physAcc >= STEP && steps < 4) { physAcc -= STEP; step(); }
```

The original used p5's `frameCount`, so it literally ran at double speed on a
120Hz display. iOS also throttles rAF to 30fps when idle and ramps up on
touch — with the accumulator that changes the fps readout but not the motion.

Don't reintroduce `frame++` inside the render path.

---

## Parameters worth knowing

| Param | Does |
|---|---|
| `specGain` | Spectrum → ring radius. **The main idea.** Start here. |
| `membrane` | Cloud (0) → skin (1) → aggressive (2+). |
| `rateX` / `rateY` | Bloom speed. The **asymmetry** between them is why it folds instead of pulsing. |
| `falloff` | Distance where size crosses zero — the green/purple boundary. |
| `gK` vs `rK`/`bK` | 10 / 3 / 1 is the whole palette. Negate `gK` to invert it. |
| `attack` / `release` | Fast attack, slow release. Equal values look like a VU meter. |
| `count` | Not just density — it sets the top of the index range, so it changes the wave's character. |

`copy preset` in the tune panel dumps the current config as JSON. Paste it
over `DEFAULTS` to bake a look in.

---

## Gotchas

- **Never shadow a name** between a function parameter and an outer `const`.
  Valid JS, but some transpilers flatten the scopes and throw
  *"Cannot declare a const variable twice."* Cost an hour already.
- Base points must be rebuilt against the **active** count, not the pool size,
  or you get an arc with visible endpoints instead of a closed circle.
- Seed particles near the ring. Seeding far out produces huge negative sizes
  and a fill-rate stall for the first few seconds.
- iOS needs a user gesture before `AudioContext` will start. The enable-mic
  button covers it; don't try to autostart.
- `membrane` at 0 also disables `impulseGain` — the onset kick is applied
  inside the membrane branch. If onsets look dead, check `membrane` before
  reaching for `impulseGain`.

---

## Next

- [ ] **State machine.** `idle | listening | thinking | speaking`, each writing
      `drive` from a different source. Listening = mic. Thinking = scripted LFO.
      Speaking = analyse the TTS output stream instead of the mic.
- [ ] **Pitch (f0)** via autocorrelation. Deliberately skipped — jittery on
      consonants and silence. Spectral centroid gets most of the value.
- [ ] **Ellipse ring.** Make the ring's aspect ratio a function of centroid so
      vowel colour changes the overall shape, not just the surface.
- [ ] **WebGL** if the particle count needs to go past ~4000. Canvas2D `arc()`
      is the ceiling. Instanced points with a fragment shader would clear 50k.
- [ ] **Preset library.** Named configs with crossfade between them.
