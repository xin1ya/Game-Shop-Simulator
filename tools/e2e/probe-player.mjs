import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8450;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.glb':'model/gltf-binary' };
const server = http.createServer(async (req,res)=>{
  let p = decodeURIComponent(new URL(req.url,'http://x').pathname); if(p==='/')p='/index.html';
  const f = path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!existsSync(f)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'});
  res.end(await readFile(f));
});
await new Promise(r=>server.listen(PORT,r));
const browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const page = await browser.newPage();
page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,200)));
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.BGS,{timeout:30000});
const out = await page.evaluate(async ()=>{
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  return await new Promise((resolve)=>{
    loader.load('assets/glb/player.glb', (g)=>{
      const kids = [];
      g.scene.traverse(o => { if (o.isMesh || o.isSkinnedMesh) kids.push(`${o.type}:${o.name}`); });
      const bones = [];
      g.scene.traverse(o => { if (o.isBone) bones.push(o.name); });
      resolve({ meshes: kids, bones, clips: g.animations.map(a=>a.name) });
    }, undefined, (e)=>resolve({err:String(e)}));
  });
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
