import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8453;
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
// 下 12 箱大单 → 开门进 PREP → 推进到次日到货
await page.evaluate(async ()=>{
  const E = await import('./src/sim/economy.js');
  window.BGS.gs.cash += 20000;
  E.restock(window.BGS.gs, { boba_tea: 24, cat_cafe: 16, dice_tower: 8 }, null);
});
await page.click('button[data-k="open"]');
await page.waitForFunction(()=>window.BGS.gs && window.BGS.gs.phase==='PREP',{timeout:10000});
for (let i=0;i<6;i++){ const b = await page.$('#popup-root button'); if(!b) break; await b.click(); await new Promise(r=>setTimeout(r,120)); }
await page.keyboard.press('KeyV'); // 俯瞰
await page.evaluate(async ()=>{ const L = await import('./src/sim/logistics.js'); window.BGS.gs.day += 1; L.startDeliveries(window.BGS.gs); });
await new Promise(r=>setTimeout(r,10000)); // 等货车到店 + 沉降
// ① 分布断言：12 箱应铺满 9 列（平铺优先），不是一柱
const dist = await page.evaluate(()=>{
  const cols = new Map();
  for (const b of window.BGS.gs.logistics.boxes) {
    const k = `${b.x},${b.z}`;
    cols.set(k, (cols.get(k)||0)+1);
  }
  return { n: window.BGS.gs.logistics.boxes.length, cols: Object.fromEntries(cols), maxY: Math.max(...window.BGS.gs.logistics.boxes.map((b)=>b.y)) };
});
console.log('[分布]', JSON.stringify(dist));
if (dist.n !== 12 || Object.keys(dist.cols).length !== 9) throw new Error(`平铺失败: ${JSON.stringify(dist.cols)}`);
// ② 抽掉某列下层箱 → 上层应自动沉降
const settle = await page.evaluate(async ()=>{
  const L = await import('./src/sim/logistics.js');
  const gs = window.BGS.gs;
  // 找一列两层的：col "7.2,5.4" 有 2 箱（y=0 与 y=H*2）
  const col = gs.logistics.boxes.filter((b)=>b.x===7.2&&b.z===5.4).sort((a,b)=>a.y-b.y);
  if (col.length < 2) return { skip: `该列只有 ${col.length} 箱` };
  const [lower, upper] = col;
  const yBefore = upper.y;
  gs.logistics.boxes = gs.logistics.boxes.filter((b)=>b.id!==lower.id); // 模拟抱走
  for (let i=0;i<120;i++) L.stepBoxPhysics(gs, 0.05);
  return { yBefore, yAfter: upper.y, settled: upper.settled };
});
console.log('[抽箱沉降]', JSON.stringify(settle));
if (!settle.skip && (Math.abs(settle.yAfter) > 1e-9 || !settle.settled)) throw new Error(`上层未沉降: ${JSON.stringify(settle)}`);
// ③ iso 隔空交互：店长站远 → resolveTarget 应为 null；走近应有目标
const isoGate = await page.evaluate(async ()=>{
  const I = await import('./src/sim/interaction.js');
  const gs = window.BGS.gs; const session = window.BGS.session;
  const box = gs.logistics.boxes[0];
  const far = { x: box.x - 20, z: box.z, viewMode: 'iso', yaw: 0 };
  const near = { x: box.x - 1.5, z: box.z, viewMode: 'iso', yaw: 0 };
  return {
    far: I.resolveTarget(gs, session, far, 'lmb'),
    near: I.resolveTarget(gs, session, near, 'lmb'),
  };
});
console.log('[iso限距] far=', JSON.stringify(isoGate.far), ' near.kind=', isoGate.near && isoGate.near.kind);
if (isoGate.far && isoGate.far.kind === 'unbox') throw new Error('iso 隔空仍可开箱！');
if (!isoGate.near) throw new Error('iso 近处应能解出目标');
// 截图：堆叠区平铺全景
await page.evaluate(()=>{
  window.BGS.managerPos.x = 7.9; window.BGS.managerPos.z = 4.6;
  const cam = window.BGS.camera; const a = window.innerWidth/window.innerHeight;
  cam.top=3.2; cam.bottom=-3.2; cam.left=-3.2*a; cam.right=3.2*a; cam.updateProjectionMatrix();
});
await new Promise(r=>setTimeout(r,500));
await page.screenshot({ path: path.join(SHOTS,'final_dropzone2.png') });
await browser.close(); server.close();
console.log('[probe-dropzone] all ok');
