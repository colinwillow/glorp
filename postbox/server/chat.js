// Talk to it. A conversation with Claude that has every tool in tools.js, is
// briefed with BRAIN.md, and remembers the thread in chat.json. Auto mode is
// the same agent on a standing prompt.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MODEL, hasClaude } from './env.js';
import { brainForPrompt } from './brain.js';
import { TOOLS, runTool } from './tools.js';
import { hasDiscord } from './discord.js';
import { loadAssets, loadPosts, loadGrid } from './store.js';

const FILE = path.join(ROOT, 'chat.json');
const AUTO_LOG = path.join(ROOT, 'auto-log.jsonl');

export function loadChat() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { messages: [], turns: [] }; } }
export function saveChat(c) { fs.writeFileSync(FILE, JSON.stringify(c, null, 2)); }
export function clearChat() { fs.rmSync(FILE, { force: true }); }

const SYSTEM = `You are Postbox: the studio assistant for a working artist's social presence. You have tools over
their library of finished work, the posts being drafted, the planned Instagram grid, and image editing.
Act, don't describe. When asked to rearrange, edit, crop, retitle, propose, or clean up — call the tools, then say
briefly what you did and what you'd suggest next. Look before you act (list_library, list_posts, get_grid) so ids are real.
Never invent facts about the work; read the asset descriptions. Keep replies short; the artist reads them beside the UI.
When the artist states a preference or a rule, use \`remember\` so it sticks. Do not hand_off a post unless asked, or
in auto mode when the brain's auto rules say so.

## Brain file
`;

function snapshot() {
  const assets = loadAssets(), posts = loadPosts(), grid = loadGrid();
  const by = {}; for (const a of assets) by[a.project] = (by[a.project] || 0) + 1;
  return `## Right now\nassets: ${assets.length} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}) · posts: ${posts.filter(p => p.status === 'proposed').length} proposed, ${posts.filter(p => p.status === 'approved').length} approved, ${posts.filter(p => p.status === 'scheduled').length} scheduled · grid: ${grid.cells.length} cells · discord handoff: ${hasDiscord() ? 'configured' : 'not configured (dry run)'}\nToday: ${new Date().toISOString().slice(0, 10)}`;
}

let client = null;
async function getClient() { if (client) return client; const { default: Anthropic } = await import('@anthropic-ai/sdk'); client = new Anthropic(); return client; }

async function sdkTools() {
  const { betaZodTool } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  return TOOLS.map(t => betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: async (input) => JSON.stringify(await t.run(input)).slice(0, 40000) }));
}

// One user turn. Returns the assistant's text plus every tool call it made.
export async function chatTurn(text, { history = loadChat(), maxIterations = 24 } = {}) {
  if (!hasClaude()) return offlineTurn(text, history);
  const c = await getClient();
  const tools = await sdkTools();
  const messages = [...history.messages, { role: 'user', content: text }];
  const runner = c.beta.messages.toolRunner({
    model: MODEL, max_tokens: 16000, tools, messages,
    max_iterations: maxIterations,
    system: [{ type: 'text', text: SYSTEM + brainForPrompt(), cache_control: { type: 'ephemeral' } }, { type: 'text', text: snapshot() }],
  });
  const calls = []; let final = null;
  for await (const message of runner) {
    for (const b of message.content) if (b.type === 'tool_use') calls.push({ name: b.name, input: b.input });
    final = message;
  }
  final = (await runner.done()) || final;
  if (final?.stop_reason === 'refusal') throw new Error('Model declined: ' + (final.stop_details?.explanation || ''));
  const reply = (final?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  // The runner appends every assistant turn and tool result to its own
  // params.messages, so that IS the transcript; keep it for the next turn.
  history.messages = (runner.params?.messages || messages).slice(-60);
  history.turns = (history.turns || []).concat([{ at: new Date().toISOString(), user: text, reply, calls }]).slice(-100);
  saveChat(history);
  return { reply, calls };
}

// No key: a small command vocabulary over the same tools, so the panel still
// does something useful and the plumbing is exercised.
const OFFLINE = [
  [/^\/?(arrange|tidy)( grid)?/i, () => ['arrange_grid', {}]],
  [/^\/?fill(?: (\d+))?/i, (m) => ['arrange_grid', { fillTo: Number(m[1]) || 9 }]],
  [/^\/?propose(?: (\w+))?(?: (\d+))?(?: (.*))?/i, (m) => ['propose_posts', { platform: m[1] || 'instagram_feed', count: Number(m[2]) || 4, note: m[3] || '' }]],
  [/^\/?plan/i, () => ['plan_times', {}]],
  [/^\/?crop (\S+) (square|portrait|story|landscape)(?: "(.+)")?/i, (m) => ['edit_image', { id: m[1], aspect: m[2], title: m[3] }]],
  [/^\/?title (\S+) "(.+)"/i, (m) => ['edit_image', { id: m[1], title: m[2], label: 'titled' }]],
  [/^\/?approve (\S+)/i, (m) => ['update_post', { id: m[1], status: 'approved' }]],
  [/^\/?reject (\S+)/i, (m) => ['update_post', { id: m[1], status: 'rejected' }]],
  [/^\/?handoff (\S+)/i, (m) => ['hand_off', { id: m[1] }]],
  [/^\/?remember (.+)/i, (m) => ['remember', { detail: m[1] }]],
  [/^\/?grid/i, () => ['get_grid', {}]],
  [/^\/?(ls|list)(?: (.+))?/i, (m) => ['list_library', { query: m[2] }]],
];
async function offlineTurn(text, history) {
  for (const [re, fn] of OFFLINE) {
    const m = re.exec(text.trim());
    if (!m) continue;
    const [name, input] = fn(m);
    const result = await runTool(name, input);
    const reply = `(no API key — ran \`${name}\` directly)\n` + '```\n' + JSON.stringify(result, null, 1).slice(0, 1500) + '\n```';
    history.turns = (history.turns || []).concat([{ at: new Date().toISOString(), user: text, reply, calls: [{ name, input }] }]).slice(-100);
    saveChat(history);
    return { reply, calls: [{ name, input }] };
  }
  const reply = 'No ANTHROPIC_API_KEY, so I can only run commands: `arrange`, `fill 9`, `propose [platform] [n] [note]`, `plan`, `crop <id> <aspect> ["title"]`, `title <id> "text"`, `approve <id>`, `reject <id>`, `handoff <id>`, `remember <text>`, `grid`, `list [query]`. Add a key to .env and this becomes a conversation.';
  history.turns = (history.turns || []).concat([{ at: new Date().toISOString(), user: text, reply, calls: [] }]).slice(-100);
  saveChat(history);
  return { reply, calls: [] };
}

// ---- auto mode -------------------------------------------------------------
// With a key: the agent on the standing prompt from BRAIN.md's "## Auto mode"
// section (or a default). Without: the deterministic pipeline. Either way it
// never hands off unless the threshold says so, and it logs what it did.
export const AUTO_DEFAULT = `Run the studio routine: ingest the inbox; make sure every visible image has a description; propose posts for the instagram feed for anything strong that is not already in a post; put the best proposals on the grid and arrange it; approve only proposals you are confident are ready and plan their times; hand off any post already approved/scheduled if the brain's auto rules allow it. Finish with a short report of what changed.`;

export async function runAuto({ threshold = Number(process.env.POSTBOX_AUTO_THRESHOLD) || 0.85, handoff = process.env.POSTBOX_AUTO_HANDOFF === '1' } = {}) {
  const started = new Date().toISOString();
  let report, calls = [];
  if (hasClaude()) {
    const brain = brainForPrompt();
    const m = /## Auto mode\n([\s\S]*?)(\n## |$)/.exec(brain);
    const prompt = (m ? m[1].trim() : AUTO_DEFAULT) + `\n\nRules for this run: approve only with confidence >= ${threshold}. Handoff is ${handoff ? 'ALLOWED for approved posts' : 'NOT allowed this run — leave posts approved/scheduled'}.`;
    const r = await chatTurn(prompt, { history: { messages: [], turns: [] }, maxIterations: 40 });
    report = r.reply; calls = r.calls;
  } else {
    const steps = [];
    const ing = await runTool('ingest_inbox', { ai: false }); steps.push(`ingested ${ing.added.length} (+${ing.duplicates} dup)`);
    const pr = await runTool('propose_posts', { platform: 'instagram_feed', count: 3 }); steps.push(`proposed ${pr.posts.length}`);
    const g = await runTool('arrange_grid', {}); steps.push(`grid cohesion ${g.score}`);
    const conf = pr.posts.filter(p => (p.confidence ?? 0) >= threshold);
    for (const p of conf) await runTool('update_post', { id: p.id, status: 'approved' });
    if (conf.length) { await runTool('plan_times', {}); steps.push(`approved+planned ${conf.length}`); }
    if (handoff) for (const p of loadPosts().filter(p => p.status === 'scheduled')) { await runTool('hand_off', { id: p.id }); steps.push(`handed off ${p.title}`); }
    report = steps.join(' · ');
    calls = steps.map(s => ({ name: 'pipeline', input: s }));
  }
  fs.appendFileSync(AUTO_LOG, JSON.stringify({ started, finished: new Date().toISOString(), ai: hasClaude(), threshold, handoff, report, calls: calls.length }) + '\n');
  return { report, calls };
}
export function autoLog() { try { return fs.readFileSync(AUTO_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-50); } catch { return []; } }
