/**
 * shop.js — 店铺静态场景：地板、货架、体验桌（2~4 随升级）、收银台、装饰、门口。
 *
 * 布局约定（世界坐标，y 为高度，地板 y=0）：
 *   后墙一排 4 个货架（按品类），右侧体验区，左前收银台，右前门口。
 * buildShop 返回 slotPositions 供 director 摆放顾客。
 *
 * @module scene/shop
 */

import * as THREE from 'three';
import { makeToonMaterial, addOutline, makeLabelPlane } from './scene.js';
import { shelfVisualScale } from './firstPerson.js';
import { layoutOf, rotOffset } from '../sim/layout.js';
import { CONFIG } from '../config.js';

/** 各品类货架位置（与 CONFIG.categoryOrder 对齐）。 */
const SHELF_X = [-4.8, -1.6, 1.6, 4.8];
const SHELF_Z = -3.2;
const SHELF_COLORS = [0x7ec8e3, 0x9b7ede, 0xffb26b, 0xf29ec4];

/** 体验位坐标池（最多 6 个：主区 4 + 翼房 2；翼房 2 个在收购 wing_right 后启用）。 */
// （后 2 个为收购右邻铺 wing_right 的翼房体验位）
const EXP_SLOT_POS = [
  [3.6, -0.6], [5.2, -0.6], [3.6, 1.6], [5.2, 1.6],
  [8.6, -0.6], [10.2, -0.6],
];

const CHECKOUT_POS = [-4.6, 2.6];
const DOOR_POS = [5.8, 4.4];
const WAIT_POS = [0, 0.6];
// ★ 错位修复：队列必须排在收银台（x=-4.6）正前方，而不是店中央。
// 与 CONFIG.layout.queue 对齐（sim 侧坐标真值）。
const QUEUE_POS = [
  CONFIG.layout && CONFIG.layout.queue && CONFIG.layout.queue.length > 0
    ? CONFIG.layout.queue[0].x
    : -4.6,
  CONFIG.layout && CONFIG.layout.queue && CONFIG.layout.queue.length > 0
    ? CONFIG.layout.queue[0].z
    : 1.7,
];

/**
 * B23 员工通道门（视觉门 + 交互点，不开通行）。
 * 位于左墙 x=-6.9, z=-1；左墙 AABB 一个字节不动（架构 §11-U3 拍板）。
 */
const STAFF_DOOR_POS = [-6.62, -1.0];

/** 店面装饰所在 z（街道侧，与 CONFIG.street.facadeZ 对齐）。 */
const FACADE_Z = (CONFIG.street && CONFIG.street.facadeZ) !== undefined
  ? CONFIG.street.facadeZ : 4.8;

/** 创建带描边的盒子。 */
function box(w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makeToonMaterial(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  addOutline(mesh);
  return mesh;
}

/** 创建带描边的圆柱。 */
function cylinder(rTop, rBottom, h, color, x, y, z) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, h, 12),
    makeToonMaterial(color),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  addOutline(mesh);
  return mesh;
}

/** 货架：立柱 + 三层板（商品小盒由 shelf.js 按陈列量挂载，A11 货架初始为空）。 */
function buildShelf(color) {
  const g = new THREE.Group();
  g.add(box(0.12, 1.8, 0.7, 0x8a5a2b, -0.65, 0.9, 0));
  g.add(box(0.12, 1.8, 0.7, 0x8a5a2b, 0.65, 0.9, 0));
  for (let i = 0; i < 3; i += 1) {
    g.add(box(1.5, 0.08, 0.75, 0xa8703a, 0, 0.4 + i * 0.55, 0));
  }
  // color 参数保留：货架背板按品类微调色相（区分品类；商品实例见 shelf.js）
  g.add(box(1.42, 0.05, 0.05, color, 0, 1.78, -0.32));
  return g;
}

/** 体验桌：圆桌 + 四条腿 + 桌面游戏盒 + 两把椅子。 */
function buildExperienceTable() {
  const g = new THREE.Group();
  g.add(cylinder(0.75, 0.75, 0.08, 0xe8b06a, 0, 0.72, 0));
  g.add(cylinder(0.09, 0.12, 0.72, 0x8a5a2b, 0, 0.36, 0));
  g.add(box(0.5, 0.1, 0.36, 0x7ec8e3, 0.1, 0.81, 0.05)); // 桌上的游戏
  g.add(box(0.45, 0.45, 0.45, 0xd98e4a, -1.0, 0.225, 0)); // 椅子
  g.add(box(0.45, 0.45, 0.45, 0xd98e4a, 1.0, 0.225, 0));
  return g;
}

/** 收银台：柜台 + 收银机。 */
function buildCheckoutCounter() {
  const g = new THREE.Group();
  g.add(box(2.0, 0.85, 0.8, 0xc9763f, 0, 0.425, 0));
  g.add(box(0.5, 0.35, 0.4, 0x5b6b8c, 0.4, 1.02, 0));
  return g;
}

/** 右翼房（收购右邻铺）：地板 + 东/北/南三面墙（西侧面即店内右墙门洞）。 */
function buildWingRoom(group) {
  const WALL = 0xf5e0b8;
  // 地板
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(5.0, 0.3, 6.7),
    makeToonMaterial(0xecd9ae),
  );
  floor.position.set(9.35, -0.15, -1.0);
  floor.receiveShadow = true;
  group.add(floor);
  // 三面墙（与障碍 wingObstacles 对齐）
  group.add(box(0.3, 2.6, 6.7, WALL, 11.6, 1.3, -1.0));   // 东墙
  group.add(box(5.0, 2.6, 0.3, WALL, 9.35, 1.3, -4.2));   // 北墙
  group.add(box(5.0, 2.6, 0.3, WALL, 9.35, 1.3, 2.2));    // 南墙
  // 翼房顶棚边沿（开放顶与主店一致）
  group.add(box(5.2, 0.18, 0.6, 0x8a5a2b, 9.35, 2.62, -4.05));
  group.add(box(5.2, 0.18, 0.6, 0x8a5a2b, 9.35, 2.62, 2.05));
}

/** 盆栽装饰。 */
function buildPlant() {
  const g = new THREE.Group();
  g.add(cylinder(0.22, 0.28, 0.4, 0xc9763f, 0, 0.2, 0));
  const leaves = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 10, 8),
    makeToonMaterial(0x58b368),
  );
  leaves.position.set(0, 0.7, 0);
  leaves.castShadow = true;
  addOutline(leaves);
  g.add(leaves);
  return g;
}

/** 文字贴图纹理（牌匾正面用，返回 CanvasTexture 而非 sprite）。 */
function textTexture(lines, opts = {}) {
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
  return tex;
}

/**
 * 店名立体牌匾（★ 第 6 项：自定义店面立体牌匾，非气泡）。
 * 深色木框 + 内嵌浅色面板（凹进）+ 正面文字 + 两侧立柱挂耳，有真实厚度与立体感。
 * 店名从 CONFIG.street.facade.name 读取（可自定义）。
 */
function buildShopSign() {
  const g = new THREE.Group();
  const W = 4.8;
  const H = 1.25;
  const D = 0.22;
  const name = (CONFIG.street && CONFIG.street.facade && CONFIG.street.facade.name) || '桌游店';
  // 深色外框（凸起，提供厚度）
  g.add(box(W, H, D, 0x5b3a1a, 0, 0, 0));
  // 内嵌浅色面板（略凹进，形成框-板层次）
  g.add(box(W - 0.34, H - 0.34, D * 0.45, 0xf7e7cd, 0, 0, D * 0.18));
  // 正面文字（贴面板正面，固定朝向街道 +z）
  const tex = textTexture([`🎲 ${name}`], {
    width: 512, height: 128, fontSize: 74,
    bg: 'rgba(247,231,205,1)', radius: 10, border: '#a8703a',
  });
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(W - 0.5, H - 0.5),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  face.position.set(0, 0, D / 2 + 0.005);
  g.add(face);
  // 两侧立柱挂耳（立体支撑感）
  g.add(box(0.16, H + 0.3, D + 0.06, 0x8a5a2b, -W / 2 + 0.18, 0.08, 0));
  g.add(box(0.16, H + 0.3, D + 0.06, 0x8a5a2b, W / 2 - 0.18, 0.08, 0));
  // 顶部挑檐（增加立体感）
  g.add(box(W + 0.2, 0.1, D + 0.1, 0x8a5a2b, 0, H / 2 + 0.06, 0.02));
  return g;
}

/** 文字贴图标签牌（实体固定标签：贴门面/门板，不随镜头转）。 */
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
  return makeLabelPlane(tex, opts.w ?? 2.6, opts.h ?? 0.8, { doubleSide: opts.doubleSide });
}

/**
 * 店面门面（PRD B17）：遮阳棚 / 玻璃门 / 店名立体牌匾。
 * ★ 错位修复：装饰统一挂在前墙（z=4.9）外侧街道侧（z>5.05），
 * 遮阳棚向外下斜（修正上下颠倒）。窗户玻璃已并入前墙窗洞（见 populate 墙壁段）。
 */
function buildFacade(group) {
  const OUT = 4.9 + 0.16; // 前墙外侧（街道侧）
  // 门楣横梁（跨店宽，贴前墙外侧——z=5.2 出墙面 0.15，修与前墙共面 z-fight）
  group.add(box(13.6, 0.5, 0.3, 0xc9763f, 0, 2.4, 5.2));
  // ★ 店名立体牌匾（挂在前墙外侧，街道侧）
  const sign = buildShopSign();
  sign.position.set(0, 3.1, OUT);
  group.add(sign);
  // 遮阳棚（条纹棚面，向外下斜——修正上下颠倒：外缘低于内缘）
  const awning = new THREE.Group();
  for (let i = 0; i < 7; i += 1) {
    const stripe = box(
      1.95, 0.07, 1.15,
      i % 2 === 0 ? 0xe07f5c : 0xfff3dd,
      -5.85 + i * 1.95, 2.62, 4.9 + 0.62,
    );
    stripe.rotation.x = 0.3; // ★ 向外（+z 街道侧）下斜，修正颠倒
    awning.add(stripe);
  }
  // 棚骨支撑杆（两侧）
  group.add(awning);
  // 玻璃门（店门 DOOR_POS，双开门扇嵌在前墙门洞 z=4.9，+ 门框立柱）
  // 门扇编组存 userData.doorPanels：有人接近时外滑让行（纯视觉，碰撞不变，
  // 修复"玻璃门常关但人穿门而过"的视觉/碰撞错配）。
  group.add(box(0.16, 2.15, 0.34, 0xf3e2c2, DOOR_POS[0] - 0.95, 1.07, 4.9));
  group.add(box(0.16, 2.15, 0.34, 0xf3e2c2, DOOR_POS[0] + 0.95, 1.07, 4.9));
  const doorPanels = [];
  for (const side of [-1, 1]) {
    const door = new THREE.Group();
    door.position.set(DOOR_POS[0] + side * 0.44, 0, 4.9);
    const doorGlass = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 1.85, 0.1),
      makeToonMaterial(0xcdeaf5, { transparent: true, opacity: 0.5 }),
    );
    doorGlass.position.set(0, 1.02, 0);
    door.add(doorGlass);
    // 门把手（朝门缝一侧：-side 方向，修正原右侧把手朝外的不对称）
    door.add(cylinder(0.03, 0.03, 0.18, 0xf2d8a8, -side * 0.28, 1.0, 0.12));
    door.userData.side = side;
    door.userData.baseX = door.position.x;
    group.add(door);
    doorPanels.push(door);
  }
  group.userData.doorPanels = doorPanels;
}

/**
 * 玻璃门滑动开/关（纯视觉，不触碰碰撞 AABB）。
 * 有人（玩家/顾客）接近门口时两扇沿 x 外滑并略向街道侧让位，远离后合拢。
 * v3：nearStaff 时员工通道门（staffDoorPivot）向库房内旋开。
 * @param {THREE.Group} shopGroup buildShop 的 group（含 userData.doorPanels）
 * @param {boolean} near 是否有人接近店门
 * @param {number} dt 帧间隔（秒）
 * @param {boolean} [staffDoorOpen] 库房门状态（手动开关，gs.staffDoorOpen）
 */
export function animateDoors(shopGroup, near, dt, staffDoorOpen = false) {
  const doors = shopGroup.userData.doorPanels;
  if (!doors || doors.length === 0) return;
  const cur = shopGroup.userData.doorOpenT ?? 0;
  const t = cur + ((near ? 1 : 0) - cur) * Math.min(1, dt * 6);
  shopGroup.userData.doorOpenT = t;
  for (const door of doors) {
    door.position.x = door.userData.baseX + door.userData.side * 0.72 * t;
    door.position.z = 4.9 + 0.09 * t; // 滑到门框立柱外侧，避免与立柱重叠
  }
  // 员工通道门（库房）：手动开关状态驱动（不再自动开启）
  const pivot = shopGroup.userData.staffDoorPivot;
  if (pivot) {
    const curS = shopGroup.userData.staffDoorOpenT ?? 0;
    const ts = curS + ((staffDoorOpen ? 1 : 0) - curS) * Math.min(1, dt * 6);
    shopGroup.userData.staffDoorOpenT = ts;
    pivot.rotation.y = 1.4 * ts; // +z 门扇转向 -x（库房内）
  }
}

/**
 * 员工通道门（v3：门洞 z∈[-1.6,-0.4] 真实通行，门扇绕北框铰链内开）。
 * 面板挂在 pivot 上（铰链在 z=-1.5 框柱），接近时向库房内旋开。
 */
function buildStaffDoor(group) {
  const g = new THREE.Group();
  // 铰链 pivot 位于门框北柱（z=-1.55）；门扇关时贴在墙面（x=-6.9 平面）
  const pivot = new THREE.Group();
  pivot.position.set(-6.9, 0, -1.55);
  // 门板（金属灰）：局部中心 z=+0.55 → 关时覆盖 z∈[-1.5,-0.4]
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 1.9, 1.1),
    makeToonMaterial(0x8c96a8),
  );
  panel.position.set(0, 0.95, 0.55);
  panel.castShadow = true;
  addOutline(panel);
  pivot.add(panel);
  // 门缝线上沿 + 门把手（随门扇）
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 1.1), makeToonMaterial(0x5b6b8c));
  seam.position.set(0, 1.88, 0.55);
  pivot.add(seam);
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8),
    makeToonMaterial(0xf2d8a8),
  );
  handle.position.set(0.08, 1.0, 0.15);
  pivot.add(handle);
  // 「库房」小牌：固定在门框南柱墙上（不随门扇摆动——真实店铺门牌装在墙上）
  const badge = textPlane(['📦 库房'], {
    width: 160, height: 80, fontSize: 40, w: 0.52, h: 0.26,
    bg: 'rgba(91,107,140,0.95)', border: '#3a4a66', color: '#ffffff', radius: 12,
    doubleSide: true, // 双面可读（不再随视角消失）
  });
  badge.rotation.y = Math.PI / 2; // 面朝店内 +x
  badge.position.set(-6.71, 1.75, -0.15); // 门洞南侧墙上
  g.add(badge);
  g.add(pivot);
  group.add(g);
  group.userData.staffDoorPivot = pivot;
  return g;
}

/**
 * 构建店铺场景（可重复调用以按升级重建）。
 * @param {THREE.Scene} scene
 * @param {object} gs GameState（读取升级等级决定体验桌数量等）
 * @returns {{group: THREE.Group, positions: object, rebuild: Function}}
 */
export function buildShop(scene, gs) {
  const group = new THREE.Group();
  scene.add(group);

  const positions = {
    door: new THREE.Vector3(DOOR_POS[0], 0, DOOR_POS[1]),
    waitPoint: new THREE.Vector3(WAIT_POS[0], 0, WAIT_POS[1]),
    queuePoint: new THREE.Vector3(QUEUE_POS[0], 0, QUEUE_POS[1]),
    checkout: new THREE.Vector3(CHECKOUT_POS[0], 0, CHECKOUT_POS[1] + 0.9),
    /** B23 员工通道门交互点（视觉门在后仓墙面上，交互时打开后仓面板）。 */
    staffDoor: new THREE.Vector3(STAFF_DOOR_POS[0] + 0.55, 0, STAFF_DOOR_POS[1]),
    shelves: [], // v3：按货架序号 0~3 的交互点（populate 内填充）
    experienceSlots: [],
    /** 结账队列站位：queuePoint 起沿 -z 每 0.55 一位（架构 §5.5）。 */
    queueSlots: Array.from({ length: 5 }, (_, i) => new THREE.Vector3(
      QUEUE_POS[0], 0, QUEUE_POS[1] - i * 0.55,
    )),
  };

  function populate() {
    // ★ rebuild 保持屋顶显隐：新建 roofGroup 默认 visible=true，直接替换会让
    // 等距俯瞰下屋顶盖住整个店内（显隐唯一权威是 main.js updateFpOverlay）。
    const prevRoofVisible = group.userData.roof ? group.userData.roof.visible : false;
    // 清空重建
    while (group.children.length > 0) {
      const child = group.children.pop();
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }

    // 地板 + 地毯
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.3, 10),
      makeToonMaterial(0xf3d9a4),
    );
    floor.position.set(0, -0.15, 0);
    floor.receiveShadow = true;
    group.add(floor);
    const rug = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 0.06, 24),
      makeToonMaterial(0xff9f43),
    );
    rug.position.set(WAIT_POS[0], 0.03, WAIT_POS[1]);
    rug.receiveShadow = true;
    group.add(rug);

    // 四面墙壁（★ 恒显，不做视角隐藏——修复"没有墙壁"）+ 前墙开窗洞/门洞。
    // 后墙 z=-4.9 / 左墙 x=-6.9 / 右墙 x=6.9 / 前墙 z=4.9（两窗洞 + 门洞）。
    const WALL = 0xffe8c2;
    group.add(box(14, 2.6, 0.3, WALL, 0, 1.3, -4.9));   // 后墙
    // 左墙 x=-6.9（v3 开门洞 z∈[-1.6,-0.4] 通库房）：北段 + 南段 + 门框
    group.add(box(0.3, 2.6, 3.4, WALL, -6.9, 1.3, -3.3)); // 北段 z∈[-5,-1.6]
    group.add(box(0.3, 2.6, 5.4, WALL, -6.9, 1.3, 2.3));  // 南段 z∈[-0.4,5]
    group.add(box(0.34, 2.15, 0.12, 0xf3e2c2, -6.9, 1.07, -1.55)); // 门框北柱
    group.add(box(0.34, 2.15, 0.12, 0xf3e2c2, -6.9, 1.07, -0.45)); // 门框南柱
    group.add(box(0.34, 0.5, 1.3, 0xf3e2c2, -6.9, 2.35, -1.0));    // 门楣
    // 右墙 x=6.9：收购右邻铺（wing_right）→ 开门洞常通翼房；否则整墙
    if (gs.expansion && gs.expansion.wing_right) {
      group.add(box(0.3, 2.6, 3.4, WALL, 6.9, 1.3, -3.3)); // 北段 z∈[-5,-1.6]
      group.add(box(0.3, 2.6, 5.4, WALL, 6.9, 1.3, 2.3));  // 南段 z∈[-0.4,5]
      group.add(box(0.34, 2.15, 0.12, 0xf3e2c2, 6.9, 1.07, -1.55)); // 门框北柱
      group.add(box(0.34, 2.15, 0.12, 0xf3e2c2, 6.9, 1.07, -0.45)); // 门框南柱
      group.add(box(0.34, 0.5, 1.3, 0xf3e2c2, 6.9, 2.35, -1.0));    // 门楣
      buildWingRoom(group);
    } else {
      group.add(box(0.3, 2.6, 10, WALL, 6.9, 1.3, 0));     // 右墙（整）
    }
    // 向上加层（loft）：阁楼板 + 护栏 + 斜靠木梯（名店象征）
    if (gs.expansion && gs.expansion.loft) {
      const loft = new THREE.Group();
      loft.add(box(10, 0.2, 3, 0xd8b98a, 0, 3.2, -3.3));           // 阁楼板
      loft.add(box(10, 0.5, 0.08, 0x8a5a2b, 0, 3.45, -1.85));      // 前护栏
      group.add(loft);
      const ladder = new THREE.Group();
      ladder.add(box(0.06, 2.6, 0.06, 0x8a5a2b, -0.17, 1.1, 0));   // 左杆
      ladder.add(box(0.06, 2.6, 0.06, 0x8a5a2b, 0.17, 1.1, 0));    // 右杆
      for (let i = 0; i < 5; i += 1) {
        ladder.add(box(0.4, 0.06, 0.06, 0xa8703a, 0, 0.2 + i * 0.5, 0)); // 横档
      }
      ladder.rotation.z = -0.3; // 斜靠墙
      ladder.position.set(5.6, 0.2, -1.3);
      group.add(ladder);
    }
    // 前墙 z=4.9：窗洞开在 wx∈{-3.0, 0.6}（宽 2.4、高 1.35、中心 y1.32），门洞开在 x∈[4.9,6.7]
    const FZ = 4.9;
    // 全高墙段（避开窗洞与门洞）
    const fullSegs = [
      [-7, -4.2], [-1.8, -0.6], [1.8, 4.9], [6.7, 7],
    ];
    for (const [x0, x1] of fullSegs) {
      const w = x1 - x0;
      group.add(box(w, 2.6, 0.3, WALL, (x0 + x1) / 2, 1.3, FZ));
    }
    // 窗洞下沿（窗台）与上沿（窗楣），各盖在窗洞 x 区间
    for (const [x0, x1] of [[-4.2, -1.8], [-0.6, 1.8]]) {
      const w = x1 - x0;
      const cx = (x0 + x1) / 2;
      group.add(box(w, 0.64, 0.3, WALL, cx, 0.32, FZ));  // 窗台（y 0~0.64）
      group.add(box(w, 0.62, 0.3, WALL, cx, 2.29, FZ));  // 窗楣（y 1.98~2.6）
    }
    // 门洞上沿（门楣，y 2.1~2.6，x∈[4.9,6.7]）
    group.add(box(1.8, 0.5, 0.3, WALL, 5.8, 2.35, FZ));
    // 窗玻璃嵌在窗洞内（z=4.9 墙面）+ 窗框
    for (const wx of [-3.0, 0.6]) {
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(2.36, 1.3, 0.08),
        makeToonMaterial(0xbfe4f2, { transparent: true, opacity: 0.5 }),
      );
      glass.position.set(wx, 1.31, FZ);
      group.add(glass);
      group.add(box(2.46, 0.08, 0.34, 0xf3e2c2, wx, 0.66, FZ)); // 窗台框
      group.add(box(2.46, 0.08, 0.34, 0xf3e2c2, wx, 1.96, FZ)); // 窗楣框
      group.add(box(0.08, 1.38, 0.34, 0xf3e2c2, wx - 1.2, 1.31, FZ)); // 左框
      group.add(box(0.08, 1.38, 0.34, 0xf3e2c2, wx + 1.2, 1.31, FZ)); // 右框
    }

    // 屋顶（★ 独立 roofGroup：第一人称显示，等距俯瞰隐藏，修复"没有屋顶"）
    const roofGroup = new THREE.Group();
    const roof = new THREE.Mesh(new THREE.BoxGeometry(14.4, 0.25, 10.4), makeToonMaterial(0xf7e7cd));
    roof.position.set(0, 2.72, 0);
    roof.receiveShadow = true;
    addOutline(roof);
    roofGroup.add(roof);
    for (const lx of [-2.2, 2.2]) {
      roofGroup.add(cylinder(0.05, 0.05, 0.5, 0x8a5a2b, lx, 2.45, 0));   // 吊绳
      roofGroup.add(cylinder(0.02, 0.3, 0.28, 0xffd98a, lx, 2.1, 0));   // 灯罩
    }
    roofGroup.visible = prevRoofVisible; // 显隐延续 rebuild 前状态（默认隐藏）
    group.add(roofGroup);
    group.userData.roof = roofGroup; // main.js 按视角切换显隐（fps 显 / iso 隐）

    // 店面门面（招牌/橱窗/遮阳棚/玻璃门）+ B23 员工通道门（视觉门，不开通行）
    buildFacade(group);
    group.userData.staffDoor = buildStaffDoor(group);

    // 货架 × 4（v3：去品类化，positions.shelves 为按货架序号 0~3 的交互点数组）
    // 2026-09 布局模式：customLayout 覆盖默认位（sim/layout.js 单一真值；含 rot 朝向）
    const layout = layoutOf(gs);
    positions.shelves = [];
    for (let i = 0; i < SHELF_X.length; i += 1) {
      const shelf = buildShelf(SHELF_COLORS[i]);
      // 货架升级：视觉上加高（缩放真值与碰撞 hx / shelf.js 格位共用 shelfVisualScale）
      const shelfScale = shelfVisualScale(gs.upgrades.shelf);
      shelf.scale.set(shelfScale, shelfScale, 1);
      const lp = layout.shelves[i];
      shelf.position.set(lp.x, 0, lp.z);
      shelf.rotation.y = ((lp.rot || 0) * Math.PI) / 180;
      shelf.userData.layoutKind = 'shelf';
      shelf.userData.layoutIdx = i;
      group.add(shelf);
      const aOff = rotOffset(lp.rot || 0, 0, 1.0);
      positions.shelves.push(new THREE.Vector3(lp.x + aOff.x, 0, lp.z + aOff.z));
    }

    // 体验桌：主区 min(1+experienceLevel, 4) 张 + 翼房 2 张（收购 wing_right 后）
    positions.experienceSlots = [];
    const mainTableCount = Math.min(
      CONFIG.experience.slotBase + gs.upgrades.experience, 4,
    );
    const wingTableCount = (gs.expansion && gs.expansion.wing_right) ? 2 : 0;
    positions.mainTableCount = mainTableCount;
    // 布局池：主区 4 + 翼房 2（与 EXP_SLOT_POS 同序；取主区前 N + 翼房段）
    const tableLayout = layout.tables.slice(0, mainTableCount)
      .concat(layout.tables.slice(4, 4 + wingTableCount));
    for (let i = 0; i < tableLayout.length; i += 1) {
      const { x, z, rot } = tableLayout[i];
      const table = buildExperienceTable();
      table.position.set(x, 0, z);
      table.rotation.y = (((rot || 0) * Math.PI) / 180);
      // 布局拖动标记：idx 用池内原序号（主区 0~3 / 翼房 4~5），customLayout 按原序覆盖
      table.userData.layoutKind = 'table';
      table.userData.layoutIdx = i < mainTableCount ? i : 4 + (i - mainTableCount);
      group.add(table);
      const tOff = rotOffset(rot || 0, -0.4, 0.9);
      positions.experienceSlots.push(new THREE.Vector3(x + tOff.x, 0, z + tOff.z));
    }

    // 收银台
    const counter = buildCheckoutCounter();
    counter.position.set(layout.checkout.x, 0, layout.checkout.z);
    counter.rotation.y = ((layout.checkout.rot || 0) * Math.PI) / 180;
    counter.userData.layoutKind = 'checkout';
    counter.userData.layoutIdx = 0;
    group.add(counter);
    // 布局模式：收银交互点与队列跟随收银台（含朝向：队列排在柜台后侧）
    const cRot = layout.checkout.rot || 0;
    const cFront = rotOffset(cRot, 0, 0.9);
    positions.checkout.set(layout.checkout.x + cFront.x, 0, layout.checkout.z + cFront.z);
    const q0 = rotOffset(cRot, 0, -0.9);
    positions.queuePoint.set(layout.checkout.x + q0.x, 0, layout.checkout.z + q0.z);
    positions.queueSlots.forEach((v, i) => {
      const qi = rotOffset(cRot, 0, -0.9 - i * 0.55);
      v.set(layout.checkout.x + qi.x, 0, layout.checkout.z + qi.z);
    });

    // 门口地垫
    const mat = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.06, 1.2),
      makeToonMaterial(0xe05252),
    );
    mat.position.set(DOOR_POS[0], 0.03, DOOR_POS[1]);
    group.add(mat);

    // 装饰：盆栽 + 吊灯（装修等级越高越多）
    const plant1 = buildPlant();
    plant1.position.set(-6.2, 0, -4.2);
    group.add(plant1);
    if (gs.upgrades.decor >= 2) {
      const plant2 = buildPlant();
      plant2.position.set(6.3, 0, -4.2);
      group.add(plant2);
    }
    if (gs.upgrades.decor >= 3) {
      const banner = box(3.2, 0.7, 0.08, 0xf29ec4, 0, 2.4, -4.7);
      group.add(banner);
    }
  }

  populate();

  return {
    group,
    positions,
    /** 升级后重建店铺（刷新体验位数量与装饰）。 */
    rebuild(newGs) {
      gs = newGs;
      populate();
    },
  };
}
