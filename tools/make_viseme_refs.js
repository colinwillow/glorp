const { chromium } = require('playwright');
const RIG = {
  rest: {}, MBP: { V_Explosive:1.0, Mouth_Close:0.60, Mouth_Press_L:0.40, Mouth_Press_R:0.40 },
  FV: { V_Dental_Lip:1.0 }, E: { V_Wide:0.88 }, AI: { V_Open:0.90, V_Lip_Open:0.35 },
  O: { V_Tight_O:0.92 }, U: { V_Tight_O:0.55, V_Tight:0.60 }, WQ: { V_Tight:0.95 },
  L: { V_Lip_Open:0.50, V_Tongue_Raise:0.70, V_Tongue_Out:0.20 }, etc: { V_Affricate:0.80 } };
const JAW = { rest:0.02, MBP:0, FV:0.06, E:0.30, AI:0.85, O:0.55, U:0.22, WQ:0.14, L:0.45, etc:0.28 };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1000, height: 820 }, deviceScaleFactor: 2 });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8931/face-test.html');
  await p.waitForTimeout(13000);
  await p.selectOption('#model', 'toon_base.glb'); await p.waitForTimeout(9000);
  await p.click('#pose'); await p.waitForTimeout(500);
  const labels = await p.$$eval('#sliders div', d => d.map(x => x.textContent.trim().split(' ')[0]));
  console.log('sliders found:', labels.length);
  const clip = { x: 330, y: 210, width: 340, height: 300 };
  for (const sh in RIG) {
    const pairs = [[0, JAW[sh]]];
    for (const k in RIG[sh]) { const i = labels.indexOf(k); if (i > 0) pairs.push([i, RIG[sh][k]]); }
    await p.$$eval('#sliders input', (els, a) => {
      els.forEach(e => { e.value = 0; e.dispatchEvent(new Event('input')); });
      for (const [i, v] of a) { els[i].value = v; els[i].dispatchEvent(new Event('input')); }
    }, pairs);
    await p.waitForTimeout(700);
    await p.screenshot({ path: 'ref_' + sh + '.png', clip });
    console.log('  ' + sh.padEnd(5) + Object.keys(RIG[sh]).join(', ') || '(neutral)');
  }
  await b.close();
})();
