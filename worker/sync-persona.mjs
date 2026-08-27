#!/usr/bin/env node
/* persona-colin.md -> the PERSONA_COLIN literal in src/index.ts.

   Two files held the same text and nothing kept them together, which lasts
   until the first time somebody edits the readable one and pushes, and then
   the live character is whatever the unreadable one still says.

   So the markdown is the source and this copies it. It also does the escaping,
   which is the part worth automating: the text lands inside a template literal,
   where a single backtick ends the string and turns the rest of the file into
   TypeScript, and a dollar-brace opens an interpolation. Both are ordinary
   things to type in prose about code -- there is already one backtick in the
   file's own notes -- and only one of them fails loudly.

   Everything above the <!-- persona --> marker is notes for whoever edits it
   and is not part of who he is. Left in, they are eventually something he says
   out loud. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MD = join(here, "persona-colin.md");
const TS = join(here, "src", "index.ts");
/* On its own line, and anchored to one -- the notes above it necessarily talk
   ABOUT the marker, and an unanchored search finds that mention first and
   compiles the notes in as his personality. Which it did, once. */
const MARK = /^<!-- persona -->$/m;

const md = readFileSync(MD, "utf8");
const m = MARK.exec(md);
if (!m) throw new Error("no <!-- persona --> line of its own in persona-colin.md");
const body = md.slice(m.index + m[0].length).trim() + "\n";

const esc = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const ts = readFileSync(TS, "utf8");
const open = "const PERSONA_COLIN = `";
const a = ts.indexOf(open);
if (a < 0) throw new Error("no PERSONA_COLIN in index.ts");
const b = ts.indexOf("`;", a + open.length);
if (b < 0) throw new Error("PERSONA_COLIN literal is unterminated");

const next = ts.slice(0, a + open.length) + esc + ts.slice(b);
if (next === ts) { console.log("persona already in sync"); process.exit(0); }
writeFileSync(TS, next);
console.log("synced " + body.split(/\s+/).length + " words into src/index.ts"
  + " (" + (body.match(/`/g) || []).length + " backticks escaped)");
