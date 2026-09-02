import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8448;
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
page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,200)));
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.BGS && document.querySelector('button[data-k="new"]'),{timeout:30000});
await page.click('button[data-k="new"]');
await page.waitForSelector('button[data-k="open"]',{timeout:10000});
await page.evaluate(async ()=>{ const E = await import('./src/sim/economy.js'); E.restock(window.BGS.gs, { dice_tower: 4 }, null); });
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV');
await page.evaluate(async ()=>{
  const L = await import('./src/sim/logistics.js');
  window.BGS.gs.day += 1; L.startDeliveries(window.BGS.gs);
});
await new Promise(r=>setTimeout(r,9500));
mkdirSync(SHOTS,{recursive:true});
// 特写取景门口第一个箱
const boxPos = await page.evaluate(()=>{
  const b = window.BGS.gs.logistics.boxes[0];
  window.BGS.managerPos.x = b.x; window.BGS.managerPos.z = b.z + 1.6;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=1.2; cam.bottom=-1.2; cam.left=-1.2*a; cam.right=1.2*a; cam.updateProjectionMatrix();
  return { x: b.x, z: b.z };
});
console.log('box at', JSON.stringify(boxPos));
// SEALED 特写
await new Promise(r=>setTimeout(r,300));
await page.screenshot({ path: path.join(SHOTS,'r3_box_sealed_close.png') });
// 触发开箱，连拍 4 帧（0.15/0.35/0.6/1.0s）
await page.evaluate(async ()=>{
  const I = await import('./src/sim/interaction.js');
  const b = window.BGS.gs.logistics.boxes[0];
  I.beginHold(window.BGS.gs, window.BGS.session, 'unbox', b.id, { x: b.x-1, z: b.z, viewMode: 'iso' });
});
for (const [i, ms] of [150, 350, 600, 1000].entries()) {
  await new Promise(r=>setTimeout(r, i===0?150:ms-[150,350,600,1000][i-1]));
  await page.screenshot({ path: path.join(SHOTS,`r3_open_${i}.png`) });
}
await browser.close(); server.close();
console.log('[shot-open] done');
