import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8446;
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
await page.keyboard.press('KeyV');
mkdirSync(SHOTS,{recursive:true});
// 手持骰塔 + 店长在街上看门脸（验证双手抱起 + 横梁 + 邻铺红线）
await page.evaluate(()=>{
  window.BGS.session.carry = { skuId: 'dice_tower', qty: 2 };
  window.BGS.managerPos.x = 2.0; window.BGS.managerPos.z = 7.6;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=4.2; cam.bottom=-4.2; cam.left=-4.2*a; cam.right=4.2*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,700));
await page.screenshot({ path: path.join(SHOTS,'facade_carry.png') });
// 左邻铺（咖啡馆红线对齐）
await page.evaluate(()=>{ window.BGS.managerPos.x = -6.0; window.BGS.managerPos.z = 7.6; });
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'facade_left.png') });
await browser.close(); server.close();
console.log('[shot-facade] done');
