# music

Drop audio files in this folder and list them in `manifest.json`.

```json
[
  { "file": "some-track.mp3", "title": "Some Track", "bpm": 96 },
  { "file": "another.mp3",    "title": "Another" }
]
```

- `file` — required, the filename in this folder.
- `title` — optional. What he calls it, and what "play <name>" matches against.
  Without one, the filename is used with the extension and underscores stripped.
- `bpm` — optional, and worth adding. The tempo is measured from the audio
  otherwise, which takes a few seconds of playback to settle and can land on
  half or double the real tempo on a track with a sparse kick. A number typed
  by someone who knows the track beats an onset detector every time.

Anything a browser can play works: mp3, m4a, ogg, wav. mp3 is the safe choice.

The tempo matters because the dances are stretched to fit it — each clip is
sped up or slowed by the smallest amount that makes a short run of it come to a
whole number of beats, so it stays on the grid instead of drifting. Measured
against Heat Waves at 81 BPM, every dance fits inside a 4.3% stretch: the
flares takes 4 beats every 3 passes, the k-kick 20 every 3, uprock_00 63 every
4, uprock_01 35 every 2. Past about a tenth either way it stops being the same
dance, so it is left alone and simply runs free.

Three of the five tracks here have a measured tempo written in. Cosmic and
Icecream Paint Job do not: their onset envelopes have no clear winner — Cosmic's
top three candidates are within 8% of each other — so rather than write down a
guess they are left to the live detector, which folds whatever it finds into a
range a person would tap. If you know what they are, put the numbers in.
