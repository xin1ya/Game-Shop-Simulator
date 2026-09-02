import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8457;
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
// 直接上架一件商品（货架 0 有价签）
await page.evaluate(async ()=>{
  const L = await import('./src/sim/logistics.js');
  L.grantStock(window.BGS.gs, 'boba_tea', 'onShelf', 4);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV'); // iso
await page.evaluate(()=>{ window.BGS.managerPos.x = -4.8; window.BGS.managerPos.z = -0.5; });
await new Promise(r=>setTimeout(r,600));
// 找价签世界坐标 → 投影到屏幕像素
const px = await page.evaluate(async ()=>{
  const THREE = await import('three');
  let tag = null;
  window.BGS.shelfCtx.group.traverse((o)=>{
    if (!tag && o.userData && o.userData.priceTag) tag = o;
  });
  if (!tag) return null;
  const v = new THREE.Vector3();
  tag.getWorldPosition(v);
  v.project(window.BGS.camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
});
console.log('[priceTag] 价签屏幕坐标=', JSON.stringify(px));
if (!px) throw new Error('找不到价签');
await page.mouse.click(px.x, px.y, { button: 'left' });
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'pricetag_panel.png') });
// 面板应出现；+10 步进 → 确定
const panelUp = await page.evaluate(()=>Boolean(document.querySelector('[data-price-panel]')));
console.log('[priceTag] 面板出现=', panelUp);
if (!panelUp) throw new Error('价签左键未打开调价面板');
const before = await page.evaluate(()=>window.BGS.gs.skuPrices.boba_tea);
await page.click('[data-price-panel] [data-k="p10"]');
await page.click('[data-price-panel] [data-k="ok"]');
await new Promise(r=>setTimeout(r,300));
const after = await page.evaluate(()=>window.BGS.gs.skuPrices.boba_tea);
const maxP = await page.evaluate(async ()=>{
  const C = await import('./src/config.js');
  return Math.round(C.CONFIG.skus.boba_tea.guidePrice * C.CONFIG.economy.priceClampMax);
});
console.log('[priceTag] 价格', before, '→', after, '(clamp 上限', maxP, ')');
if (after !== Math.min(before + 10, maxP)) throw new Error(`调价未生效: ${before} → ${after}（上限 ${maxP}）`);
// 右键拿货：投影货架商品位置 → 右键 → 手上应有货
const gpx = await page.evaluate(async ()=>{
  const THREE = await import('three');
  let g = null;
  window.BGS.shelfCtx.group.traverse((o)=>{
    if (!g && o.userData && typeof o.userData.shelfSlot === 'number' && !o.userData.priceTag) g = o;
  });
  if (!g) return null;
  const v = new THREE.Vector3();
  g.getWorldPosition(v);
  v.y += 0.1;
  v.project(window.BGS.camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
});
if (!gpx) throw new Error('找不到货架商品');
await page.mouse.click(gpx.x, gpx.y, { button: 'right' });
await new Promise(r=>setTimeout(r,400));
const carry = await page.evaluate(()=>window.BGS.session.carry);
console.log('[takeShelf] carry=', JSON.stringify(carry));
if (!carry || carry.type !== 'item' || carry.skuId !== 'boba_tea') throw new Error('右键拿货失败');
await page.screenshot({ path: path.join(SHOTS,'pricetag_taken.png') });
console.log('[probe-pricetag] all ok');
await browser.close(); server.close();
