// Postbox UI. Plain ES modules, no framework. State is whatever the server
// says; every action round-trips so a refresh never loses anything.

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v ?? '';   // textareas ignore the attribute
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const toast = (msg, ms = 2400) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms); };

const state = { view: 'library', status: null, assets: [], posts: [], grid: { cells: [] }, filter: { project: '', category: '', aspect: '', q: '' }, platform: 'instagram_feed' };

// A stable colour per project so the grid and queue can be read at a glance.
const projectColor = (p) => { let x = 0; for (const c of String(p || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${x % 360} 70% 62%)`; };
const url = (a) => a ? '/library/' + a.file.split('/').map(encodeURIComponent).join('/') : '';
const byId = (id) => state.assets.find(a => a.id === id);
const media = (a, cls = '') => !a ? h('div', { class: cls }) : a.kind === 'video' ? h('video', { src: url(a), muted: true, loop: true, playsinline: true, class: cls, onmouseenter: e => e.target.play(), onmouseleave: e => e.target.pause() }) : a.kind === 'image' ? h('img', { src: url(a), alt: a.altText || a.title, loading: 'lazy', class: cls }) : h('div', { class: cls + ' mono' }, a.kind);
const swatches = (p = []) => h('span', { class: 'swatches' }, p.slice(0, 5).map(c => h('i', { style: `background:${c}`, title: c })));

async function load() {
  const [s, l, p, g] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/library'), api('GET', '/api/posts'), api('GET', '/api/grid')]);
  state.status = s; state.assets = l.assets; state.posts = p.posts; state.grid = g.grid; state.gridRows = g.rows; state.gridScore = g.score;
  $('#status').innerHTML = `ai <b class="${s.ai ? '' : 'off'}">${s.ai ? s.model : 'off'}</b> · ${s.counts.assets} assets · ${s.counts.posts} posts`;
  render();
  extractPalettes();
}

// ---- palette extraction, client side ---------------------------------------
// The server never decodes pixels. Anything with an empty palette gets one
// here from a 40px thumbnail and is patched back, so filtering by colour and
// grid cohesion work with or without the vision model.
const palQueue = new Set();
async function extractPalettes() {
  for (const a of state.assets) if (a.kind === 'image' && !(a.palette && a.palette.length) && !palQueue.has(a.id)) { palQueue.add(a.id); paletteFor(a).catch(() => {}); }
}
async function paletteFor(a) {
  const img = new Image(); img.src = url(a);
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 40;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, 40, 40);
  const d = ctx.getImageData(0, 0, 40, 40).data, buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; buckets.set(k, b);
  }
  const top = [...buckets.values()].sort((x, y) => y.n - x.n);
  const out = [];
  for (const b of top) {
    const rgb = [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round);
    if (out.some(o => Math.hypot(o[0] - rgb[0], o[1] - rgb[1], o[2] - rgb[2]) < 40)) continue;
    out.push(rgb); if (out.length === 5) break;
  }
  const palette = out.map(([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
  a.palette = palette;
  await api('PATCH', '/api/assets/' + a.id, { palette });
  if (state.view === 'library' || state.view === 'grid') render();
}

// ---- views ------------------------------------------------------------------
const views = { library, proposals, grid, queue, brain };
function render() { const m = $('#main'); m.replaceChildren(views[state.view]()); for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.view === state.view); }
$('#nav').addEventListener('click', e => { if (e.target.dataset.view) { state.view = e.target.dataset.view; closeDrawer(); render(); } });

function projectChip(p) { return h('span', { class: 'chip proj', style: `background:${projectColor(p)}` }, p || 'misc'); }

function library() {
  const f = state.filter;
  const projects = [...new Set(state.assets.map(a => a.project))].sort();
  const categories = [...new Set(state.assets.map(a => a.category).filter(Boolean))].sort();
  const list = state.assets.filter(a => (!f.project || a.project === f.project) && (!f.category || a.category === f.category) && (!f.aspect || a.aspect === f.aspect)
    && (!f.q || JSON.stringify([a.title, a.description, a.tags, a.hashtags, a.mood]).toLowerCase().includes(f.q.toLowerCase())));
  const sel = (key, opts, label) => h('select', { onchange: e => { f[key] = e.target.value; render(); } }, h('option', { value: '' }, label), opts.map(o => h('option', { value: o, selected: f[key] === o }, o)));
  return h('div', {},
    h('div', { class: 'bar' },
      h('input', { placeholder: 'search titles, tags, mood…', value: f.q, oninput: e => { f.q = e.target.value; render(); } }),
      sel('project', projects, 'all projects'), sel('category', categories, 'all kinds'), sel('aspect', ['square', 'portrait', 'landscape', 'story'], 'any shape'),
      h('span', { class: 'muted' }, `${list.length} of ${state.assets.length}`),
      h('span', { class: 'grow' }),
      h('button', { onclick: ingest }, 'Ingest inbox/'),
      h('button', { onclick: () => $('#file').click() }, 'Add files…'),
      h('input', { id: 'file', type: 'file', multiple: true, hidden: true, onchange: e => upload([...e.target.files]) }),
    ),
    list.length ? h('div', { class: 'tiles' }, list.map(tile)) : h('div', { class: 'empty' }, 'Nothing here yet. Drop files anywhere on this page, or put them in inbox/ and press Ingest.'),
  );
}

function tile(a, opts = {}) {
  return h('div', { class: 'tile' + (a.hidden ? ' hidden-asset' : ''), draggable: true, 'data-id': a.id, title: a.title,
    ondragstart: e => e.dataTransfer.setData('text/asset', a.id), onclick: () => opts.onclick ? opts.onclick(a) : openAsset(a) },
    h('div', { class: 'thumb' }, media(a)),
    a.rating ? h('span', { class: 'rating' }, '★' + a.rating) : null,
    h('div', { class: 'meta' }, h('div', { class: 't' }, a.title), h('div', {}, projectChip(a.project), h('span', { class: 'chip' }, a.aspect), swatches(a.palette))),
  );
}

function openAsset(a) {
  const d = $('#drawer'); d.hidden = false;
  const field = (label, key, multi) => h('div', {}, h('label', {}, label), multi ? h('textarea', { value: a[key] || '', onchange: e => patch({ [key]: e.target.value }) }) : h('input', { value: Array.isArray(a[key]) ? a[key].join(', ') : (a[key] || ''), onchange: e => patch({ [key]: Array.isArray(a[key]) ? e.target.value.split(/[,\s]+/).filter(Boolean) : e.target.value }) }));
  const patch = async (p) => { Object.assign(a, (await api('PATCH', '/api/assets/' + a.id, p)).asset); render(); };
  d.replaceChildren(
    h('div', { class: 'row' }, h('button', { onclick: closeDrawer }, '← back'), h('span', { class: 'grow' }), h('span', { class: 'mono muted' }, `${a.width}×${a.height} · ${a.aspect} · ${(a.bytes / 1024).toFixed(0)} KB · ${a.analyzedBy}`)),
    h('div', { class: 'preview' }, media(a)),
    h('div', { class: 'row' }, projectChip(a.project), h('span', { class: 'chip' }, a.category || a.kind), swatches(a.palette), h('span', { class: 'grow' }),
      h('span', { class: 'stars' }, [1, 2, 3, 4, 5].map(n => h('button', { class: a.rating >= n ? 'on' : '', onclick: () => patch({ rating: a.rating === n ? null : n }) }, '★')))),
    field('Title', 'title'), field('Description', 'description', true), field('Alt text', 'altText'), field('Project', 'project'), field('Tags', 'tags'), field('Hashtags', 'hashtags'), field('Mood', 'mood'),
    a.postIdea ? h('p', { class: 'muted' }, '💡 ', a.postIdea) : null,
    a.source ? h('p', { class: 'mono muted' }, `from ${a.source.repo}/${a.source.path}`) : null,
    a.analyzeError ? h('p', { class: 'problems' }, a.analyzeError) : null,
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'primary', onclick: () => addToGrid(a.id) }, 'Add to grid'),
      h('button', { onclick: () => quickPost(a) }, 'Make a post'),
      h('button', { onclick: async () => { toast('Analysing…'); try { Object.assign(a, (await api('POST', `/api/assets/${a.id}/analyze`)).asset); openAsset(a); render(); toast(a.analyzeError || 'Done'); } catch (e) { toast(e.message); } } }, state.status?.ai ? 'Re-analyse with AI' : 'Re-analyse (no key)'),
      h('button', { onclick: () => patch({ hidden: !a.hidden }) }, a.hidden ? 'Unhide' : 'Hide'),
      h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this file from the library?')) { await api('DELETE', '/api/assets/' + a.id); closeDrawer(); load(); } } }, 'Delete'),
    ),
  );
}
function closeDrawer() { $('#drawer').hidden = true; }

async function quickPost(a) {
  const post = { platform: state.platform, project: a.project, assets: [a.id], cover: a.id, title: a.title, caption: a.description || a.title, hashtags: a.hashtags || [], rationale: 'Made by hand from the library.', generatedBy: 'you' };
  await api('POST', '/api/posts', post); closeDrawer(); state.view = 'proposals'; load(); toast('Post drafted');
}
async function addToGrid(id) { if (!state.grid.cells.includes(id)) { state.grid.cells.unshift(id); await api('PUT', '/api/grid', state.grid); } state.view = 'grid'; closeDrawer(); load(); }

async function ingest() { toast('Ingesting…', 60000); try { const r = await api('POST', '/api/ingest', {}); toast(`${r.added.length} added, ${r.skipped.length} duplicates`); load(); } catch (e) { toast(e.message); } }
async function upload(files) {
  let n = 0;
  for (const f of files) { toast(`Uploading ${f.name} (${++n}/${files.length})…`, 60000); await fetch(`/api/upload?name=${encodeURIComponent(f.name)}${state.filter.project ? '&project=' + encodeURIComponent(state.filter.project) : ''}`, { method: 'PUT', body: f }); }
  toast(`${files.length} added`); load();
}

// ---- proposals ------------------------------------------------------------
function proposals() {
  const P = state.status.platforms;
  const list = state.posts.filter(p => p.status !== 'published').sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  let note = '';
  return h('div', {},
    h('div', { class: 'bar' },
      h('select', { onchange: e => state.platform = e.target.value }, Object.entries(P).map(([k, v]) => h('option', { value: k, selected: state.platform === k }, v.label))),
      h('input', { placeholder: 'direction, e.g. "launch week for Peggy, lead with the hook swing"', style: 'min-width:320px', oninput: e => note = e.target.value }),
      h('button', { class: 'primary', onclick: async () => { toast(state.status.ai ? 'Asking the model…' : 'Proposing (heuristics)…', 60000); try { const r = await api('POST', '/api/propose', { platform: state.platform, count: 4, note }); toast(`${r.posts.length} proposed · ${r.available} assets still free`); load(); } catch (e) { toast(e.message); } } }, 'Propose 4 posts'),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, state.status.ai ? '' : 'No ANTHROPIC_API_KEY: captions come from the heuristics. Add a key to .env for the real thing.'),
    ),
    list.length ? h('div', { class: 'cards' }, list.map(card)) : h('div', { class: 'empty' }, 'No proposals yet. Pick a platform and press Propose.'),
  );
}

function card(p) {
  const cover = byId(p.cover) || byId(p.assets[0]);
  const P = state.status.platforms[p.platform] || {};
  let edited = false, regenNote = '';
  const cap = h('textarea', { value: p.caption || '', oninput: e => { p.caption = e.target.value; edited = true; } });
  const tags = h('input', { value: (p.hashtags || []).join(' '), oninput: e => { p.hashtags = e.target.value.split(/\s+/).filter(Boolean); edited = true; } });
  const decide = async (decision) => { await api('POST', `/api/posts/${p.id}/decide`, { decision, edits: { caption: p.caption, hashtags: p.hashtags }, edited, note: regenNote }); load(); toast(decision === 'approve' ? 'Approved → queue' : 'Rejected (logged to brain)'); };
  return h('div', { class: 'card ' + p.status },
    h('div', { class: 'cover' }, media(cover), h('span', { class: 'platform' }, P.label || p.platform), p.confidence != null ? h('span', { class: 'conf' }, Math.round(p.confidence * 100) + '%') : null),
    p.assets.length > 1 ? h('div', { class: 'strip' }, p.assets.map(id => { const a = byId(id); return a ? h('img', { src: url(a), class: id === p.cover ? 'cover' : '', title: 'make cover', onclick: async () => { p.cover = id; await api('POST', '/api/posts', p); load(); } }) : null; })) : null,
    h('div', { class: 'body' },
      h('div', { class: 'row' }, h('h3', {}, p.title), h('span', { class: 'grow' }), projectChip(p.project), h('span', { class: 'chip' }, p.status)),
      p.hook ? h('div', { class: 'muted' }, '🪝 ', p.hook) : null,
      cap, tags,
      h('div', { class: 'rationale' }, p.rationale, p.theme ? ` · ${p.theme}` : '', p.generatedBy ? ` · by ${p.generatedBy}` : ''),
      p.problems?.length ? h('div', { class: 'problems' }, p.problems.join(' · ')) : null,
      p.scheduledAt ? h('div', { class: 'mono muted' }, '⏰ ' + new Date(p.scheduledAt).toLocaleString()) : null,
      h('input', { placeholder: 'note for regenerate / why rejected (feeds the brain)', oninput: e => regenNote = e.target.value }),
      h('div', { class: 'actions' },
        p.status === 'proposed' || p.status === 'rejected' ? h('button', { class: 'primary small', onclick: () => decide('approve') }, 'Approve') : null,
        p.status !== 'rejected' ? h('button', { class: 'small', onclick: () => decide('reject') }, 'Reject') : null,
        h('button', { class: 'small', onclick: async () => { toast('Regenerating…', 60000); await api('POST', `/api/posts/${p.id}/regenerate`, { note: regenNote }); load(); toast('Regenerated'); } }, 'Regenerate'),
        h('button', { class: 'small', onclick: () => { for (const id of p.assets) if (!state.grid.cells.includes(id)) state.grid.cells.unshift(id); api('PUT', '/api/grid', state.grid).then(() => toast('Added to grid')); } }, 'To grid'),
        h('button', { class: 'small', onclick: async () => { const r = await api('POST', `/api/posts/${p.id}/publish`, { dryRun: true }); toast(`Dry run → ${r.dir}${r.payload.problems.length ? ' · ' + r.payload.problems.join('; ') : ''}`, 5000); load(); } }, 'Dry run'),
        h('button', { class: 'small danger', onclick: async () => { await api('DELETE', '/api/posts/' + p.id); load(); } }, '✕'),
      ),
    ),
  );
}

// ---- grid -----------------------------------------------------------------
function grid() {
  const cells = state.grid.cells;
  const rows = []; for (let i = 0; i < Math.max(cells.length, 9); i += 3) rows.push([0, 1, 2].map(j => cells[i + j] || null));
  const rowInfo = state.gridRows || [];
  const save = async () => { await api('PUT', '/api/grid', state.grid); const g = await api('GET', '/api/grid'); state.gridRows = g.rows; state.gridScore = g.score; render(); };
  const dropOn = (index) => (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/asset'); if (!id) return;
    const from = cells.indexOf(id);
    if (from >= 0) { cells.splice(from, 1); cells.splice(Math.min(index, cells.length), 0, id); }
    else cells.splice(Math.min(index, cells.length), 0, id);
    save();
  };
  const cell = (id, index) => {
    const a = byId(id);
    return h('div', { class: 'cell' + (a ? '' : ' empty'), draggable: Boolean(a), ondragstart: e => a && e.dataTransfer.setData('text/asset', a.id),
      ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('over'); }, ondragleave: e => e.currentTarget.classList.remove('over'), ondrop: dropOn(index), onclick: () => a && openAsset(a) },
      a ? media(a) : null, a ? h('i', { class: 'tag', style: `background:${projectColor(a.project)}` }) : null,
      a ? h('button', { class: 'x', onclick: e => { e.stopPropagation(); cells.splice(cells.indexOf(id), 1); save(); } }, '✕') : null);
  };
  const inGrid = new Set(cells);
  const pool = state.assets.filter(a => !a.hidden && !inGrid.has(a.id) && (a.kind === 'image' || a.kind === 'video'));
  return h('div', {},
    h('div', { class: 'bar' },
      h('button', { class: 'primary', onclick: async () => { const r = await api('POST', '/api/grid/arrange', {}); state.grid.cells = r.cells; state.gridRows = r.rows; state.gridScore = r.score; render(); toast(`Arranged · cohesion ${r.score}`); } }, 'Auto-arrange rows of three'),
      h('button', { onclick: async () => { const ids = pool.slice(0, 9).map(a => a.id); state.grid.cells.unshift(...ids); await save(); } }, 'Fill with 9 newest'),
      h('button', { onclick: async () => { if (confirm('Clear the grid?')) { state.grid.cells = []; await save(); } } }, 'Clear'),
      h('span', { class: 'grow' }),
      h('span', { class: 'mono muted' }, `cohesion ${state.gridScore ?? 0} · ${cells.length} cells`),
    ),
    h('div', { class: 'gridwrap' },
      h('div', { class: 'phone' },
        h('div', { class: 'head' }, h('div', { class: 'avatar' }), h('div', {}, h('b', {}, 'colinwillow'), h('small', {}, 'planned grid · newest first · drag to reorder'))),
        rows.map((r, ri) => [
          h('div', { class: 'rowscore' }, h('div', {}, rowInfo[ri] ? `row ${ri + 1} · cohesion ${rowInfo[ri].cohesion}` : '')),
          h('div', { class: 'igrid' }, r.map((id, j) => cell(id, ri * 3 + j))),
        ]),
      ),
      h('div', { class: 'side' }, h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Drag from here into the grid'),
        h('div', { class: 'tiles' }, pool.map(a => tile(a, { onclick: () => { cells.unshift(a.id); save(); } })))),
    ),
  );
}

// ---- queue ----------------------------------------------------------------
function queue() {
  const list = state.posts.filter(p => ['approved', 'scheduled', 'published'].includes(p.status)).sort((a, b) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9'));
  const days = []; const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) { const d = new Date(start); d.setDate(d.getDate() + i); days.push(d); }
  return h('div', {},
    h('div', { class: 'bar' },
      h('button', { class: 'primary', onclick: async () => { await api('POST', '/api/schedule', {}); load(); toast('Times planned'); } }, 'Plan times for approved posts'),
      h('button', { onclick: async () => { await api('POST', '/api/schedule', { reset: true }); load(); } }, 'Re-plan everything'),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, `cadence ${state.status.cadence.perWeek}/week · ${state.status.cadence.minGapHours}h min gap · dry-run only until an adapter is wired`),
    ),
    h('div', { class: 'week' }, days.map(d => h('div', { class: 'day' }, h('b', {}, d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })),
      list.filter(p => p.scheduledAt && new Date(p.scheduledAt).toDateString() === d.toDateString()).map(p => h('span', { class: 'pip', style: `background:${projectColor(p.project)}`, title: p.title }, `${new Date(p.scheduledAt).getHours()}:00 ${p.title}`))))),
    list.length ? h('div', { class: 'timeline' }, list.map(p => { const c = byId(p.cover); return h('div', { class: 'slot' },
      h('div', { class: 'when' }, p.scheduledAt ? new Date(p.scheduledAt).toLocaleString() : 'unscheduled', h('small', {}, `${state.status.platforms[p.platform]?.label || p.platform} · ${p.status}`)),
      c ? h('img', { src: url(c) }) : h('div'),
      h('div', {}, h('b', {}, p.title), h('div', { class: 'muted' }, (p.caption || '').slice(0, 120)), p.problems?.length ? h('div', { class: 'problems' }, p.problems.join(' · ')) : null),
      h('div', { class: 'row act' },
        h('input', { type: 'datetime-local', value: p.scheduledAt ? new Date(p.scheduledAt).toISOString().slice(0, 16) : '', onchange: async e => { await api('POST', '/api/posts', { ...p, scheduledAt: new Date(e.target.value).toISOString(), status: 'scheduled' }); load(); } }),
        h('button', { class: 'small', onclick: async () => { const r = await api('POST', `/api/posts/${p.id}/publish`, { dryRun: true }); toast(`Dry run written to ${r.dir}`, 4000); load(); } }, 'Dry run'),
        h('button', { class: 'small', onclick: async () => { await api('POST', '/api/posts', { ...p, status: 'proposed', scheduledAt: null }); load(); } }, 'Back to proposals'),
      )); })) : h('div', { class: 'empty' }, 'Approve a proposal and it lands here.'),
  );
}

// ---- brain ----------------------------------------------------------------
function brain() {
  const ta = h('textarea');
  api('GET', '/api/brain').then(r => ta.value = r.text);
  return h('div', { class: 'brain' },
    h('div', { class: 'bar' }, h('button', { class: 'primary', onclick: async () => { await api('PUT', '/api/brain', { text: ta.value }); toast('Saved'); } }, 'Save BRAIN.md'), h('span', { class: 'muted' }, 'Every AI call reads this. Approvals, rejections and notes append to the log at the bottom.')),
    ta);
}

// ---- drag & drop upload anywhere -------------------------------------------
let dragDepth = 0;
document.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
document.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; upload([...e.dataTransfer.files]); } });

load().catch(e => { $('#main').textContent = 'Could not reach the server: ' + e.message; });
