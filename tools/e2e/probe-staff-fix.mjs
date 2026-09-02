import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8460;
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
// 雇收银员 + 开门进 PREP（让员工实体出现）
await page.evaluate(async ()=>{
  const S = await import('./src/sim/staff.js');
  const R = await import('./src/rng.js');
  window.BGS.gs.cash += 20000;
  S.hire(window.BGS.gs, R.createRng(7), 'cashier');
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await new Promise(r=>setTimeout(r,1500)); // 员工走到收银台
const info1 = await page.evaluate(()=>{
  const ents = [...window.BGS.director.entities.entries()]
    .filter(([k]) => String(k).startsWith('staff-'))
    .map(([k, e]) => ({ k, x: +e.group.position.x.toFixed(2), z: +e.group.position.z.toFixed(2) }));
  const p = window.BGS.shopCtx.positions;
  return { ents, checkout: { x: p.checkout.x, z: p.checkout.z } };
});
console.log('[staffFix] 初始=', JSON.stringify(info1));
// 布局模式：拖收银台到 (0, 1.0)（sim 直写 + rebuild，等价于拖放确认）
await page.evaluate(async ()=>{
  const L = await import('./src/sim/layout.js');
  L.moveLayoutPiece(window.BGS.gs, 'checkout', 0, 0, 1.0);
  window.BGS.shopCtx.rebuild(window.BGS.gs);
});
await new Promise(r=>setTimeout(r,2500)); // 员工走向新收银台
const info2 = await page.evaluate(()=>{
  const ents = [...window.BGS.director.entities.entries()]
    .filter(([k]) => String(k).startsWith('staff-'))
    .map(([k, e]) => ({ k, x: +e.group.position.x.toFixed(2), z: +e.group.position.z.toFixed(2) }));
  const p = window.BGS.shopCtx.positions;
  return { ents, checkout: { x: p.checkout.x, z: p.checkout.z } };
});
console.log('[staffFix] 移动后=', JSON.stringify(info2));
const ok = info2.checkout.x === 0 && info2.ents.length > 0
  && Math.abs(info2.ents[0].x - 0) < 0.6 && Math.abs(info2.ents[0].z - 1.9) < 0.6;
console.log('[staffFix] 收银员跟随新吧台 =', ok);
if (!ok) throw new Error('收银员未跟随新吧台位置');
await page.screenshot({ path: path.join(SHOTS,'staff_fix.png') });
await browser.close(); server.close();
console.log('[probe-staff-fix] ok');
