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
    const raw = env.ANTHROPIC_API_KEY ?? "";
    const apiKey = raw.trim();
    if (!apiKey) {
      return new Response(
        "No API key on this Worker. Run: npx wrangler secret put ANTHROPIC_API_KEY",
        { status: 500, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } }
      );
    }
    /* Pasting a key into a Windows terminal usually drags a carriage return in
       with it. A header value containing CR or LF is invalid, so the request is
       rejected at the edge before anything reads it -- which surfaces as a 400
       with an empty body rather than the 401 a merely-wrong key would give.
       Trim it, and report the shape (never the key) so a truncated paste is
       obvious too. */
    if (raw !== apiKey) {
      console.warn("orb-brain: key had surrounding whitespace or newline -- trimmed");
    }
    console.log(
      "orb-brain: key length", apiKey.length,
      "prefix ok", apiKey.startsWith("sk-ant-"),
      "(a full key is about 100-110 chars)"
    );

    const client = new Anthropic({ apiKey });

    /* Streamed so the orb can start speaking on the first token instead of
       waiting for the whole reply -- that latency is the difference between a
       conversation and a lookup.

       Tried in order, falling through on a 400. Beta features and effort are
       both worth having but neither is worth a dead assistant, and an empty
       400 body says nothing about which parameter was rejected -- so let the
       worker find out and log it rather than guessing across deploys. */
    const base = {
      model: "claude-opus-5",
      max_tokens: 1024, // deliberately short: this gets spoken, not read
      system: SYSTEM,
      messages,
    } as const;

    const attempts: Array<{ label: string; run: () => ReturnType<typeof client.messages.stream> }> = [
      {
        // Voice wants an answer back fast far more than a deeper one.
        label: "effort:low",
        run: () => client.messages.stream({ ...base, output_config: { effort: "low" } }),
      },
      {
        label: "plain",
        run: () => client.messages.stream({ ...base }),
      },
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
            // A policy decline arrives as HTTP 200 with no text, which would
            // leave the orb stuck in its speaking state. Give it something to say.
            const final = await stream.finalMessage();
            if (final.stop_reason === "refusal") {
              controller.enqueue(encoder.encode("I can't help with that one."));
              wrote = true;
            }
            if (!wrote) controller.enqueue(encoder.encode("I had nothing to say to that."));
            console.log("orb-brain ok via", attempt.label);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            const st = (error as { status?: number })?.status;
            console.error("orb-brain attempt failed", attempt.label, st,
              (error as { message?: string })?.message,
              JSON.stringify((error as { error?: unknown })?.error ?? null),
              (error as { requestID?: string })?.requestID);
            // Only a 400 is worth downgrading for; anything else is real.
            if (st !== 400) break;
          }
        }

        try {
          if (lastError) throw lastError;
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
