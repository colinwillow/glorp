# Recording a voice for Colin

Two minutes of audio, one sitting, and you get a voice clone. What follows is
what to record and how, then a script if you would rather read than talk.

## The thing that matters most

**The clone copies your delivery, not just your voice.** ElevenLabs is explicit
about this: it mimics your speed, your inflections, your accent, your tonality,
even your breathing. So the register you record in is the register you get back
for every line, forever.

This is why reading a script in "reading voice" is the single most common way to
end up disappointed. You record something careful and even and slightly
announced, and then your character says *"yeah, I don't know, maybe"* in the
voice of a man narrating a documentary about glaciers.

Colin says short conversational things. So record short conversational things.

## What to record

**Best option: just talk for two minutes about this project.**

You already do this. The voice notes you send are exactly the right register —
explaining something you are in the middle of building, to someone sitting next
to you, thinking out loud. That is precisely what the character does. Pick
something you have opinions about and talk until the timer says two minutes:

- what Glorb is and why you started it
- the sandbox, and what you want him to be doing in there eventually
- something that annoyed you this week and what you did about it

Stumbles are fine. Restarts are fine. Do not perform.

**One caveat if you were about to reuse an existing voice note:** you can, but
only if it was recorded in one go, in a quiet room, with the phone in one
position. Half of one and half of another gives the model two different rooms to
average, and it will average them.

## The rules that actually change the result

Consistency beats everything else, including length. Two clean minutes beats ten
uneven ones.

- **One room, one mic, one distance, one energy.** Do not drift from excited to
  mumbling. Wide swings in pitch and volume make the output less predictable
  between generations — that is the failure mode, not "bad quality".
- **No echo.** A bedroom, a car, or a closet with clothes in it beats a kitchen
  or a bathroom. Soft surfaces near you, not hard ones.
- **No background noise at all.** No music, no fan, no traffic, no fridge hum.
  It clones the hum too.
- **Phone voice memo is fine.** Held about a hand's width away, slightly off to
  the side so your plosives do not thump. Higher bitrates do not meaningfully
  improve the clone.
- **Do not process it.** No noise reduction, no compression, no EQ, no de-esser.
  Raw is better; the artefacts from cleanup get cloned as part of your voice.
- **No long silences**, no coughs, no laughing fits, one speaker only.
- Record it twice and keep the second take. The first one is always stiff.

## If you would rather read something

Read it the way you would say it, not the way you would read it. Skim it once
first so you are not sight-reading. Add your own "like" and "you know" wherever
they want to go — the point is your cadence, not these words.

It runs about two minutes at a relaxed pace.

---

So the idea was pretty simple to start with. I wanted a little glowing thing
that listens to you and answers back, and reacts to sound, and that was more or
less the whole plan. It got away from me a bit after that.

Now there is a character in there. He's me, sort of — same hoodie, same beard —
and he stands in this dark room and talks, and dances if you ask him to. The
head and the body actually come from two different files, which is a hack, but
it works and nobody can tell.

The part I keep coming back to is the waiting. You say something, and there's
this gap before he answers, and the gap is the whole experience. Get it wrong
and it feels broken. Get it right and it feels like he's thinking.

Can I show you something? Watch what happens when it builds him. It starts at
the shoes and works upward — dots first, then a wireframe, then the surface, and
then his actual colours arrive last. It takes about four seconds. Four seconds
is a long time to stare at a loading bar and a short time to watch someone get
assembled out of nothing.

The eyes were the hardest part, weirdly. Not the mouth — the eyes. Get those
half a degree off and he looks straight through you.

I don't really know where it ends up. Maybe a room he wanders around on his own,
with things in it he can go and use. A chair. A dog. Somewhere he'd rather be
standing than where he is now.

But yeah. That's roughly it.

---

## Then

Upload it to ElevenLabs, make an Instant Voice Clone, copy the voice id, and
paste it into **`ELEVEN_VOICE_COLIN`** in the Cloudflare dashboard for the
`orb-brain` Worker. Nothing needs deploying — the precedence is already wired,
so Colin speaks in your voice and the orb keeps its own, on the same API key.

If the first clone sounds nearly right but slightly off, make a second one from
a different take rather than fiddling with settings. Two clones cost nothing and
the difference between takes is usually bigger than anything a slider does.
