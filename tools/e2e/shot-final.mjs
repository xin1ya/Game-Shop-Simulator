import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8451;
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
mkdirSync(SHOTS,{recursive:true});
await page.screenshot({ path: path.join(SHOTS,'final_title.png') }); // 标题（含下载链接 + Enter 标注）
await page.click('button[data-k="new"]');
await page.waitForSelector('[data-k="mall"]',{timeout:10000});
// 剧情弹窗先清掉（遮挡商城返回/开始备货按钮）
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.screenshot({ path: path.join(SHOTS,'final_morning.png') }); // 晨间（扩张行 + kbd 标注）
await page.click('[data-k="mall"]');
await page.waitForSelector('.mall-grid',{timeout:5000});
await new Promise(r=>setTimeout(r,500));
await page.screenshot({ path: path.join(SHOTS,'final_mall.png') });
await page.click('[data-k="close"]');
await new Promise(r=>setTimeout(r,300));
await page.evaluate(async ()=>{
  const E = await import('./src/sim/economy.js');
  window.BGS.gs.cash += 20000; // 保证进货 + 收购右邻铺（6000）现金充足
  E.restock(window.BGS.gs, { dice_tower: 8, boba_tea: 4, cat_cafe: 8, gem_trader: 4 }, null);
  if (!E.buyExpansion(window.BGS.gs, 'wing_right')) throw new Error('buyExpansion wing_right failed');
  window.BGS.shopCtx.rebuild(window.BGS.gs);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV');
// 次日到货（dropZone 堆叠区）
await page.evaluate(async ()=>{ const L = await import('./src/sim/logistics.js'); window.BGS.gs.day += 1; L.startDeliveries(window.BGS.gs); });
await new Promise(r=>setTimeout(r,9500));
// 货架托盘陈列（店长站货架前）
await page.evaluate(()=>{
  window.BGS.managerPos.x = 0; window.BGS.managerPos.z = -1.2;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=3.4; cam.bottom=-3.4; cam.left=-3.4*a; cam.right=3.4*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,500));
await page.screenshot({ path: path.join(SHOTS,'final_shelves_trays.png') });
// dropZone 堆叠区特写
await page.evaluate(()=>{
  window.BGS.managerPos.x = 7.9; window.BGS.managerPos.z = 4.2;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=2.4; cam.bottom=-2.4; cam.left=-2.4*a; cam.right=2.4*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'final_dropzone.png') });
// 翼房体验区
await page.evaluate(()=>{
  window.BGS.managerPos.x = 9.3; window.BGS.managerPos.z = -0.6;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=5.2; cam.bottom=-5.2; cam.left=-5.2*a; cam.right=5.2*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'final_wing.png') });
// 全街步行 + 红绿灯/车流（店长站马路中）
await page.evaluate(async ()=>{
  const D = await import('./src/sim/day.js');
  const R = await import('./src/rng.js');
  D.startOpenSession(window.BGS.gs, R.createRng(7), null);
  window.BGS.managerPos.x = 2.6; window.BGS.managerPos.z = 10.8;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=5.5; cam.bottom=-5.5; cam.left=-5.5*a; cam.right=5.5*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,1000));
await page.screenshot({ path: path.join(SHOTS,'final_street_full.png') });
await browser.close(); server.close();
console.log('[shot-final] done');
