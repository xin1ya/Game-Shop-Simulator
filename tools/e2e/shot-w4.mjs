import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8445;
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
await page.waitForSelector('button[data-k="open"]',{timeout:10000});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
// 提前开门 → OPEN（结账只在 OPEN 推进）
await page.evaluate(()=>{ [...document.querySelectorAll('button')].find(b=>b.textContent.includes('提前开门'))?.click(); });
await page.waitForFunction(()=>window.BGS.gs.phase==='OPEN',{timeout:5000});
await page.keyboard.press('KeyV');
mkdirSync(SHOTS,{recursive:true});

// 注入队首顾客（想买 cat_cafe，¥68）
const order = await page.evaluate(async ()=>{
  const C = await import('./src/sim/customers.js');
  const R = await import('./src/rng.js');
  const D = await import('./src/sim/day.js');
  const gs = window.BGS.gs, session = window.BGS.session;
  const c = C.spawnCustomer(gs, R.createRng(1), 'student');
  c.id = 901; c.state = 'QUEUED'; c.targetSku = 'cat_cafe';
  c.pos = { x: -4.6, z: 1.7 };
  session.customers.push(c);
  session.queue.push(901);
  window.BGS.managerPos.x = -4.6; window.BGS.managerPos.z = 3.6; // 站柜台前
  return D.getCheckoutOrder(gs, session);
});
console.log('[w4] order:', JSON.stringify(order));
await new Promise(r=>setTimeout(r,400));
// 按 F 打开找零面板
await page.keyboard.press('KeyF');
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'w4_change_panel.png') });
// 答错一次
await page.keyboard.press('Digit1');
await page.keyboard.press('Digit2');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,300));
await page.screenshot({ path: path.join(SHOTS,'w4_change_wrong.png') });
// 答对（输入 order.change）
for (const ch of String(order.change)) await page.keyboard.press('Digit'+ch);
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,600));
const after = await page.evaluate(()=>({
  payDone: window.BGS.session.playerPayDone,
  queue: window.BGS.session.queue.length,
  cash: window.BGS.gs.cash,
  changeWrong: window.BGS.session.customers.find(c=>c.id===901)?.changeWrong,
  panelOpen: !!document.querySelector('[data-change]'),
}));
console.log('[w4] after correct:', JSON.stringify(after));
await page.screenshot({ path: path.join(SHOTS,'w4_change_done.png') });
await browser.close(); server.close();
console.log('[shot-w4] done');
