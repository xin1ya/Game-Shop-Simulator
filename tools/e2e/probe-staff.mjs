import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8459;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.glb':'model/gltf-binary','.png':'image/png' };
const server = http.createServer(async (req,res)=>{
  let p = decodeURIComponent(new URL(req.url,'http://x').pathname); if(p==='/')p='/index.html';
  const f = path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!existsSync(f)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'});
  res.end(await readFile(f));
});
await new Promise(r=>server.listen(PORT,r));
const browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox','--window-size=1360,860'],defaultViewport:{width:1360,height:860}});
const page = await browser.newPage();
page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,300)));
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.BGS && document.querySelector('button[data-k="new"]'),{timeout:30000});
await page.click('button[data-k="new"]');
await page.waitForSelector('[data-k="mall"]',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
mkdirSync(SHOTS,{recursive:true});
// 雇齐四岗 + 备点货 + 上架商品（有货才有顾客行为）
await page.evaluate(async ()=>{
  const S = await import('./src/sim/staff.js');
  const L = await import('./src/sim/logistics.js');
  const E = await import('./src/sim/economy.js');
  const R = await import('./src/rng.js');
  const gs = window.BGS.gs;
  gs.cash += 20000;
  const rng = R.createRng(7);
  S.hire(gs, rng, 'cashier'); S.hire(gs, rng, 'stocker'); S.hire(gs, rng, 'guide'); S.hire(gs, rng, 'host');
  E.restock(gs, { boba_tea: 8, cat_cafe: 8, dice_keychain: 9 }, null);
  L.grantStock(gs, 'boba_tea', 'onShelf', 4);
  L.grantStock(gs, 'cat_cafe', 'onShelf', 4);
  L.grantStock(gs, 'dice_keychain', 'onShelf', 9);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
// 提前开门进 OPEN（O 键）
await page.keyboard.press('KeyO');
await page.waitForFunction(()=>window.BGS.gs.phase==='OPEN',{timeout:8000}).catch(()=>{});
for (let i=0;i<4;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
// OPEN 跑 12 秒：顾客进店 + 员工走位
await page.keyboard.press('KeyV');
await page.evaluate(()=>{ window.BGS.managerPos.x = 0; window.BGS.managerPos.z = 0.5; });
await new Promise(r=>setTimeout(r,12000));
await page.screenshot({ path: path.join(SHOTS,'staff_open.png') });
const st = await page.evaluate(()=>({
  phase: window.BGS.gs.phase,
  customers: window.BGS.session.customers.length,
  staff: window.BGS.gs.staff.members.map((m)=>({role:m.role, duty:m.onDutyToday})),
}));
console.log('[staff]', JSON.stringify(st));
await browser.close(); server.close();
console.log('[probe-staff] done');
