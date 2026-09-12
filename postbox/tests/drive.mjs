import { chromium } from 'playwright';
// Browser smoke test: drives the real UI against a running server (npm start)
// and screenshots every view into tests/shots/. Not part of `npm test`.
//   PW_EXEC=/path/to/chromium node tests/drive.mjs   (PW_EXEC optional)
import fs from 'node:fs';
const out = (process.env.SHOTS || new URL('./shots/', import.meta.url).pathname);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(process.env.PW_EXEC ? { executablePath: process.env.PW_EXEC } : {});
const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: out + n + '.png' });
const nav = async (v) => { await page.click(`#nav button[data-view="${v}"]`); await page.waitForTimeout(400); };

await page.goto('http://localhost:8140/'); await page.waitForTimeout(1500);
await shot('1-library');
// open a drawer
await page.click('.tile'); await page.waitForTimeout(300); await shot('2-drawer');
await page.click('#drawer button:has-text("back")');
// proposals
await nav('proposals');
await page.click('button:has-text("Propose 4 posts")'); await page.waitForTimeout(1200);
await shot('3-proposals');
const approve = page.locator('button:has-text("Approve")');
const n = await approve.count(); console.log('proposals', n);
await approve.nth(0).click(); await page.waitForTimeout(500);
await page.locator('button:has-text("Approve")').nth(0).click(); await page.waitForTimeout(500);
await page.locator('button:has-text("Regenerate")').nth(0).click(); await page.waitForTimeout(800);
// queue
await nav('queue');
await page.click('button:has-text("Plan times")'); await page.waitForTimeout(800);
await page.locator('button:has-text("Dry run")').nth(0).click(); await page.waitForTimeout(800);
await shot('4-queue');
// grid
await nav('grid');
await page.click('button:has-text("Fill with 9 newest")'); await page.waitForTimeout(600);
await page.click('button:has-text("Auto-arrange")'); await page.waitForTimeout(800);
await shot('5-grid');
await nav('brain'); await page.waitForTimeout(500); await shot('6-brain');
// compose panel in the drawer
await nav('library'); await page.click('.tile'); await page.waitForTimeout(300);
await page.fill('.compose input[placeholder]', 'Foundry'); await page.waitForTimeout(700); await shot('7-compose');
await page.click('.compose button:has-text("Save as new asset")'); await page.waitForTimeout(1500);
await page.click('#drawer button:has-text("back")');
// chat panel: offline commands go through the tool registry
await page.click('#chatToggle'); await page.waitForTimeout(300);
await page.fill('#chatText', 'fill 6'); await page.press('#chatText', 'Enter'); await page.waitForTimeout(1200);
await page.fill('#chatText', 'grid'); await page.press('#chatText', 'Enter'); await page.waitForTimeout(1200);
await nav('grid'); await page.waitForTimeout(400); await shot('8-chat');
await nav('auto'); await page.click('button:has-text("Run auto now")'); await page.waitForTimeout(3000); await shot('9-auto');
console.log('errors:', errors);
await b.close();
