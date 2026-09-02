import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8442;
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
mkdirSync(SHOTS,{recursive:true});
await page.screenshot({ path: path.join(SHOTS,'morning_v3.png') });
await page.click('[data-k="mall"]');
await page.waitForSelector('.mall-grid',{timeout:5000});
await new Promise(r=>setTimeout(r,600));
await page.screenshot({ path: path.join(SHOTS,'mall.png') });
// 加购：第一张卡的 + 两次（=8 件两箱）
await page.click('.mall-card:not(.locked) [data-k="plus"]');
await page.click('.mall-card:not(.locked) [data-k="plus"]');
const cart = await page.evaluate(()=>document.querySelector('[data-k="cartTotal"]').textContent);
console.log('[mall] cart:', cart);
await page.screenshot({ path: path.join(SHOTS,'mall_cart.png') });
// 下单
const cashBefore = await page.evaluate(()=>window.BGS.gs.cash);
await page.click('[data-k="place"]');
await new Promise(r=>setTimeout(r,400));
const after = await page.evaluate(()=>({
  cash: window.BGS.gs.cash,
  deliveries: window.BGS.gs.logistics.deliveries.map(d=>({state:d.state, arriveDay:d.arriveDay, boxes:d.boxes.length})),
  day: window.BGS.gs.day,
  morningBack: !!document.querySelector('[data-k="mall"]'),
}));
console.log('[mall] after place:', JSON.stringify(after), 'cashBefore:', cashBefore);
await page.screenshot({ path: path.join(SHOTS,'morning_after_order.png') });
await browser.close(); server.close();
console.log('[shot-mall] done');
