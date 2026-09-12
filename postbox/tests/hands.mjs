// Checks for the hands: image edits on real files, the tool registry run
// directly, the Discord handoff against a local fake, and the offline chat.
// Uses a scratch copy of the library so nothing here touches the real one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const real = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postbox-'));
for (const d of ['inbox', 'library', 'outbox']) fs.mkdirSync(path.join(tmp, d));
fs.cpSync(path.join(real, 'library'), path.join(tmp, 'library'), { recursive: true });
fs.copyFileSync(path.join(real, 'BRAIN.md'), path.join(tmp, 'BRAIN.md'));

// Point env.js at the scratch root before anything imports it.
const envSrc = fs.readFileSync(path.join(real, 'server/env.js'), 'utf8').replace("path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')", JSON.stringify(tmp));
fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });
for (const f of fs.readdirSync(path.join(real, 'server'))) { const p = path.join(real, 'server', f); if (fs.statSync(p).isDirectory()) fs.cpSync(p, path.join(tmp, 'server', f), { recursive: true }); else fs.copyFileSync(p, path.join(tmp, 'server', f)); }
fs.writeFileSync(path.join(tmp, 'server/env.js'), envSrc);
fs.symlinkSync(path.join(real, 'node_modules'), path.join(tmp, 'node_modules'));
delete process.env.ANTHROPIC_API_KEY; delete process.env.DISCORD_WEBHOOK_URL;

const { runTool, TOOLS } = await import(path.join(tmp, 'server/tools.js'));
const { renderEdit, overlaySVG } = await import(path.join(tmp, 'server/edit.js'));
const { sendToDiscord, renderMessage } = await import(path.join(tmp, 'server/discord.js'));
const { chatTurn, runAuto } = await import(path.join(tmp, 'server/chat.js'));
const { loadAssets, loadPosts, loadGrid } = await import(path.join(tmp, 'server/store.js'));

let n = 0; const check = async (name, fn) => { try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

const assets = loadAssets();
const square = assets.find(a => a.aspect === 'square' && a.kind === 'image');
const wide = assets.find(a => a.aspect === 'landscape' && a.kind === 'image');
assert.ok(square && wide, 'the seed library needs a square and a landscape image');

await check('crop to portrait gives exactly 1080x1350', async () => { const r = await renderEdit(path.join(tmp, 'library', square.file), { aspect: 'portrait' }); assert.equal(r.width, 1080); assert.equal(r.height, 1350); });
await check('crop to story from a landscape gives 9:16', async () => { const r = await renderEdit(path.join(tmp, 'library', wide.file), { aspect: 'story' }); assert.equal(r.width, 1080); assert.equal(r.height, 1920); });
await check('pad keeps the whole image at the target size', async () => { const r = await renderEdit(path.join(tmp, 'library', wide.file), { aspect: 'square', pad: true, background: '#000' }); assert.equal(r.width, 1080); assert.equal(r.height, 1080); });
await check('a title overlay changes the pixels', async () => {
  const plain = await renderEdit(path.join(tmp, 'library', square.file), { aspect: 'square' });
  const titled = await renderEdit(path.join(tmp, 'library', square.file), { aspect: 'square', title: 'Foundry', subtitle: 'robits' });
  assert.notEqual(plain.buffer.toString('base64'), titled.buffer.toString('base64'));
});
await check('overlay wraps long titles and escapes markup', async () => {
  const svg = overlaySVG({ width: 1080, height: 1080, title: 'A very long title that will certainly need to wrap onto a second line <b>', size: 0.08 });
  assert.ok((svg.match(/<text/g) || []).length >= 2, 'should wrap'); assert.ok(svg.includes('&lt;b&gt;'));
});

await check('edit_image tool files a derived asset next to the source', async () => {
  const r = await runTool('edit_image', { id: square.id, aspect: 'portrait', title: 'Test', label: 'cover' });
  assert.equal(r.aspect, 'portrait'); assert.equal(r.derivedFrom, square.id); assert.equal(r.project, square.project);
  assert.ok(fs.existsSync(path.join(tmp, 'library', loadAssets().find(a => a.id === r.id).file)));
  const again = await runTool('edit_image', { id: square.id, aspect: 'portrait', title: 'Test', label: 'cover' });
  assert.equal(again.id, r.id, 'identical edit is deduped by hash');
});
await check('arrange_grid fills from the library and set_grid drops unknown ids', async () => {
  const g = await runTool('arrange_grid', { fillTo: 6 }); assert.equal(g.cells.length, 6); assert.equal(g.rows.length, 2);
  const s = await runTool('set_grid', { cells: [square.id, 'nope', wide.id] }); assert.deepEqual(s.cells, [square.id, wide.id]);
});
await check('create → update → plan → hand_off (dry run) round-trips', async () => {
  const p = await runTool('create_post', { platform: 'x', assets: [wide.id], title: 'Hello', caption: 'A test.', hashtags: ['#a'] });
  assert.equal(p.status, 'proposed');
  const u = await runTool('update_post', { id: p.id, status: 'approved', caption: 'Edited.' }); assert.equal(u.caption, 'Edited.');
  const pl = await runTool('plan_times', {}); assert.ok(pl.scheduled.some(x => x.id === p.id && x.scheduledAt));
  const h = await runTool('hand_off', { id: p.id }); assert.equal(h.dryRun, true); assert.ok(fs.existsSync(path.join(tmp, 'outbox', p.id, 'caption.txt')));
  assert.ok(fs.readFileSync(path.join(tmp, 'BRAIN.md'), 'utf8').includes('approved · x "Hello"'), 'status change is remembered');
});
await check('every tool validates its input', async () => {
  await assert.rejects(runTool('update_asset', { id: square.id, rating: 9 }));
  await assert.rejects(runTool('edit_image', { id: square.id, aspect: 'hexagon' }));
  await assert.rejects(runTool('nope', {}));
  assert.ok(TOOLS.length >= 15);
});

await check('discord handoff posts caption + attachments to the webhook', async () => {
  let got = null;
  const srv = http.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { got = { url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) }; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"123"}'); }); });
  await new Promise(r => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const post = { title: 'Hello', platform: 'x', caption: 'A test.', hashtags: ['#a', '#b'], assets: [wide.id, square.id] };
  const r = await sendToDiscord(post, loadAssets(), { url, platformLabel: 'X' });
  srv.close();
  assert.equal(r.messageId, '123'); assert.equal(r.files, 2);
  assert.ok(got.url.includes('wait=true')); assert.ok(got.type.startsWith('multipart/form-data'));
  const body = got.body.toString('latin1');
  assert.ok(body.includes('payload_json') && body.includes('files[0]') && body.includes('files[1]'));
  assert.ok(body.includes('#a #b'));
  assert.ok(renderMessage(post, loadAssets(), 'X').content.startsWith('**Hello** · X'));
});

await check('offline chat runs commands through the same tools', async () => {
  await runTool('set_grid', { cells: [] });
  const r = await chatTurn('fill 3'); assert.equal(r.calls[0].name, 'arrange_grid'); assert.equal(loadGrid().cells.length, 3);
  const c = await chatTurn(`crop ${square.id} story "Void"`); assert.equal(c.calls[0].name, 'edit_image');
  const rem = await chatTurn('remember never lead with a logo'); assert.ok(fs.readFileSync(path.join(tmp, 'BRAIN.md'), 'utf8').includes('never lead with a logo'));
  const nope = await chatTurn('what do you think of my grid?'); assert.equal(nope.calls.length, 0); assert.ok(/No ANTHROPIC_API_KEY/.test(nope.reply));
});
await check('auto mode (no key) proposes, arranges, and never approves below threshold', async () => {
  const before = loadPosts().filter(p => p.status === 'approved').length;
  const r = await runAuto({ threshold: 0.99, handoff: false });
  assert.ok(/proposed \d+/.test(r.report) && /grid cohesion/.test(r.report));
  assert.equal(loadPosts().filter(p => p.status === 'approved').length, before, 'heuristic posts have no confidence, so nothing auto-approves');
  assert.ok(fs.existsSync(path.join(tmp, 'auto-log.jsonl')));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${n} checks passed${process.exitCode ? ', some FAILED' : ''}`);
