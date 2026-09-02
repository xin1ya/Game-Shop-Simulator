import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8456;
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
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
// 直进 EVENING（打烊整理），切 iso 俯瞰，店长站桌子 0 旁
await page.evaluate(async ()=>{
  const D = await import('./src/sim/day.js');
  D.startEveningSession(window.BGS.gs, window.BGS.session);
});
await new Promise(r=>setTimeout(r,300));
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV'); // iso（会同步 fp 位置到 managerPos，须在按 V 后再设位）
await page.evaluate(()=>{
  window.BGS.managerPos.x = 3.6; window.BGS.managerPos.z = -0.6; // 体验桌 0 位置 → 画面中心
});
await new Promise(r=>setTimeout(r,400));
// 开布局模式（B）
await page.keyboard.press('KeyB');
await new Promise(r=>setTimeout(r,300));
await page.screenshot({ path: path.join(SHOTS,'layout_before.png') });
// 右键点画面中心（桌子 0 被店长遮挡也无妨——射线穿透取 layoutKind）
const modeOn = await page.evaluate(()=>window.BGS.layoutMode);
console.log('[layout] layoutMode=', modeOn);
await page.mouse.click(680, 400, { button: 'right' });
await new Promise(r=>setTimeout(r,300));
const picked = await page.evaluate(()=>window.BGS.layoutDrag);
console.log('[layout] picked=', JSON.stringify(picked));
if (!picked) throw new Error('右键未拾起构件');
// 拖动：鼠标右移 260px（等距 +x 方向），按 R 旋转 90°，等几帧
await page.mouse.move(940, 400);
await new Promise(r=>setTimeout(r,300));
await page.keyboard.press('KeyR'); // 旋转 90°
await new Promise(r=>setTimeout(r,300));
await page.screenshot({ path: path.join(SHOTS,'layout_drag.png') });
// 左键放下
await page.mouse.click(940, 400, { button: 'left' });
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: path.join(SHOTS,'layout_after.png') });
const out = await page.evaluate(()=>({
  customLayout: window.BGS.gs.customLayout,
  table0: window.BGS.shopCtx.positions.experienceSlots[0],
}));
console.log('[layout] customLayout=', JSON.stringify(out.customLayout));
console.log('[layout] slot0=', JSON.stringify({ x: out.table0.x, z: out.table0.z }));
if (!out.customLayout || !out.customLayout.tables || !out.customLayout.tables[0]) {
  throw new Error('布局未写入 customLayout.tables[0]');
}
if (out.customLayout.tables[0].rot !== 90) {
  throw new Error(`旋转未写入（rot=${out.customLayout.tables[0].rot}，期望 90）`);
}
console.log('[probe-layout] ok picked=', JSON.stringify(picked));
await browser.close(); server.close();
