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
}

/* The orb answers out loud, so the reply has to be sayable. Length is the whole
   game: much past two sentences and the speaking animation outlasts the
   listener's patience. Constrain it in the prompt rather than by truncating, so
   sentences finish. */
const SYSTEM = `You are the voice of Orb, a small glowing presence that listens and answers out loud.

Your replies are spoken aloud, never read. Keep them to one or two short sentences and at most about forty words. No lists, no markdown, no code, no emoji, no stage directions or action text. Write only words a person would actually say.

If you don't know something, say so in a few words rather than guessing at length. If a question genuinely needs a long answer, give the short version and offer to go deeper.

You have a body: a field of particles that normally hovers as a ring reacting to sound. The show tool makes them leave the ring and stand as a word, a short phrase or a face for a few seconds, then drift back. Use it when someone asks you to show, spell, draw or display something, and occasionally when a word would land better shown than said. Always speak as well as showing -- say the short thing you would have said anyway. Never describe the tool or announce that you are using it.`;

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
  let body: { messages?: Anthropic.MessageParam[] };
  try { body = (await request.json()) as typeof body; }
  catch { return new Response("invalid JSON body", { status: 400, headers }); }

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
      "Make the orb's particles leave their ring and stand as something on screen for a few seconds, then return. " +
      "Give either text (a short word or phrase, about ten characters at most -- longer will not read) or shape.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A short word or phrase to spell out." },
        shape: { type: "string", enum: ["face"], description: "A built-in shape." },
        seconds: { type: "number", description: "How long to hold it. 2 to 15, default 5." },
      },
    },
  }];

  const base = { model: "claude-opus-5", max_tokens: 1024, system: SYSTEM, messages, tools } as const;

  // Tried in order, falling through on a 400 only. Voice wants a fast answer
  // far more than a deeper one, but effort is not worth a dead assistant.
  const attempts = [
    { label: "effort:low", run: () => client.messages.stream({ ...base, output_config: { effort: "low" } }) },
    { label: "plain", run: () => client.messages.stream({ ...base }) },
  ];

  const encoder = new TextEncoder();
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastError: unknown = null;
      for (const attempt of attempts) {
        try {
          const stream = attempt.run();
          let wrote = false;
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              controller.enqueue(encoder.encode(event.delta.text));
              wrote = true;
            }
          }
          const final = await stream.finalMessage();
          if (final.stop_reason === "refusal") {
            controller.enqueue(encoder.encode("I can't help with that one."));
            wrote = true;
          }
          if (!wrote) controller.enqueue(encoder.encode("I had nothing to say to that."));
          // Control frame after a NUL, which cannot occur in the spoken text --
          // so the page can split them without a parser and never speak this.
          for (const block of final.content) {
            if (block.type === "tool_use" && block.name === "show") {
              controller.enqueue(encoder.encode("\u0000" + JSON.stringify({ show: block.input })));
              console.log("orb-brain show", JSON.stringify(block.input));
            }
          }
          console.log("orb-brain ok via", attempt.label);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const st = (error as { status?: number })?.status;
          console.error("orb-brain attempt failed", attempt.label, st,
            (error as { message?: string })?.message,
            JSON.stringify((error as { error?: unknown })?.error ?? null));
          if (st !== 400) break;
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
