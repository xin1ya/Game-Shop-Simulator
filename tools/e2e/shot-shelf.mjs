/**
 * shot-shelf.mjs — 浏览器端终验：货架 GLB 商品 + 摆放定位 + 箱盖 + 玻璃滑门。
 *
 * 流程：静态服务器托管项目根 → headless Chrome → 新游戏 → 下单并开始备货（0 订单进 PREP）
 * → 注入各 SKU 后仓库存并走真实 restockToSlot 上架 → iso 跟随店长近景截图。
 *
 * 运行：node tools/e2e/shot-shelf.mjs
 * 产物：tools/e2e/shots/*.png
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tools/e2e/shots');
const PORT = 8432;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.json': 'application/json',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404); res.end('nf'); return;
      }
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('未找到 Chrome/Edge');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--no-sandbox',
      '--window-size=1360,860'],
    defaultViewport: { width: 1360, height: 860 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) console.log('[http]', r.status(), r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text());
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.BGS && document.querySelector('button[data-k="new"]'),
    { timeout: 30000 });
  await page.click('button[data-k="new"]');
  await page.waitForSelector('button[data-k="open"]', { timeout: 10000 });
  // 先关掉剧情弹窗（底部弹窗会挡住「开始备货」按钮）
  for (let i = 0; i < 5; i += 1) {
    const btn = await page.$('#popup-root button');
    if (!btn) break;
    await btn.click();
    await new Promise((r) => setTimeout(r, 200));
  }
  await page.click('button[data-k="open"]'); // 0 订单进入 PREP
  await page.waitForFunction(() => window.BGS.gs && window.BGS.gs.phase === 'PREP',
    { timeout: 10000 });
  // 开门后可能再弹一条（活动周等），再清一轮
  for (let i = 0; i < 5; i += 1) {
    const btn = await page.$('#popup-root button');
    if (!btn) break;
    await btn.click();
    await new Promise((r) => setTimeout(r, 200));
  }
  // 切到等距俯瞰（相机跟随店长，便于近景取景）
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.BGS.session && window.BGS.session.viewMode === 'iso',
    { timeout: 5000 }).catch(() => console.log('[warn] 未切到 iso'));

  // 注入全部 13 个 SKU：后仓补货 → 真实 restockToSlot 上架（占满各自前几格）
  await page.evaluate(async () => {
    const L = await import('./src/sim/logistics.js');
    const gs = window.BGS.gs;
    const skus = ['cat_cafe', 'undercover', 'gem_trader', 'civ_rise', 'deep_space',
      'dragon_exp', 'boba_tea', 'hand_brew', 'energy_bar', 'dice_keychain',
      'sticker_pack', 'metal_badge', 'dice_tower'];
    for (const id of skus) {
      gs.skus[id].backroom = 8;
      L.restockToSlot(gs, id, 8);
    }
  });
  // 等 GLB 加载 + 重建（1.5s），店长站到店内中央偏后看货架
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => {
    window.BGS.managerPos.x = 0;
    window.BGS.managerPos.z = 1.2;
  });
  await new Promise((r) => setTimeout(r, 500));
  // 诊断：货架上各类实例的数量（GLB 克隆 vs 程序化回退）
  const diag = await page.evaluate(() => {
    const out = { shared: 0, fallback: 0, slots: [] };
    const group = window.BGS.shelfCtx.group;
    group.traverse((o) => {
      if (o.userData && o.userData.sharedAsset) out.shared += 1;
      else if (o.userData && 'tintFor' in o.userData && o.type === 'Group' && o.children.length) {
        out.fallback += 1;
      }
    });
    for (const s of window.BGS.gs.shelfSlots) if (s.sku) out.slots.push(`${s.sku}:${s.qty}`);
    return out;
  });
  console.log('[diag]', JSON.stringify(diag));
  await page.screenshot({ path: path.join(SHOTS, 'shelf_iso_all.png') });

  // 货架特写：缩窄正交取景框（frustum 半高 2.2），店长站到货架 1 前
  await page.evaluate(() => {
    window.BGS.managerPos.x = -4.8;
    window.BGS.managerPos.z = -1.9;
    const cam = window.BGS.camera;
    const aspect = window.innerWidth / window.innerHeight;
    cam.top = 2.2; cam.bottom = -2.2;
    cam.left = -2.2 * aspect; cam.right = 2.2 * aspect;
    cam.updateProjectionMatrix();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOTS, 'shelf1_zoom.png') });
  // 货架 3（snacks）特写
  await page.evaluate(() => {
    window.BGS.managerPos.x = 1.6;
    window.BGS.managerPos.z = -1.9;
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(SHOTS, 'shelf3_zoom.png') });
  // 货架 4（merch）特写
  await page.evaluate(() => {
    window.BGS.managerPos.x = 4.8;
    window.BGS.managerPos.z = -1.9;
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(SHOTS, 'shelf4_zoom.png') });
  // 恢复取景框
  await page.evaluate(() => {
    const cam = window.BGS.camera;
    const aspect = window.innerWidth / window.innerHeight;
    cam.top = 8.2; cam.bottom = -8.2;
    cam.left = -8.2 * aspect; cam.right = 8.2 * aspect;
    cam.updateProjectionMatrix();
  });

  // 更近：店长贴到货架前（相机跟随）
  await page.evaluate(() => {
    window.BGS.managerPos.x = -1.6;
    window.BGS.managerPos.z = -1.4;
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOTS, 'shelf_iso_close.png') });

  // 门口特写（缩窄取景框，从街道侧看门脸）：注入 SEALED + OPEN 各一箱
  await page.evaluate(() => {
    const gs = window.BGS.gs;
    gs.logistics.boxes.push({ id: 9001, sku: 'dice_tower', state: 'SEALED', slot: 0, progress: 0 });
    gs.logistics.boxes.push({ id: 9002, sku: 'boba_tea', state: 'OPEN', slot: 1, progress: 0 });
    window.BGS.managerPos.x = 5.8;
    window.BGS.managerPos.x = 2.0; // 机位左移避开右侧邻铺遮挡
    window.BGS.managerPos.z = 6.6; // 店长距门 4.1 > 1.5 阈值 → 门保持关闭
    const cam = window.BGS.camera;
    const aspect = window.innerWidth / window.innerHeight;
    cam.top = 2.6; cam.bottom = -2.6;
    cam.left = -2.6 * aspect; cam.right = 2.6 * aspect;
    cam.updateProjectionMatrix();
  });
  await new Promise((r) => setTimeout(r, 900));
  const doorT0 = await page.evaluate(() => window.BGS.shopCtx.group.userData.doorOpenT ?? 0);
  console.log('[door] 远离时 doorOpenT =', doorT0.toFixed(3), '（应 ≈0）');
  await page.screenshot({ path: path.join(SHOTS, 'door_closed.png') });
  // 店长走近门口 → 滑门打开
  await page.evaluate(() => {
    window.BGS.managerPos.x = 5.8;
    window.BGS.managerPos.z = 5.5; // 距门 0.6 < 1.5 → 滑门打开（部分被邻铺遮挡，数值断言为主）
  });
  await new Promise((r) => setTimeout(r, 900));
  const doorT1 = await page.evaluate(() => window.BGS.shopCtx.group.userData.doorOpenT ?? 0);
  console.log('[door] 接近时 doorOpenT =', doorT1.toFixed(3), '（应 ≈1）');
  await page.screenshot({ path: path.join(SHOTS, 'door_boxes_open.png') });


  // 货架升级到 3 级：货架放大 ×1.3 后商品仍坐板顶（不悬空/不埋板）
  await page.evaluate(() => {
    window.BGS.gs.upgrades.shelf = 3;
    window.BGS.shopCtx.rebuild(window.BGS.gs);
    window.BGS.managerPos.x = -4.8;
    window.BGS.managerPos.z = -1.9;
    const cam = window.BGS.camera;
    const aspect = window.innerWidth / window.innerHeight;
    cam.top = 2.4; cam.bottom = -2.4;
    cam.left = -2.4 * aspect; cam.right = 2.4 * aspect;
    cam.updateProjectionMatrix();
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(SHOTS, 'shelf_level3.png') });

  await browser.close();
  server.close();
  console.log('[shot] done → tools/e2e/shots/');
}

main().catch((e) => { console.error(e); process.exit(1); });
