import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8454;
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
page.on('console',m=>{ const t=m.text(); if(/error|warn/i.test(t)) console.log('[console]',t.slice(0,200)); });
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.BGS && document.querySelector('button[data-k="new"]'),{timeout:30000});
await page.click('button[data-k="new"]');
await page.waitForSelector('[data-k="mall"]',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
mkdirSync(SHOTS,{recursive:true});
await page.evaluate(async ()=>{
  const E = await import('./src/sim/economy.js');
  window.BGS.gs.cash += 20000;
  E.restock(window.BGS.gs, { boba_tea: 8, cat_cafe: 8, dice_tower: 4, dice_keychain: 9 }, null);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await new Promise(r=>setTimeout(r,300));
// ① 第一人称店内（透视相机 + 轮廓线）
await page.screenshot({ path: path.join(SHOTS,'outline_fp.png') });
// ② iso 俯瞰（正交相机 + 轮廓线）
await page.keyboard.press('KeyV');
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'outline_iso.png') });
await browser.close(); server.close();
console.log('[shot-outline] done');
