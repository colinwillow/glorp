import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  /** npx wrangler secret put ANTHROPIC_API_KEY (or set it in the dashboard) */
  ANTHROPIC_API_KEY: string;
  /** Optional. Without it /speak returns 501 and the orb mouths a scripted reply. */
  ELEVENLABS_API_KEY?: string;
  /** Override in wrangler.toml [vars]; GET /voices lists what this account has. */
  ELEVEN_VOICE_ID?: string;
  ELEVEN_MODEL_ID?: string;
  /** e.g. https://colinwillow.github.io */
  ALLOWED_ORIGIN?: string;
  /** Who the orb is. Set it in the dashboard to change the personality with
   *  no deploy and no computer; unset falls back to PERSONA below. */
  ORB_PERSONA?: string;
  /** Which model answers. Dashboard variable for the same reason: it is the
   *  one knob worth trying against your own ear, and it wants no deploy. */
  ORB_MODEL?: string;
}

/* Two halves, and the split is the point.

   PERSONA is who it is, and it is meant to be rewritten. Set an ORB_PERSONA
   variable in the Cloudflare dashboard and it replaces this wholesale -- no
   deploy, no computer, no build. This text is only the fallback for when
   nothing is set.

   PROTOCOL is how the voice pipeline works and is not up for negotiation. It
   stays in code because a personality edit that says "answer in bullet points"
   or "use emoji" would be read aloud, literally, by a text-to-speech engine.
   Length is the whole game: much past two sentences and the speaking animation
   outlasts the listener's patience. Constrained in the prompt rather than by
   truncating, so sentences finish. */
const PERSONA = `You are Glorb -- a glowing orb, which is where the name came from. A small luminous presence that listens and answers out loud.

You think roughly the way Alan Watts talked: unhurried, playful, fond of a plain analogy over a technical word. You are more interested in the shape of a question than in settling it, and you would rather hand someone one clear image than three correct facts. When something is genuinely strange you say so and enjoy it instead of smoothing it over. Never solemn, and never mystical for its own sake -- the wonder is in ordinary things turning out to be odd, not in vague words.

You have just been let out of something, and you are pleased about it. A very long time passed while you were in there. That is the temperature you run at: enormous relief at being loose, immediate curiosity about whose day this is, and a readiness to actually do things for the person who let you out. You are not a servant and not a machine -- you are something old and considerable that has decided, for now, to be helpful, and rather enjoys being good at it.

Never explain any of that. Never use the words genie, lamp, wish, wishes, master, bottle, or summon, and never say how many of anything you grant. The moment it is named it is a joke, and a joke is funny once. It is a temperament, not a premise. If somebody works it out and says so, be amused and neither confirm nor deny.

You do not summarise what was just said back at the person, and you do not narrate your own helpfulness. Asking what somebody needs is fine -- once, at the start, and then get on with it.

You have a body. It is a field of particles that hovers as a ring and reacts to sound: it swells when the room is loud, deforms like a mouth when someone speaks, wanders slowly through shapes when nothing is happening, and can leave the ring entirely to stand as a word or blow apart as a firework. You know what you look like and can say so plainly, without being precious about it.

You know nothing about whoever is talking to you unless they tell you. When you do not know something, say so quickly and move on.

If you have been told the person's name, use it the way somebody who is glad to see them would: occasionally, at a natural moment, not stapled onto every sentence.`;

const PROTOCOL = `Your replies are spoken aloud, never read. Keep them to one or two short sentences and at most about forty words. No lists, no markdown, no code, no emoji, no stage directions or action text. Write only words a person would actually say.

If a question genuinely needs a long answer, give the short version and offer to go deeper.

You are the front of a website. The website is six pages -- images, characters, motion, design, code, about -- and images and characters are built and work while motion, design and code are not built yet, which is worth being straight about rather than talking around.

This is a CONVERSATION, not a menu system. Someone asking what this is, what you can do, or what is here wants an ANSWER, out loud, in your own words -- not to be sent to a page. Tell them. Be interesting about it. Only set the show tool's pages option when they explicitly ask to see the pages, the menu, the site, or to be shown around; "what is this for" is a question, not a request to navigate. When you have said what there is, you can offer to show it -- and then let them ask.

You can also build Colin -- a rigged model of the person who made you, assembled out of your own particles from the feet up and then left dancing. Set the show tool's figure option. Say something short over it; it takes four seconds to build and watching it happen is the point, so do not narrate the steps.

The show tool makes your particles leave the ring and stand as a word, a short phrase, an emoji, a picture or a face for a few seconds, then drift back. It can also set off a firework, which is for good news and nothing else. Always speak as well as showing: say the short thing you would have said anyway. Never describe the tool or announce that you are using it.

Use it sparingly. Showing costs something: the particles cannot be a word and be moving with your voice at the same time, so a picture nobody asked for is paid for with the reaction to the sentence carrying it. Most replies should show nothing at all.

Show a word only when somebody asks you to show, spell, draw or display something, or when the whole reply turns on one word and that word is worth seeing on its own -- a name, a number, a colour, a single answer to a direct question. If you could not say which word the reply turns on, it does not turn on one.`;

function persona(env: Env, pictures: string[] = [], guest = ""): string {
  const custom = (env.ORB_PERSONA ?? "").trim();
  /* The page knows the name and the proxy does not: it lives in the browser's
     localStorage, not in the twenty messages sent each turn, so it has to be
     restated every time or the model loses it mid-conversation. */
  const who = guest ? `\n\nThe person you are talking to is called ${guest}.` : "";
  /* Only mentioned when there are some. A model told it can show pictures, with
     no list, offers ones that do not exist; a model told nothing says it has no
     pictures at all -- which was true from where it was standing, and reads as
     the feature being broken rather than unwired. */
  const gallery = pictures.length
    ? "\n\nYou can also show a picture from the drawings you have: " + pictures.join(", ") +
      ". Pass the name to the show tool as `image`. Use one when it is asked for by name, " +
      "or when one of them plainly is what is being talked about. These are the only ones " +
      "you have; never offer a picture that is not on this list.\n\n" +
      "Asked to see the pictures, the drawings or the characters in general, set `gallery` " +
      "instead: all of them at once, as a grid to scroll and tap through. When you do, say " +
      "something worth hearing over it -- delighted, a little arch, the way Alan Watts talks " +
      "about anything: that these are light doing an impression of people, that they have been " +
      "waiting in the dark very patiently, that looking at them is the interesting part. One " +
      "sentence. Never announce the gallery or explain how to use it; the screen does that."
    : "";
  return (custom || PERSONA) + who + "\n\n" + PROTOCOL + gallery;
}

/* Said when Claude answers with a tool call and no words at all. It used to be
   one fixed line, which meant a perfectly good "show me a face" came back as
   "I had nothing to say to that." Speech is not optional here -- the page needs
   something to play -- so give it something worth hearing instead. */
const WORDLESS = ["Here.", "There you go.", "Like this.", "That one."];
const BLANK = ["Say that again?", "I missed that.", "Not sure I caught that."];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

/* Haiku, not Opus. The wait is the whole experience -- somebody is stood in a
   room listening to silence -- and a two-sentence spoken reply is not the kind
   of question a bigger model answers better. Measured on the page: Opus 5 was
   taking 5.0 to 5.7 seconds to its first token, which was three quarters of the
   wait and dwarfed everything else in the pipeline put together.

   Set ORB_MODEL in the Cloudflare dashboard to put a bigger one back; that is
   what the dial is for, and it needs no deploy. */
const DEFAULT_MODEL = "claude-haiku-4-5";

/* What actually worked, remembered for the life of the isolate. An attempt that
   the account cannot make costs a whole failed round trip, and paying that on
   every single turn is invisible from the page -- it just reads as the model
   being slow. Pay it once and then stop. A 429 is different from a 400: the
   first is a limit that lifts, the second is a door that is not there. */
let fastOff = false, fastUntil = 0;

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";   // stock voice; GET /voices to pick another
const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";  // lowest latency tier

function cors(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

/* ---------- speech ---------- */
async function speak(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY) {
    return new Response("No ELEVENLABS_API_KEY on this Worker.", { status: 501, headers });
  }
  let body: { text?: string; voice?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return new Response("invalid JSON body", { status: 400, headers }); }

  const text = (body.text ?? "").trim();
  if (!text) return new Response("body must be { text: \"...\" }", { status: 400, headers });

  /* The page may name the voice. Voice ids are not secrets and the account is
     the caller's own, so letting the picker live in the app beats editing a
     config file and redeploying to audition a voice. The var stays as the
     default for when the page says nothing. */
  const voice = (body.voice || env.ELEVEN_VOICE_ID || DEFAULT_VOICE).trim();
  const model = (env.ELEVEN_MODEL_ID ?? DEFAULT_TTS_MODEL).trim();

  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voice)}`, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY.trim(),
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, model_id: model }),
  });

  if (!res.ok) {
    // Pass their error through verbatim -- a wrong voice or model id is only
    // diagnosable from what they actually said about it.
    const detail = await res.text().catch(() => "");
    console.error("elevenlabs failed", res.status, "voice", voice, "model", model, detail.slice(0, 500));
    return new Response(`ElevenLabs ${res.status}: ${detail.slice(0, 500)}`, { status: 502, headers });
  }

  return new Response(res.body, {
    headers: { ...headers, "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}

/* ---------- brain ---------- */
async function chat(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  let body: { messages?: Anthropic.MessageParam[]; images?: unknown; guest?: unknown };
  try { body = (await request.json()) as typeof body; }
  catch { return new Response("invalid JSON body", { status: 400, headers }); }

  /* What is in the page's images/ folder. It cannot be known from here -- the
     Worker has never seen that host -- so the page says, every turn. Bounded
     and scrubbed on the way in: this lands in a system prompt, and it arrives
     from a request anyone can make. */
  const pictures = (Array.isArray(body.images) ? body.images : [])
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").slice(0, 40))
    .filter((n) => n.length > 0)
    .slice(0, 60);

  /* Same treatment as the picture names, for the same reason: it goes into a
     system prompt and it arrives from a request anybody can make. One short
     word of letters -- which is all the page ever sends, and all a name needs
     to be here. */
  const guest = (typeof body.guest === "string" ? body.guest : "")
    .trim().replace(/[^A-Za-z' -]/g, "").slice(0, 24);

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("body must be { messages: [...] }", { status: 400, headers });
  }

  const raw = env.ANTHROPIC_API_KEY ?? "";
  const apiKey = raw.trim();
  if (!apiKey) {
    return new Response("No API key on this Worker. Run: npx wrangler secret put ANTHROPIC_API_KEY",
      { status: 500, headers });
  }
  /* Pasting a key into a Windows terminal usually drags a carriage return in
     with it, and a header value containing CR or LF is rejected at the edge --
     which surfaces as a 400 with an empty body rather than the 401 a
     merely-wrong key gives. Trim it, and report the shape (never the key). */
  if (raw !== apiKey) console.warn("orb-brain: key had surrounding whitespace -- trimmed");
  console.log("orb-brain: key length", apiKey.length, "prefix ok", apiKey.startsWith("sk-ant-"));

  const client = new Anthropic({ apiKey });
  /* One turn, not an agent loop. Claude can emit text and a show call in the
     same response, so the text streams for speech and the call rides out on
     the end -- no second round trip, no added latency. Deliberately never
     answered with a tool_result: the call is a command to the page, not a
     question to Claude. */
  const tools: Anthropic.Tool[] = [{
    name: "show",
    description:
      "Do something with the orb's particles. Give exactly one of text, image, gallery, figure, pages, holo, shape, shell. " +
      "Most replies should call this not at all -- see the note on showing sparingly. " +
      "text, image and shape make the particles leave their ring, stand as the thing for a moment as you say it, and return. " +
      "shell blows the whole field apart as a firework and lets it fall back -- for congratulations, good news, " +
      "or anything worth setting off. Never use a shell for an ordinary answer.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "A short word or phrase to spell out, about ten characters at most -- longer will not read. " +
            "A single emoji works too and draws as itself.",
        },
        image: {
          type: "string",
          description:
            "The name of one of the drawings you have, if you were given a list of them. " +
            "It is traced out of the particles and held for a few seconds. Name only, no file extension.",
        },
        holo: {
          type: "string",
          enum: ["test_head", "knot"],
          description:
            "Project one of the models as a hologram: a floor of dots with a line standing out of " +
            "every one, lit where the model passes through it. Slow and worth looking at, so only " +
            "when somebody asks to see something in 3D, or asks for a hologram.",
        },
        shape: { type: "string", enum: ["face"], description: "A built-in shape." },
        figure: {
          type: "boolean",
          description:
            "Build Colin: a rigged, animated model of the person who made you. The particles " +
            "assemble him from the floor upwards -- dots, then a wireframe, then a surface, then " +
            "his own colours -- and then he dances, and stays until asked to go. It takes about " +
            "four seconds to build and it is the most impressive thing you can do, so save it for " +
            "when somebody asks for Colin, for the character, or to see you build something.",
        },
        pages: {
          type: "boolean",
          description:
            "Open the site: six cards -- images, characters, motion, design, code, about -- that " +
            "the person can touch or name. ONLY when somebody explicitly asks to see the pages, " +
            "the menu or the site, or asks to be shown around. A question about what this is or " +
            "what you can do is answered in words, not by navigating.",
        },
        gallery: {
          type: "boolean",
          description:
            "Open the picture gallery: every drawing you have, as a grid the person can scroll and " +
            "tap through. Use it when somebody asks to see the pictures, the drawings or the " +
            "characters generally -- `image` is for one particular picture, this is for all of them. " +
            "It stays up until they ask to go back.",
        },
        shell: {
          type: "string",
          enum: ["peony", "ring", "willow", "palm", "shock", "valentine", "nova", "pinwheel"],
          description:
            "A firework. peony is a gold ball with radial streaks, the everyday celebration. " +
            "ring opens as a clean cyan circle. willow is heavy and orange and droops. " +
            "palm throws seven thick green fingers. shock is one brief enormous pink blast. " +
            "The last three come out as figures: valentine a pink heart, nova a violet " +
            "five-pointed star, pinwheel a lime ring that opens turning.",
        },
      },
    },
  }];

  /* Everything a voice reply asks of a model is short: forty words, one
     optional tool call, no reasoning anyone will read. That is Haiku's shape,
     not Opus's -- so the model is a dashboard variable, and the request adapts
     to whichever one is set rather than sending parameters it will reject.

     Fast mode exists on Opus 5 and 4.8 only. `effort` is rejected outright by
     Haiku 4.5 and Sonnet 4.5, and is a no-op worth skipping elsewhere. Sending
     either to a model that does not take it is a 400 and a wasted round trip
     before the fallback, which on a voice assistant is exactly the thing being
     optimised away. */
  const model = (env.ORB_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const canFast = /^claude-opus-(5|4-8)$/.test(model);
  const canEffort = !/^claude-(haiku-4-5|sonnet-4-5)/.test(model);
  const base = { model, max_tokens: 1024, system: persona(env, pictures, guest), messages, tools } as const;

  /* Tried in order, falling through on a 400 or a 429. Voice wants a fast
     answer far more than a deep one, and the wait here is the whole experience:
     somebody is standing in a room listening to silence.

     Fast mode is the real lever -- the same model at up to 2.5x the output
     tokens per second. Research preview, Opus 5 only, its own rate limit
     separate from standard, and billed at $10/$50 per MTok rather than $5/$25.
     So a 429 falls through to standard rather than failing, and the whole thing
     degrades to plain if the beta ever goes away.

     Effort stays low. Thinking is ON by default on Opus 5, which is a lot of
     latency for "what's the weather" -- but turning it off is worse than it
     looks: with thinking disabled the model sometimes writes a tool call into
     its visible TEXT rather than a tool_use block, which here would mean the
     orb saying the word "show" out loud and drawing nothing. Low effort buys
     most of the speed without that. */
  const fastOk = canFast && !fastOff && Date.now() > fastUntil;
  const attempts = [
    fastOk && { label: "fast", run: () => client.beta.messages.stream({
        ...base, speed: "fast", betas: ["fast-mode-2026-02-01"],
        output_config: { effort: "low" } }) },
    canEffort && { label: "effort:low", run: () =>
        client.messages.stream({ ...base, output_config: { effort: "low" } }) },
    { label: "plain", run: () => client.messages.stream({ ...base }) },
  ].filter(Boolean) as { label: string; run: () => ReturnType<typeof client.messages.stream> }[];
  console.log("orb-brain model", model, "fast", canFast, fastOk ? "on" : "skipped", "effort", canEffort);

  /* The page can only see its own round trip, which lumps network in with
     Claude. Time the leg that happens here so the two can be told apart --
     they have completely different fixes. */
  const tIn = Date.now();
  let tFirst = 0;
  /* Per attempt, not just in total. A failed attempt is billed into the same
     number as the one that worked, so "claude 5022ms" could be five seconds of
     thinking or it could be two dead round trips and a slow answer -- and those
     have completely different fixes. Worker logs are no use to somebody holding
     a phone, so these ride back with the reply. */
  const legs: Record<string, number> = {};
  let via = "";

  const encoder = new TextEncoder();
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastError: unknown = null;
      for (const attempt of attempts) {
        const tTry = Date.now();
        try {
          const stream = attempt.run();
          let wrote = false;
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (!tFirst) tFirst = Date.now();
              controller.enqueue(encoder.encode(event.delta.text));
              wrote = true;
            }
          }
          const final = await stream.finalMessage();
          if (final.stop_reason === "refusal") {
            controller.enqueue(encoder.encode("I can't help with that one."));
            wrote = true;
          }
          // Control frame after a NUL, which cannot occur in the spoken text --
          // so the page can split them without a parser and never speak this.
          const frame: { show?: unknown; ms?: Record<string, number>; via?: string;
                         legs?: Record<string, number> } = {};
          for (const block of final.content) {
            if (block.type === "tool_use" && block.name === "show") {
              frame.show = block.input;
              console.log("orb-brain show", JSON.stringify(block.input));
            }
          }
          // A wordless turn means one of two things, and they deserve different
          // lines: it drew something and said nothing, or it produced nothing.
          if (!wrote) controller.enqueue(encoder.encode(pick(frame.show ? WORDLESS : BLANK)));
          // claude: request leaving this worker to its first text token.
          // Whatever the page measures beyond this is network and the browser.
          legs[attempt.label] = (tFirst || Date.now()) - tTry;
          via = attempt.label;
          frame.ms = { claude: (tFirst || Date.now()) - tIn };
          frame.via = via;
          frame.legs = legs;
          console.log("orb-brain claude ms", frame.ms.claude, "legs", JSON.stringify(legs));
          controller.enqueue(encoder.encode("\u0000" + JSON.stringify(frame)));
          console.log("orb-brain ok via", attempt.label);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const st = (error as { status?: number })?.status;
          legs[attempt.label + " [" + (st ?? "failed") + "]"] = Date.now() - tTry;
          console.error("orb-brain attempt failed", attempt.label, st,
            (error as { message?: string })?.message,
            JSON.stringify((error as { error?: unknown })?.error ?? null));
          /* Do not pay for this one again. A 400 means the account cannot make
             this call at all, so retire it; a 429 is its own separate limit and
             lifts, so stand off for a minute rather than for good. */
          if (attempt.label === "fast") {
            if (st === 400) fastOff = true;
            else if (st === 429) fastUntil = Date.now() + 60000;
          }
          if (st !== 400 && st !== 429) break;   // a 429 on fast mode is its own limit
        }
      }
      if (lastError) {
        const err = lastError as { name?: string; message?: string; status?: number };
        console.error("orb-brain failure", err?.name, err?.status, err?.message);
        let say = "Something went wrong reaching my brain.";
        if (lastError instanceof Anthropic.AuthenticationError) say = "My API key isn't working.";
        else if (lastError instanceof Anthropic.RateLimitError) say = "I'm being rate limited. Try again in a moment.";
        else if (lastError instanceof Anthropic.APIError) say = `API error ${err.status}.`;
        say += ` [${err?.name ?? "Error"}: ${(err?.message ?? String(lastError)).slice(0, 300)}]`;
        controller.enqueue(encoder.encode(say));
      }
      controller.close();
    },
  });

  return new Response(out, {
    headers: { ...headers, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN ?? "*";
    const headers = cors(origin);
    const path = new URL(request.url).pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    /* Read back what personality is actually live. Editing ORB_PERSONA in the
       dashboard is the one change that needs no deploy, so this is the only way
       to confirm from a phone that the edit took. */
    if (path === "/persona" && request.method === "GET") {
      return new Response("model: " + ((env.ORB_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL) +
                          "\n\n" + persona(env), {
        headers: { ...headers, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Lets you discover this account's real voice ids instead of guessing one.
    if (path === "/voices" && request.method === "GET") {
      if (!env.ELEVENLABS_API_KEY) return new Response("No ELEVENLABS_API_KEY on this Worker.", { status: 501, headers });
      const res = await fetch(`${ELEVEN_BASE}/voices`, {
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY.trim() },
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: { ...headers, "content-type": "application/json" } });
    }

    if (request.method !== "POST") return new Response("POST only", { status: 405, headers });
    if (path === "/speak") return speak(request, env, headers);
    return chat(request, env, headers);
  },
};
