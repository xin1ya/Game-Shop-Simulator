/**
 * street.js — 街道外景 + 货车 + 快递箱三态 + 行人呈现。
 *
 * 范围（PRD B18/B19/B20）：
 *   - 人行道 / 车道 / 斑马线 / 路灯 ×2 / 行道树 ×2 / 长椅 ×1 / 邻铺立面 ×3
 *   - 货车：IN_TRANSIT 驶入 → ARRIVED 停靠卸箱 → 驶离
 *   - 快递箱：SEALED 闭合 + SKU 侧标 / OPEN 开盖 / EMPTY 淡出移除
 *   - 行人：只消费 session.pedestrians（sim 层持有状态），本模块不生成、不推进
 *
 * 约束：
 *   - 不新增任何室内障碍 AABB（本模块全部为视觉物，不参与碰撞）
 *   - 行人与邻铺立面不加 inverted hull 描边（省 draw call）
 *   - 禁 Math.random；本模块无随机性
 *   - config 键缺失时（模拟层 v2 增量落地前）按架构定稿 §12.5 数值降级
 *
 * @module scene/street
 */

import * as THREE from 'three';
import { makeToonMaterial, addOutline, makeLabelPlane } from './scene.js';
import { getSkuAsset, ensureSkuAsset } from './productAssets.js';
import { CONFIG } from '../config.js';

// ---- 布局常量（CONFIG.street 存在时以配置为准，否则用架构 §12.5 定稿值） ----
const ST = CONFIG.street || {};
const FACADE_Z = ST.facadeZ ?? 4.8;                       // 店面装饰所在 z
// 人行道外沿（z = 5 + sidewalkW；2026-09 收窄为 1.5）——街道几何唯一真值，
// 勿再读 ST.blockZ（那是"可行走外沿"=对面人行道内，语义不同，曾漂移致车开上人行道）。
const BLOCK_Z = 5 + (ST.sidewalkW ?? 1.5);
const ROAD_FAR_Z = ST.roadFarLine ?? 12.5;                // 道路外边线（对面人行道内沿）
const TRUCK_STOP = (ST.truckStop && typeof ST.truckStop.x === 'number')
  ? ST.truckStop : { x: 8.5, z: 7.2 };                    // 货车停靠点
const BOX_SLOTS = (Array.isArray(ST.doorBoxSlots) && ST.doorBoxSlots.length > 0)
  ? ST.doorBoxSlots
  : [
      { x: 4.4, z: 5.5 }, { x: 5.2, z: 5.5 }, { x: 6.0, z: 5.5 }, { x: 6.8, z: 5.5 },
      { x: 4.0, z: 6.1 }, { x: 4.8, z: 6.1 }, { x: 5.6, z: 6.1 }, { x: 6.4, z: 6.1 },
    ];
const PEDESTRIAN_CAP = (ST.pedestrians && ST.pedestrians.max) ?? 8;
const TRUCK_SPEED = 6.0;      // 货车进出场速度（单位/秒，纯视觉）
const TRUCK_OFF_X = 16.0;     // 货车场外起点 / 终点 x

/** 邻铺立面（低模盒子 + 招牌，免描边）。
 * ★ 建筑红线：临街立面统一 z=5.05（本店前墙外侧），主体退红线之后（不占人行道）；
 *   门/招牌/遮阳棚挂 +z 立面侧（面向街道）；遮阳棚挑出 ≤1.0。
 *   对面排屋贴道路边线 z=14（立面 = 中心 z - 1.4）。 */
const NEIGHBOR_SHOPS = [
  { x: -10.5, z: 3.65, w: 5.4, body: 0x9ec9e8, awning: 0x5b8fb9, sign: '☕ 咖啡馆' },
  { x: 10.8, z: 3.65, w: 5.0, body: 0xf2b8c6, awning: 0xc96a86, sign: '🌸 花店' },
  // 背景排屋（完整街道感；同红线）
  { x: -16.0, z: 3.65, w: 5.0, body: 0xd8c8e8, awning: 0x8a7ab8, sign: '🖨️ 打印店' },
  { x: 16.2, z: 3.65, w: 4.6, body: 0xf5e3b8, awning: 0xc9a25f, sign: '📚 书店' },
  // 对面（道路另一侧，立面贴对面人行道外沿 z = roadFarLine + farSidewalkW = 17）
  { x: -8.6, z: 18.4, w: 5.2, body: 0xc9e3a8, awning: 0x7ba75c, sign: '🏪 便利店' },
  { x: 7.8, z: 18.4, w: 5.0, body: 0xf2d0c0, awning: 0xc9756a, sign: '💊 药店' },
];

/** 行人配色池（呈现层数据，按 id 确定性取色）。 */
const PED_COLORS = [
  0x8fb8de, 0xe8a8a8, 0xa8d8b0, 0xe8c88f, 0xb8a8d8, 0xd8e88f,
];

/** SKU emoji 贴图缓存（按 sku id 复用 CanvasTexture）。 */
const labelTexCache = new Map();

/** 生成 SKU emoji 侧标贴图（无 SKU 表时退化为 📦）。 */
function skuLabelTexture(sku) {
  const key = String(sku);
  if (labelTexCache.has(key)) return labelTexCache.get(key);
  const def = CONFIG.skus ? CONFIG.skus[sku] : null;
  const emoji = def && def.emoji ? def.emoji : '📦';
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255, 248, 232, 0.95)';
  ctx.beginPath();
  ctx.roundRect(6, 6, 84, 84, 14);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#8a5a2b';
  ctx.stroke();
  ctx.font = '58px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#5b3a1a';
  ctx.fillText(emoji, 48, 54);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  labelTexCache.set(key, tex);
  return tex;
}

/** 无描边网格（行人 / 邻铺 / 地面装饰用，省 draw call）。 */
function plainMesh(geometry, color, x, y, z) {
  const mesh = new THREE.Mesh(geometry, makeToonMaterial(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 带描边网格（货车 / 箱子 / 街道家具等近景主体用）。 */
function outlinedMesh(geometry, color, x, y, z) {
  const mesh = plainMesh(geometry, color, x, y, z);
  addOutline(mesh);
  return mesh;
}

/** 立体灯牌的文字纹理（营业/打烊灯牌前面板用）。 */
function lampTexture(text, bg, fg) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 112);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, 246, 102);
  ctx.fillStyle = fg;
  ctx.font = 'bold 52px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 60);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 文字贴图标签牌（实体固定标签：贴在立面/门板上，不随镜头转）。 */
function textPlane(lines, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = opts.width ?? 512;
  canvas.height = opts.height ?? 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = opts.bg ?? 'rgba(255, 250, 240, 0.96)';
  ctx.beginPath();
  ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, opts.radius ?? 24);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = opts.border ?? '#8a5a2b';
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.color ?? '#5b3a1a';
  const size = opts.fontSize ?? 72;
  ctx.font = `bold ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  const n = lines.length;
  lines.forEach((line, i) => {
    ctx.fillText(line, canvas.width / 2, (canvas.height / (n + 1)) * (i + 1));
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return makeLabelPlane(tex, opts.w ?? 2.6, opts.h ?? 0.8);
}

/** 构建静态街道装饰（人行道 / 车道 / 斑马线 / 路灯 / 行道树 / 长椅 / 邻铺）。 */
function buildStaticStreet(staticGroup) {
  // 人行道（店面 z=5 ~ BLOCK_Z；铺满全街 x∈[-22,22]，覆盖两端邻铺门前）
  const sidewalk = new THREE.Mesh(
    new THREE.BoxGeometry(44, 0.22, BLOCK_Z - 5),
    makeToonMaterial(0xd8c8a8),
  );
  sidewalk.position.set(0, -0.11, (5 + BLOCK_Z) / 2);
  sidewalk.receiveShadow = true;
  staticGroup.add(sidewalk);

  // 路缘石
  staticGroup.add(plainMesh(
    new THREE.BoxGeometry(44, 0.3, 0.24), 0xb8a488, 0, 0.13, BLOCK_Z,
  ));

  // 车道（铺满全街；宽度/中线由 BLOCK_Z→ROAD_FAR_Z 推导，与两侧人行道严格相接）
  const road = new THREE.Mesh(
    new THREE.BoxGeometry(46, 0.2, ROAD_FAR_Z - BLOCK_Z),
    makeToonMaterial(0x8f8a92),
  );
  road.position.set(0, -0.12, (BLOCK_Z + ROAD_FAR_Z) / 2);
  road.receiveShadow = true;
  staticGroup.add(road);

  // 对面人行道 + 路缘石（z∈[roadFar, roadFar+W]；对面建筑立面贴其外沿）
  const FAR_Z = ROAD_FAR_Z;
  const FAR_W = CONFIG.street.farSidewalkW ?? 1.0;
  const farSidewalk = new THREE.Mesh(
    new THREE.BoxGeometry(44, 0.22, FAR_W),
    makeToonMaterial(0xd8c8a8),
  );
  farSidewalk.position.set(0, -0.11, FAR_Z + FAR_W / 2);
  farSidewalk.receiveShadow = true;
  staticGroup.add(farSidewalk);
  staticGroup.add(plainMesh(
    new THREE.BoxGeometry(44, 0.3, 0.24), 0xb8a488, 0, 0.13, FAR_Z,
  ));

  // 斑马线（6 条白条：长边平行于人行道/车流方向（沿 x），沿 z 间隔排开；
  // 行人沿 z 过街时逐条踩过——修正此前条带垂直于道路的错误朝向）
  for (let i = 0; i < 6; i += 1) {
    const stripe = plainMesh(
      new THREE.BoxGeometry(3.2, 0.06, 0.55), 0xf5f2ea, 2.2, 0.0, BLOCK_Z + 0.9 + i * 1.1,
    );
    stripe.castShadow = false;
    staticGroup.add(stripe);
  }

  // 路灯 ×2（灯杆 + 灯头）
  for (const lx of [-3.4, 3.4]) {
    staticGroup.add(outlinedMesh(
      new THREE.CylinderGeometry(0.07, 0.09, 2.6, 10), 0x5b6b8c, lx, 1.3, BLOCK_Z - 0.4,
    ));
    staticGroup.add(outlinedMesh(
      new THREE.SphereGeometry(0.24, 12, 10), 0xffe9a8, lx, 2.7, BLOCK_Z - 0.4,
    ));
  }

  // 行道树 ×2（树干 + 双层球冠）
  for (const tx of [-7.2, 7.2]) {
    staticGroup.add(outlinedMesh(
      new THREE.CylinderGeometry(0.12, 0.16, 1.4, 10), 0x8a5a2b, tx, 0.7, BLOCK_Z - 0.5,
    ));
    staticGroup.add(outlinedMesh(
      new THREE.SphereGeometry(0.62, 12, 10), 0x58b368, tx, 1.75, BLOCK_Z - 0.5,
    ));
    staticGroup.add(outlinedMesh(
      new THREE.SphereGeometry(0.44, 12, 10), 0x6fc47c, tx + 0.3, 2.2, BLOCK_Z - 0.7,
    ));
  }

  // 长椅 ×1（座板 + 靠背 + 两腿）
  const bench = new THREE.Group();
  bench.add(outlinedMesh(new THREE.BoxGeometry(1.4, 0.09, 0.42), 0xa8703a, 0, 0.42, 0));
  bench.add(outlinedMesh(new THREE.BoxGeometry(1.4, 0.5, 0.08), 0xa8703a, 0, 0.68, -0.2));
  bench.add(outlinedMesh(new THREE.BoxGeometry(0.1, 0.42, 0.4), 0x8a5a2b, -0.6, 0.21, 0));
  bench.add(outlinedMesh(new THREE.BoxGeometry(0.1, 0.42, 0.4), 0x8a5a2b, 0.6, 0.21, 0));
  bench.position.set(-5.6, 0, BLOCK_Z - 0.55);
  bench.rotation.y = 0.12;
  staticGroup.add(bench);

  // 邻铺/排屋（免描边低模：主体 + 遮阳棚 + 招牌 + 门洞；本侧朝 +z，对面朝 -z）
  for (const shop of NEIGHBOR_SHOPS) {
    const g = new THREE.Group();
    const front = shop.z > 8 ? -1 : 1; // 对面排屋立面朝 -z（面向道路）
    g.add(plainMesh(new THREE.BoxGeometry(shop.w, 3.4, 2.8), shop.body, 0, 1.7, 0));
    // 遮阳棚贴立面挑出（≤1.0）
    g.add(plainMesh(
      new THREE.BoxGeometry(shop.w * 0.9, 0.16, 1.0), shop.awning, 0, 2.35, front * 1.9,
    ));
    const sign = textPlane([shop.sign], {
      width: 256, height: 96, fontSize: 52, w: 2.4, h: 0.9,
      bg: 'rgba(255,250,240,0.94)', radius: 18,
    });
    if (front < 0) sign.rotation.y = Math.PI; // 面朝道路
    sign.position.set(0, 3.15, front * 1.45);
    g.add(sign);
    g.add(plainMesh(
      new THREE.BoxGeometry(shop.w * 0.3, 1.8, 0.12), 0x5b4a3a, 0, 0.9, front * 1.42,
    ));
    g.position.set(shop.x, 0, shop.z);
    staticGroup.add(g);
  }
}

/** 构建货车（驾驶舱 + 货箱 + 车轮，近景主体带描边）。 */
function buildTruck() {
  const g = new THREE.Group();
  g.add(outlinedMesh(new THREE.BoxGeometry(1.1, 1.0, 1.4), 0xe07f5c, -0.85, 0.72, 0));
  g.add(outlinedMesh(new THREE.BoxGeometry(0.9, 0.36, 0.5), 0xf5e8d8, -0.85, 1.02, 0.55));
  g.add(outlinedMesh(new THREE.BoxGeometry(1.9, 1.4, 1.6), 0xf2d8a8, 0.55, 0.9, 0));
  const wheelPos = [
    [-1.15, 0.55], [-1.15, -0.55], [0.35, 0.62], [0.35, -0.62], [0.95, 0.62], [0.95, -0.62],
  ];
  for (const [wx, wz] of wheelPos) {
    const wheel = outlinedMesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.16, 12), 0x3a3430, wx, 0.26, wz,
    );
    wheel.rotation.x = Math.PI / 2;
    g.add(wheel);
  }
  return g;
}

/** 盖片开盖目标（轴 + 目标角，three 空间；e2e 校准）。 */
const FLAP_TARGETS = {
  FlapN: ['x', 2.35], FlapS: ['x', -2.35], FlapE: ['y', 2.35], FlapW: ['y', -2.35],
};
/** 盖片开启错峰（开盖进度 0~1 内的起始点）。 */
const FLAP_STAGGER = { FlapN: 0.15, FlapS: 0.3, FlapE: 0.45, FlapW: 0.6 };

/** 平滑步进。 */
function ease(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** 构建单个快递箱（GLB 铰链纸箱 + SEALED 胶带盖板 + 内容物小样 + 完整开启动画）。
 * 结构：crate（铰链盖片 FlapN/S/E/W，GLB 或回退方盒）+ cap（胶带十字，OPEN 掀起淡出）+
 *        contents（OPEN 时箱内 2 件 0.45× 小样）。
 * 位置由 sim 侧箱物理驱动（box.x/y/z）；开盖进度 ent.openT 驱动盖片逐段外翻。 */
function buildBox(sku) {
  const g = new THREE.Group();
  // 纸箱：GLB 优先（铰链盖片）；回退 = 程序化方盒（标记 fallbackCrate，资产就绪后懒换装）
  const crate = getSkuAsset('crate');
  let hasGlb = false;
  let flaps = null;
  if (crate) {
    const inst = crate.clone(true);
    inst.userData.sharedAsset = true;
    g.add(inst);
    hasGlb = true;
    flaps = {};
    for (const n of ['FlapN', 'FlapS', 'FlapE', 'FlapW']) {
      const node = inst.getObjectByName(n);
      if (node) flaps[n] = node;
    }
  } else {
    ensureSkuAsset('crate', () => {});
    const fb = outlinedMesh(new THREE.BoxGeometry(0.56, 0.5, 0.56), 0xd8a86a, 0, 0.25, 0);
    fb.userData.fallbackCrate = true;
    g.add(fb);
  }
  // 盖板组（SEALED：胶带十字盖顶；物品标签固定贴箱体正面，不随盖板摘除）
  const cap = new THREE.Group();
  cap.add(outlinedMesh(new THREE.BoxGeometry(0.56, 0.03, 0.12), 0xa87840, 0, 0.52, 0));
  cap.add(outlinedMesh(new THREE.BoxGeometry(0.12, 0.03, 0.56), 0xa87840, 0, 0.52, 0));
  g.add(cap);
  // ★ 物品标签：固定贴箱体正面（+z 面外侧，开箱后仍留在箱身正面；
  // 压低让位：开盖时前盖片下垂不遮挡标签）
  const label = makeLabelPlane(skuLabelTexture(sku), 0.32, 0.32);
  label.position.set(0, 0.18, 0.285);
  g.add(label);
  // 内容物（OPEN：箱内 2 件小样）
  const contents = new THREE.Group();
  const miniA = cloneAssetMini(sku, -0.12);
  const miniB = cloneAssetMini(sku, 0.12);
  if (miniA) contents.add(miniA);
  if (miniB) contents.add(miniB);
  contents.visible = false;
  g.add(contents);
  return { group: g, cap, contents, flaps, hasGlb };
}

/** 箱内小样（0.45× GLB 克隆，坐进内腔）；GLB 未就绪返回 null（箱体可用即可）。 */
function cloneAssetMini(skuId, dx) {
  const asset = getSkuAsset(skuId);
  if (!asset) {
    if (skuId) ensureSkuAsset(skuId, () => {});
    return null;
  }
  const inst = asset.clone(true);
  inst.userData.sharedAsset = true;
  inst.scale.setScalar(0.45);
  inst.position.set(dx, 0.06, 0);
  return inst;
}

/** 构建行人（无描边轻量小人：身体 + 头 + 双腿，颜色按 id 确定性取）。 */
function buildPedestrian(id) {
  const color = PED_COLORS[id % PED_COLORS.length];
  const g = new THREE.Group();
  g.add(plainMesh(new THREE.CapsuleGeometry(0.22, 0.34, 4, 8), color, 0, 0.62, 0));
  g.add(plainMesh(new THREE.SphereGeometry(0.24, 8, 8), 0xffd9b3, 0, 1.16, 0));
  g.add(plainMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 6), 0x5b4a3a, -0.1, 0.17, 0));
  g.add(plainMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 6), 0x5b4a3a, 0.1, 0.17, 0));
  return g;
}

/** 回收商人（v3 需求 9）：绿围裙小人 + ♻️ 头顶牌，账单日站店门口。 */
function buildRecycler() {
  const g = new THREE.Group();
  g.add(plainMesh(new THREE.CapsuleGeometry(0.24, 0.36, 4, 8), 0x4a6b4f, 0, 0.62, 0));
  g.add(plainMesh(new THREE.SphereGeometry(0.24, 8, 8), 0xffd9b3, 0, 1.16, 0));
  g.add(plainMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 6), 0x5b4a3a, -0.1, 0.17, 0));
  g.add(plainMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 6), 0x5b4a3a, 0.1, 0.17, 0));
  const badge = textPlane(['♻️ 收纸板'], {
    width: 200, height: 80, fontSize: 40, w: 0.9, h: 0.36,
    bg: 'rgba(46,107,62,0.95)', border: '#2e6b3e', color: '#d8ffd8', radius: 14,
  });
  badge.rotation.y = Math.PI; // 面朝店门（-z）
  badge.position.set(0, 1.62, -0.02);
  g.add(badge);
  return g;
}

/** 红绿灯（斑马线东侧：灯杆 + 灯箱，红/绿双灯罩轮换）。 */
function buildTrafficLight() {
  const g = new THREE.Group();
  g.add(outlinedMesh(new THREE.CylinderGeometry(0.07, 0.09, 3.0, 10), 0x3a4a66, 0, 1.5, 0));
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.62, 0.22), makeToonMaterial(0x2a2a30));
  box.position.set(0, 3.1, 0);
  addOutline(box);
  g.add(box);
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff4a3a }));
  red.position.set(0, 3.24, 0.12);
  const green = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: 0x35d06a }));
  green.position.set(0, 2.98, 0.12);
  g.add(red, green);
  return { group: g, red, green };
}

/** 低模小汽车（车身 + 座舱 + 四轮 + 车灯点）。 */
function buildCar(color) {
  const g = new THREE.Group();
  g.add(outlinedMesh(new THREE.BoxGeometry(1.7, 0.42, 0.86), color, 0, 0.32, 0));
  g.add(outlinedMesh(new THREE.BoxGeometry(0.9, 0.34, 0.78), color, -0.1, 0.68, 0));
  const wheelPos = [[-0.55, 0.42], [-0.55, -0.42], [0.55, 0.42], [0.55, -0.42]];
  for (const [wx, wz] of wheelPos) {
    const wheel = outlinedMesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 10), 0x2a2624, wx, 0.17, wz);
    wheel.rotation.x = Math.PI / 2;
    g.add(wheel);
  }
  // 车灯（前 -x：白色；后 +x：红色）
  g.add(plainMesh(new THREE.SphereGeometry(0.06, 6, 5), 0xfff6c8, -0.86, 0.38, 0.28));
  g.add(plainMesh(new THREE.SphereGeometry(0.06, 6, 5), 0xfff6c8, -0.86, 0.38, -0.28));
  g.add(plainMesh(new THREE.SphereGeometry(0.06, 6, 5), 0xe05252, 0.86, 0.38, 0.28));
  g.add(plainMesh(new THREE.SphereGeometry(0.06, 6, 5), 0xe05252, 0.86, 0.38, -0.28));
  return g;
}

/** 释放 Group 树资源。 */
function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

/**
 * 构建街道场景。
 * @param {THREE.Scene} scene
 * @param {object} gs GameState（当前仅读物流，静态装饰不随升级变化）
 * @returns {{group: THREE.Group, positions: object, sync: Function, rebuild: Function,
 *           setLampOpen: Function, clearDynamic: Function}}
 */
export function buildStreet(scene, gs) {
  const group = new THREE.Group();
  scene.add(group);

  const staticGroup = new THREE.Group();   // 街道装饰（不随物流变化）
  const dynGroup = new THREE.Group();      // 货车 / 快递箱 / 行人（随 sync 增删）
  group.add(staticGroup, dynGroup);

  buildStaticStreet(staticGroup);

  /** @type {Map<number, {group: THREE.Group, cap: THREE.Group|null, contents: THREE.Group, capT: number}>} */
  const boxEnts = new Map();
  /** @type {Map<number, THREE.Group>} */
  const pedEnts = new Map();
  const truck = buildTruck();
  truck.visible = false;
  dynGroup.add(truck);

  // ★ 营业 / 打烊立体灯牌（第 5 项：固定立体灯箱，非气泡 sprite）
  // 灯盒外壳 + 发光前面板（贴文字纹理，固定朝向街道），绿=营业 / 红=休息
  const lampOpenTex = lampTexture('营业中', '#2e6b3e', '#d8ffd8');
  const lampClosedTex = lampTexture('休息中', '#7a2e2e', '#ffd8d8');
  const lampBox = outlinedMesh(new THREE.BoxGeometry(1.0, 0.5, 0.18), 0x3a3430, 0, 0, 0);
  const lampFace = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.4),
    new THREE.MeshBasicMaterial({ map: lampOpenTex, transparent: true }),
  );
  lampFace.position.set(0, 0, 0.095);
  lampBox.add(lampFace);
  // 挂杆
  lampBox.add(outlinedMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), 0x5b4a3a, 0, 0.42, 0));
  lampBox.position.set(4.5, 2.5, 4.9 + 0.16); // 挂在前墙外侧
  dynGroup.add(lampBox);
  let lampOpenState = true;

  let etaMaxSeen = 0;   // 把 IN_TRANSIT 的 eta 映射为进场进度（0=远处 → 1=停靠）

  // 红绿灯（确定性轮换：绿 7s / 红 5s，无需 rng）
  const traffic = buildTrafficLight();
  traffic.group.position.set(7.0, 0, 11.0); // 斑马线（z 8.15~13.65）东侧中央
  dynGroup.add(traffic.group);
  // 车流（3 车 2 车道，确定性速度与相位，无需 rng）
  const CAR_DEFS = [
    { color: 0xe07f5c, laneZ: 9.2, dir: 1, speed: 3.6, x: -12 },
    { color: 0x5b8fb9, laneZ: 9.2, dir: 1, speed: 3.6, x: 2 },
    { color: 0x8fc47c, laneZ: 12.8, dir: -1, speed: 4.4, x: 14 },
  ];
  const carEnts = CAR_DEFS.map((def) => {
    const ent = buildCar(def.color);
    ent.position.set(def.x, 0, def.laneZ);
    ent.rotation.y = def.dir === 1 ? 0 : Math.PI; // 车头 -x 为前
    dynGroup.add(ent);
    return { mesh: ent, ...def };
  });
  // 过街行人 ×2（斑马线 x=2.2 区域，红灯时过街；两侧人行道中线 6.1 ↔ 15.9）
  const crossers = [
    { id: 'cross-0', ent: buildPedestrian(3), z: 6.1, targetZ: 15.9, x: 2.0, dir: 1 },
    { id: 'cross-1', ent: buildPedestrian(5), z: 15.9, targetZ: 6.1, x: 2.4, dir: -1 },
  ];
  for (const c of crossers) {
    c.ent.position.set(c.x, 0, c.z);
    dynGroup.add(c.ent);
  }

  const ctx = {
    boxEnts,
    pedEnts,
    truck,
    dynGroup,
    recyEnt: null, // v3 回收商人（session.recycler 驱动）
    traffic,
    lightT: 0, // 红绿灯累计时间（确定性）
    carEnts,
    crossers,
    getEtaMax: () => etaMaxSeen,
    setEtaMax: (v) => { etaMaxSeen = v; },
  };

  return {
    group,
    positions: {
      truckStop: new THREE.Vector3(TRUCK_STOP.x, 0, TRUCK_STOP.z),
      boxSlots: BOX_SLOTS.map((s) => new THREE.Vector3(s.x, 0, s.z)),
      sidewalkLane: new THREE.Vector3(0, 0, (ST.sidewalkLane && ST.sidewalkLane.z) ?? 5.2),
      facadeZ: FACADE_Z,
    },
    /** 营业灯牌：true 绿「营业中」/ false 红「休息中」。 */
    setLampOpen(open) {
      lampOpenState = Boolean(open);
      lampFace.material.map = lampOpenState ? lampOpenTex : lampClosedTex;
      lampFace.material.needsUpdate = true;
    },
    /** 装修升级后的静态重建（门头差异为 P2，当前仅重建原样，接口先留）。 */
    rebuild() {
      while (staticGroup.children.length > 0) {
        const child = staticGroup.children.pop();
        disposeGroup(child);
      }
      buildStaticStreet(staticGroup);
    },
    /** 清空全部动态实体（换天 / 重开时调用，静态装饰保留）。 */
    clearDynamic() {
      for (const [, ent] of boxEnts) dynGroup.remove(ent.group);
      for (const [, ent] of pedEnts) dynGroup.remove(ent);
      boxEnts.clear();
      pedEnts.clear();
      truck.visible = false;
      etaMaxSeen = 0;
      if (ctx.recyEnt) {
        dynGroup.remove(ctx.recyEnt);
        ctx.recyEnt = null;
      }
    },
    /** 每帧同步（由 main.js 调用）：货车 / 快递箱三态 / 行人。 */
    sync(currentGs, session, dt) {
      syncStreet(ctx, currentGs, session, dt);
    },
  };
}

/**
 * 街道动态状态同步（货车 / 快递箱 / 行人）。
 * @param {object} ctx {boxEnts, pedEnts, truck, dynGroup, getEtaMax, setEtaMax}
 * @param {object} gs GameState（读 gs.logistics）
 * @param {object|null} session DaySession（读 session.pedestrians）
 * @param {number} dt 帧间隔（秒）
 */
export function syncStreet(ctx, gs, session, dt) {
  const logistics = gs && gs.logistics ? gs.logistics : null;
  const deliveries = logistics ? logistics.deliveries : [];
  const boxes = logistics ? logistics.boxes : [];
  const truckEtaBase = (CONFIG.logistics && CONFIG.logistics.truckEta) || 1;

  // ---- 货车：IN_TRANSIT 驶入 → ARRIVED（仍有箱）停靠 → 驶离 ----
  const inTransit = deliveries.find((d) => d.state === 'IN_TRANSIT');
  // d.boxes 是箱子对象数组（非 id），直接与门口箱列表比对引用
  const arrivedBusy = deliveries.find(
    (d) => d.state === 'ARRIVED' && d.boxes.some((box) => boxes.includes(box)),
  );
  const truck = ctx.truck;
  if (inTransit) {
    if (inTransit.eta > ctx.getEtaMax()) ctx.setEtaMax(inTransit.eta);
    const denom = Math.max(ctx.getEtaMax(), truckEtaBase, 1);
    const t = 1 - Math.min(1, Math.max(0, inTransit.eta / denom));
    truck.visible = true;
    truck.position.set(TRUCK_OFF_X + (TRUCK_STOP.x - TRUCK_OFF_X) * t, 0, TRUCK_STOP.z);
    truck.rotation.y = 0; // 车头朝 -x（行驶方向），修朝向横停
  } else if (arrivedBusy) {
    truck.visible = true;
    truck.position.set(TRUCK_STOP.x, 0, TRUCK_STOP.z);
    truck.rotation.y = 0;
  } else if (truck.visible) {
    // 本单已清空 / 无在途单：向 -x 驶出画面
    truck.position.x -= TRUCK_SPEED * dt;
    truck.rotation.y = 0;
    if (truck.position.x < -TRUCK_OFF_X - 1) {
      truck.visible = false;
      ctx.setEtaMax(0);
    }
  }

  // ---- 快递箱（v3）：物理落点 + SEALED 盖板 / OPEN 掀盖消失+内容物 / EMPTY 空箱留置 ----
  const alive = new Set();
  for (const box of boxes) {
    alive.add(box.id);
    let ent = ctx.boxEnts.get(box.id);
    if (!ent) {
      const built = buildBox(box.sku);
      ent = {
        group: built.group, cap: built.cap, contents: built.contents, flaps: built.flaps,
        capT: box.state === 'SEALED' ? 0 : 1, openT: box.state === 'SEALED' ? 0 : 1,
        hasGlb: built.hasGlb,
      };
      ctx.boxEnts.set(box.id, ent);
      ctx.dynGroup.add(built.group);
    }
    // GLB 纸箱懒换装：建箱时资产未就绪（回退盒）→ 就绪后摘除回退换真箱
    if (!ent.hasGlb) {
      const crateAsset = getSkuAsset('crate');
      if (crateAsset) {
        const fb = ent.group.children.find((o) => o.userData && o.userData.fallbackCrate);
        if (fb) {
          ent.group.remove(fb);
          disposeGroup(fb);
        }
        const inst = crateAsset.clone(true);
        inst.userData.sharedAsset = true;
        ent.group.add(inst);
        ent.flaps = {};
        for (const n of ['FlapN', 'FlapS', 'FlapE', 'FlapW']) {
          const node = inst.getObjectByName(n);
          if (node) ent.flaps[n] = node;
        }
        ent.hasGlb = true;
      }
    }
    // 位置 = sim 侧箱物理真值（重力沉降/推箱）
    ent.group.position.set(box.x, box.y, box.z);
    // ★ 完整开启动画：openT 0→1 —— 胶带盖板先掀起淡出，盖片错峰外翻（N→S→E→W）
    const wantOpen = box.state !== 'SEALED';
    ent.openT = Math.min(1, Math.max(0, ent.openT + (wantOpen ? dt : -dt) * 1.6));
    const ot = ent.openT;
    // 盖板：前 35% 掀起淡出
    ent.capT = Math.min(1, Math.max(0, ot / 0.35));
    if (ent.cap) {
      ent.cap.visible = ent.capT < 1;
      ent.cap.position.y = ent.capT * 0.5;
      ent.cap.rotation.z = ent.capT * 0.5;
      ent.cap.traverse((o) => {
        if (o.material) {
          o.material.transparent = true;
          o.material.opacity = 1 - ent.capT;
        }
      });
      if (ent.capT >= 1) {
        ent.group.remove(ent.cap);
        disposeGroup(ent.cap);
        ent.cap = null;
      }
    }
    // 盖片：错峰外翻到目标角（铰链节点旋转）
    if (ent.flaps) {
      for (const n of Object.keys(ent.flaps)) {
        const [axis, target] = FLAP_TARGETS[n];
        ent.flaps[n].rotation[axis] = target * ease((ot - FLAP_STAGGER[n]) / 0.55);
      }
    }
    ent.contents.visible = box.state === 'OPEN' && ot > 0.55; // 盖片张开大半后见货
    
  }
  // sim 层已移除（折叠/丢弃/清场）的箱子：立即清理防泄漏
  for (const [id, ent] of ctx.boxEnts) {
    if (!alive.has(id)) {
      ctx.dynGroup.remove(ent.group);
      disposeGroup(ent.group);
      ctx.boxEnts.delete(id);
    }
  }

  // ---- 行人：只读 sim 位置；convertedTo 非空者不渲染（已转顾客） ----
  const peds = session && Array.isArray(session.pedestrians)
    ? session.pedestrians.slice(0, PEDESTRIAN_CAP)
    : [];
  const pedAlive = new Set();
  for (const p of peds) {
    if (p.convertedTo !== null && p.convertedTo !== undefined) continue;
    pedAlive.add(p.id);
    let ent = ctx.pedEnts.get(p.id);
    if (!ent) {
      ent = buildPedestrian(p.id);
      ctx.dynGroup.add(ent);
      ctx.pedEnts.set(p.id, ent);
    }
    ent.position.x = p.x;
    ent.position.z = p.z;
    ent.rotation.y = p.dir === 1 ? Math.PI / 2 : -Math.PI / 2;
    ent.position.y = Math.abs(Math.sin((p.x + p.id) * 3)) * 0.03; // 步行轻微起伏
  }
  for (const [id, ent] of ctx.pedEnts) {
    if (!pedAlive.has(id)) {
      ctx.dynGroup.remove(ent);
      disposeGroup(ent);
      ctx.pedEnts.delete(id);
    }
  }

  // ---- 红绿灯 + 车流 + 过街行人（2026-09 完整街道，确定性无 rng） ----
  {
    ctx.lightT = (ctx.lightT || 0) + dt;
    const cycle = ctx.lightT % 12;
    const carGreen = cycle < 7; // 绿 7s / 红 5s
    if (ctx.traffic) {
      ctx.traffic.green.material.color.setHex(carGreen ? 0x35d06a : 0x2a4a3a);
      ctx.traffic.red.material.color.setHex(carGreen ? 0x4a2a2a : 0xff4a3a);
    }
    // 车流：红灯在斑马线（x=2.6）前停车，绿灯通行；|x|>17 循环
    for (const car of ctx.carEnts || []) {
      const stopX = car.dir === 1 ? 1.4 : 4.0; // 各方向停车线
      const approaching = car.dir === 1 ? car.x < stopX : car.x > stopX;
      const near = Math.abs(car.x - stopX) < 2.5;
      const go = carGreen || !approaching || !near;
      if (go) car.x += car.dir * car.speed * dt;
      if (car.dir === 1 && car.x > 17) car.x = -17;
      if (car.dir === -1 && car.x < -17) car.x = 17;
      car.mesh.position.x = car.x;
    }
    // 过街行人：仅红灯时过马路，到对岸换向（下轮红灯再返回）
    for (const c of ctx.crossers || []) {
      if (!carGreen) {
        c.z += c.dir * 0.85 * dt;
        const done = c.dir === 1 ? c.z >= c.targetZ : c.z <= c.targetZ;
        if (done) {
          c.dir = -c.dir;
          c.targetZ = c.dir === 1 ? 15.9 : 6.1;
        }
      }
      c.ent.position.x = c.x;
      c.ent.position.z = c.z;
      c.ent.rotation.y = c.dir === 1 ? 0 : Math.PI;
    }
  }

  // ---- 回收商人（v3 需求 9）：账单日站店门口，非账单日撤下 ----
  if (session && session.recycler) {
    if (!ctx.recyEnt) {
      ctx.recyEnt = buildRecycler();
      ctx.recyEnt.position.set(CONFIG.layout.recyclerPoint.x, 0, CONFIG.layout.recyclerPoint.z);
      ctx.recyEnt.rotation.y = -Math.PI / 2; // 面向店门
      ctx.dynGroup.add(ctx.recyEnt);
    }
  } else if (ctx.recyEnt) {
    ctx.dynGroup.remove(ctx.recyEnt);
    disposeGroup(ctx.recyEnt);
    ctx.recyEnt = null;
  }
}
