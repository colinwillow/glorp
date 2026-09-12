// Pulls post-worthy images out of other repos on disk into inbox/, tagged with
// where they came from, so ingest can file them under the right project.
//   node tools/harvest.mjs ../peggy ../robits --min 40000
// Skips icons, favicons, textures, node_modules and vendor folders by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const minBytes = Number(args[args.indexOf('--min') + 1]) || (args.includes('--min') ? 0 : 20000);
const repos = args.filter(a => !a.startsWith('--') && a !== String(minBytes));
const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov']);
const SKIP_DIR = /^(node_modules|vendor|\.git|dist|build|icons?|phonemes|textures?|postbox|inbox|library|outbox|scratchpad)$/;
const SKIP_FILE = /favicon|apple-touch|icon-\d|maskable|hdri|_texture|texture_|\.001\./i;

if (!repos.length) { console.log('usage: node tools/harvest.mjs <repo dir>... [--min bytes]'); process.exit(1); }
let n = 0;
for (const repo of repos) {
  const name = path.basename(path.resolve(repo));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!EXT.has(ext) || SKIP_FILE.test(e.name)) continue;
      const st = fs.statSync(p);
      if (st.size < minBytes) continue;
      const rel = path.relative(repo, p);
      // Keep the real basename so titles read well; only disambiguate on a clash.
      let dest = path.join(ROOT, 'inbox', name, e.name);
      if (fs.existsSync(dest)) dest = path.join(ROOT, 'inbox', name, rel.replace(/[\\/]/g, '__'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p, dest);
      fs.writeFileSync(dest + '.source.json', JSON.stringify({ repo: name, path: rel }));
      n++; console.log(`${name}/${rel}  (${(st.size / 1024).toFixed(0)} KB)`);
    }
  };
  walk(path.resolve(repo));
}
console.log(`${n} files copied into inbox/. Run: npm run ingest`);
