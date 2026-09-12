// Captures a running web thing (a game, a web app, a portfolio page) straight
// into inbox/ at feed-friendly sizes. Needs playwright + a chromium:
//   npx playwright install chromium   (once)
//   node tools/screenshot.mjs http://localhost:8123 --project peggy --wait 4000 --sizes square,portrait,story,landscape
// Takes one frame per size. Pass --burst 5 --every 800 to grab a sequence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const target = args.find(a => /^https?:/.test(a));
if (!target) { console.log('usage: node tools/screenshot.mjs <url> [--project name] [--wait ms] [--sizes square,portrait,story,landscape] [--burst n --every ms]'); process.exit(1); }
const project = opt('--project', 'shots');
const wait = Number(opt('--wait', 3000));
const sizes = opt('--sizes', 'square,portrait,landscape').split(',');
const burst = Number(opt('--burst', 1)), every = Number(opt('--every', 800));
const SIZES = { square: [1080, 1080], portrait: [1080, 1350], story: [1080, 1920], landscape: [1600, 900] };

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright is not installed: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const dir = path.join(ROOT, 'inbox', project); fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
for (const s of sizes) {
  const [w, hgt] = SIZES[s] || SIZES.square;
  const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  await page.goto(target, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  for (let i = 0; i < burst; i++) {
    const file = path.join(dir, `${project}-${s}-${stamp}${burst > 1 ? '-' + (i + 1) : ''}.png`);
    await page.screenshot({ path: file });
    fs.writeFileSync(file + '.source.json', JSON.stringify({ repo: project, path: target, size: s }));
    console.log(path.relative(ROOT, file));
    if (i + 1 < burst) await page.waitForTimeout(every);
  }
  await page.close();
}
await browser.close();
console.log('Run: npm run ingest');
