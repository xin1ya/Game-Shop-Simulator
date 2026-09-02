import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8443;
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
// 晨间先下单（商城外的 sim 直下单，验证次日达）
await page.evaluate(async ()=>{
  const E = await import('./src/sim/economy.js');
  E.restock(window.BGS.gs, { dice_keychain: 8, boba_tea: 4 }, null);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV');
mkdirSync(SHOTS,{recursive:true});

// 推进到次日 → 货车到店落箱
await page.evaluate(async ()=>{
  const L = await import('./src/sim/logistics.js');
  window.BGS.gs.day += 1;
  L.startDeliveries(window.BGS.gs);
});
await new Promise(r=>setTimeout(r,9500)); // eta 8s + 沉降
const boxState = await page.evaluate(()=>window.BGS.gs.logistics.boxes.map(b=>({sku:b.sku,state:b.state,x:+b.x.toFixed(2),z:+b.z.toFixed(2),y:+b.y.toFixed(2),settled:b.settled})));
console.log('[w3] boxes:', JSON.stringify(boxState));
// 手工叠一箱到同点验证堆叠渲染
await page.evaluate(async ()=>{
  const gs = window.BGS.gs;
  const a = gs.logistics.boxes[0];
  if (a) gs.logistics.boxes.push({ id: 9101, deliveryId: 1, sku: 'dice_tower', qty: 2, state: 'SEALED', slot: a.slot, progress: 0, claimedBy: null, claimedKind: null, x: a.x, z: a.z, y: 1.4, vy: 0, settled: false });
  window.BGS.managerPos.x = 2.2; window.BGS.managerPos.z = 6.4;
  const cam = window.BGS.camera; const asp = window.innerWidth/window.innerHeight;
  cam.top=2.6; cam.bottom=-2.6; cam.left=-2.6*asp; cam.right=2.6*asp; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,1200));
await page.screenshot({ path: path.join(SHOTS,'w3_boxes_stack.png') });

// 库房：店长进库房，纸板 5 张 + 后仓有货（货架小样）
await page.evaluate(()=>{
  const gs = window.BGS.gs;
  gs.stockroom.cardboard = 5;
  gs.skus.dice_tower.backroom = 6; gs.skus.boba_tea.backroom = 8;
  window.BGS.managerPos.x = -8.6; window.BGS.managerPos.z = -1;
});
await new Promise(r=>setTimeout(r,600));
await page.screenshot({ path: path.join(SHOTS,'w3_stockroom.png') });
// 门视角（员工门开）
await page.evaluate(()=>{ window.BGS.managerPos.x = -6.2; window.BGS.managerPos.z = -1.0; });
await new Promise(r=>setTimeout(r,700));
await page.screenshot({ path: path.join(SHOTS,'w3_staffdoor_open.png') });

// 手持：店长手上拿骰塔
await page.evaluate(()=>{
  window.BGS.session.carry = { skuId: 'dice_tower', qty: 2 };
  window.BGS.managerPos.x = 0; window.BGS.managerPos.z = 0.6;
});
await new Promise(r=>setTimeout(r,800));
await page.screenshot({ path: path.join(SHOTS,'w3_carry_iso.png') });

// 回收商人
await page.evaluate(()=>{ window.BGS.session.recycler = true; window.BGS.managerPos.x = 4.6; window.BGS.managerPos.z = 5.2; });
await new Promise(r=>setTimeout(r,600));
await page.screenshot({ path: path.join(SHOTS,'w3_recycler.png') });

await browser.close(); server.close();
console.log('[shot-w3] done');
