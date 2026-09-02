import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8447;
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
await page.evaluate(async ()=>{
  const E = await import('./src/sim/economy.js');
  E.restock(window.BGS.gs, { dice_tower: 4, boba_tea: 4 }, null);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV');
mkdirSync(SHOTS,{recursive:true});
// 次日货车到店：抓拍在途（卡车应在车道上、车头朝 -x）
await page.evaluate(async ()=>{
  const L = await import('./src/sim/logistics.js');
  window.BGS.gs.day += 1;
  L.startDeliveries(window.BGS.gs);
  window.BGS.managerPos.x = 8.5; window.BGS.managerPos.z = 4.5;
});
await new Promise(r=>setTimeout(r,4500)); // eta 8s 中段
await page.screenshot({ path: path.join(SHOTS,'r3_truck_arriving.png') });
await new Promise(r=>setTimeout(r,5500)); // 到齐落定
// 开箱动画中段：触发 unbox 后 ~0.35s 截
await page.evaluate(async ()=>{
  const I = await import('./src/sim/interaction.js');
  const gs = window.BGS.gs;
  const b = gs.logistics.boxes[0];
  I.beginHold(gs, window.BGS.session, 'unbox', b.id, { x: b.x - 1, z: b.z, viewMode: 'iso' });
});
await new Promise(r=>setTimeout(r,350));
await page.screenshot({ path: path.join(SHOTS,'r3_box_opening_mid.png') });
await new Promise(r=>setTimeout(r,900));
await page.screenshot({ path: path.join(SHOTS,'r3_box_opened.png') });
// 右键抱起整箱 → 库房左键放下
const carryRes = await page.evaluate(async ()=>{
  const I = await import('./src/sim/interaction.js');
  const gs = window.BGS.gs, session = window.BGS.session;
  const b = gs.logistics.boxes.find(x=>x.state==='SEALED');
  if (!b) return 'no sealed box';
  const r1 = I.beginHold(gs, session, 'carryBox', b.id, { x: b.x-1, z: b.z, viewMode: 'iso' });
  const r2 = I.beginHold(gs, session, 'placeBox', 0, { x: -8.6, z: -1, viewMode: 'iso' });
  return { carry: r1, place: r2, boxX: b.x, boxZ: b.z };
});
console.log('[r3] carry/place:', JSON.stringify(carryRes));
// 库房视角看放下的箱子
await page.evaluate(()=>{ window.BGS.managerPos.x = -8.6; window.BGS.managerPos.z = -0.6; });
await new Promise(r=>setTimeout(r,500));
await page.screenshot({ path: path.join(SHOTS,'r3_stockroom_box.png') });
// 打烊整理阶段
await page.evaluate(async ()=>{
  const D = await import('./src/sim/day.js');
  D.startEveningSession(window.BGS.gs, window.BGS.session);
});
await new Promise(r=>setTimeout(r,500));
await page.screenshot({ path: path.join(SHOTS,'r3_evening.png') });
// 街道全景（店长站街上看门脸与邻铺红线）
await page.evaluate(async ()=>{
  const D = await import('./src/sim/day.js');
  const R = await import('./src/rng.js');
  D.startOpenSession(window.BGS.gs, R.createRng(7), null); // 回 OPEN 看行人
  window.BGS.managerPos.x = 0; window.BGS.managerPos.z = 7.4;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=6.2; cam.bottom=-6.2; cam.left=-6.2*a; cam.right=6.2*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,800));
await page.screenshot({ path: path.join(SHOTS,'r3_street.png') });
await browser.close(); server.close();
console.log('[shot-round3] done');
