import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  /** Set with: npx wrangler secret put ANTHROPIC_API_KEY */
  ANTHROPIC_API_KEY: string;
  /** e.g. https://colinwillow.github.io -- leave unset only while testing */
  ALLOWED_ORIGIN?: string;
}

/* The orb answers out loud, so the reply has to be sayable. Length is the whole
   game here: anything past a couple of sentences and the speaking animation
   outlasts the listener's patience. Constrain it in the prompt rather than by
   truncating, so sentences finish. */
const SYSTEM = `You are the voice of Orb, a small glowing presence that listens and answers out loud.

Your replies are spoken aloud, never read. Keep them to one or two short sentences and at most about forty words. No lists, no markdown, no code, no emoji, no stage directions or action text. Write only words a person would actually say.

If you don't know something, say so in a few words rather than guessing at length. If a question genuinely needs a long answer, give the short version and offer to go deeper.`;

function cors(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN ?? "*";
    const headers = cors(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers });

    let body: { messages?: Anthropic.MessageParam[] };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response("invalid JSON body", { status: 400, headers });
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response("body must be { messages: [...] }", { status: 400, headers });
    }

    /* Check the secret before handing it to the SDK. Passing undefined makes
       the SDK fall through to its whole credential-resolution chain and report
       "Could not resolve authentication method", which reads like a code bug
       rather than the one-line fix it is. */
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        "No API key on this Worker. Run: npx wrangler secret put ANTHROPIC_API_KEY",
        { status: 500, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } }
      );
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    // Streamed so the orb can start speaking on the first token instead of
    // waiting for the whole reply -- that latency is the difference between a
    // conversation and a lookup.
    const makeStream = () => client.beta.messages.stream({
      model: "claude-opus-5",
      max_tokens: 1024, // deliberately short: this gets spoken, not read
      system: SYSTEM,
      messages,
      thinking: { type: "adaptive" },
      // Voice wants an answer back fast far more than it wants a deeper one.
      // Raise to "high" if you would rather have considered replies than quick ones.
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
    });

    const encoder = new TextEncoder();
    let streamRef: ReturnType<typeof makeStream> | null = null;
    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          streamRef = makeStream();
          for await (const event of streamRef) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
          // A policy decline arrives as HTTP 200 with no text, which would leave
          // the orb silently stuck in its speaking state. Give it something to say.
          const final = await streamRef.finalMessage();
          if (final.stop_reason === "refusal") {
            controller.enqueue(encoder.encode("I can't help with that one."));
          }
        } catch (error) {
          // Say something human, but never swallow the detail -- a generic
          // "something went wrong" is indistinguishable from every other
          // failure and leaves nothing to act on.
          const err = error as { name?: string; message?: string; status?: number };
          console.error("orb-brain failure", err?.name, err?.status, err?.message, error);
          let say = "Something went wrong reaching my brain.";
          if (error instanceof Anthropic.AuthenticationError) say = "My API key isn't working.";
          else if (error instanceof Anthropic.RateLimitError) say = "I'm being rate limited. Try again in a moment.";
          else if (error instanceof Anthropic.APIError) say = `API error ${error.status}.`;
          say += ` [${err?.name ?? "Error"}: ${(err?.message ?? String(error)).slice(0, 300)}]`;
          controller.enqueue(encoder.encode(say));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(out, {
      headers: { ...headers, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
