/**
 * shelf.js — 货架陈列（v3 格池化）：4 货架 × 9 格，任意 SKU 可放任意格。
 *
 * 陈列规则（WYSIWYG，直接读 gs.shelfSlots 真值）：
 *   - 有货格（qty>0）→ 按类型陈列：桌游/饮品 = 单件 GLB 精美模型（缺资产回退程序化）；
 *     周边 = 梯形敞开置物盒 + min(qty,3) 个 0.5× 小样（一盒多件占一格）。
 *   - 每个有货格挂价格标签（emoji + 售价；低于指导绿色 / 高于指导 1.25× 红色）。
 *   - 空格不显示任何东西（货架初始全空，摆上才可见可售）。
 *
 * 约束：挂在 shop.js 货架挂载点上；不新增任何障碍 AABB；禁 Math.random。
 *
 * @module scene/shelf
 */

import * as THREE from 'three';
import { makeToonMaterial, addOutline, makeLabelPlane } from './scene.js';
import { shelfVisualScale } from './firstPerson.js';
import { getSkuAsset, ensureSkuAsset } from './productAssets.js';
import { rentFeeOf } from '../sim/economy.js';
import { layoutOf, rotOffset } from '../sim/layout.js';
import { CONFIG } from '../config.js';

/** 无 SKU 时的中性占位色。 */
const FALLBACK_COLOR = 0xcccccc;

/**
 * 货架 3 层 × 3 列的相对格位（★ 与 shop.js buildShelf 层板几何对齐）：
 * 层板中心 y = 0.4 + row×0.55、厚 0.08 → 顶面 0.44 + row×0.55，商品坐于板顶
 * （修复旧值 0.58 基准导致的悬浮 0.14，及升级放大后 2/3 层埋进层板的问题）。
 * 货架升级时 shop.js 对货架 x/y 放大 shelfScale → 格位同步缩放。
 * @param {number} idx 0~8
 * @param {number} shelfScale shelfVisualScale(gs.upgrades.shelf)
 */
function slotOffset(idx, shelfScale = 1) {
  const row = Math.floor(idx / 3);
  const col = idx % 3;
  return {
    dx: (-0.45 + col * 0.45) * shelfScale,
    dy: (0.44 + row * 0.55) * shelfScale,
    dz: 0,
  };
}

/** 资产就绪回调（buildShelves 注入）：GLB 加载完成后把在架格标记过期触发重建。 */
let notifyAssetReady = null;

/** 销毁商品实例；GLB 克隆共享几何/材质（userData.sharedAsset），跳过 dispose。 */
function disposeItem(mesh) {
  if (mesh.userData && mesh.userData.sharedAsset) return;
  mesh.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

// ============================================================
// 价格标签（每有货格一个 sprite，CanvasTexture 缓存）
// ============================================================

const priceTagCache = new Map();

/** 价格标签贴图：emoji + 💰售价（桌游加一行租价，需求 5/6）；key = sku|price|rent。 */
function priceTagTexture(skuId, price, rentFee = 0) {
  const key = `${skuId}|${price}|${rentFee}`;
  if (priceTagCache.has(key)) return priceTagCache.get(key);
  const sku = CONFIG.skus[skuId];
  const twoLines = rentFee > 0;
  const canvas = document.createElement('canvas');
  canvas.width = 144;
  canvas.height = twoLines ? 84 : 64;
  const ctx = canvas.getContext('2d');
  // 价格色：≤指导 绿 / ≤1.25× 米白 / 更高 红
  const ratio = sku ? price / sku.guidePrice : 1;
  const fg = ratio <= 1 ? '#2e6b3e' : ratio <= 1.25 ? '#5b3a1a' : '#b03030';
  ctx.fillStyle = 'rgba(255, 250, 240, 0.96)';
  ctx.beginPath();
  ctx.roundRect(2, 2, 140, canvas.height - 4, 10);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#8a5a2b';
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '28px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
  ctx.fillText(sku ? sku.emoji : '📦', 28, twoLines ? 26 : 34);
  ctx.fillStyle = fg;
  ctx.font = 'bold 28px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(`¥${price}`, 92, twoLines ? 26 : 34);
  if (twoLines) {
    ctx.fillStyle = '#5b6b8c';
    ctx.font = 'bold 22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`租 ¥${rentFee}`, 92, 60);
    ctx.fillText('🎲', 28, 58);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  priceTagCache.set(key, tex);
  return tex;
}

/** 价格标签牌（实体固定标签：贴层板前缘、面朝 +z 顾客侧，不随镜头转；桌游双行更高）。 */
function makePriceTag(skuId, price, rentFee = 0) {
  const h = rentFee > 0 ? 0.19 : 0.14;
  return makeLabelPlane(priceTagTexture(skuId, price, rentFee), 0.32, h);
}

// ============================================================
// 陈列模型（GLB 双路径 + 程序化回退）
// ============================================================

/** 商品 emoji 标签贴图（程序化回退用，缓存）。 */
const productLabelCache = new Map();
function productLabelTexture(emoji) {
  const key = String(emoji);
  if (productLabelCache.has(key)) return productLabelCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255,250,240,0.95)';
  ctx.beginPath();
  ctx.roundRect(4, 4, 56, 56, 10);
  ctx.fill();
  ctx.font = '40px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 32, 36);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  productLabelCache.set(key, tex);
  return tex;
}

/** 商品 emoji 标签牌（贴在回退模型正面，实体固定标签）。 */
function makeProductLabel(emoji) {
  return makeLabelPlane(productLabelTexture(emoji), 0.18, 0.18);
}

/**
 * GLB 克隆（共享几何/材质）；未加载则触发加载并返回 null（调用方走回退）。
 * @param {string} assetId SKU id 或 'merch_bin' 等资产 id
 * @param {number} [scale] 整体缩放（小样 0.5）
 */
function cloneAsset(assetId, scale = 1) {
  const asset = getSkuAsset(assetId);
  if (!asset) {
    ensureSkuAsset(assetId, notifyAssetReady || undefined);
    return null;
  }
  const inst = asset.clone(true);
  inst.userData.sharedAsset = true;
  if (scale !== 1) inst.scale.setScalar(scale);
  return inst;
}

/** 梯形敞开置物盒（周边陈列）：GLB 优先；回退 = 底板 + 高背板 + 低前挡 + 侧板。 */
function makeMerchBin() {
  const glb = cloneAsset('merch_bin');
  if (glb) return glb;
  const g = new THREE.Group();
  const wood = makeToonMaterial(0xa8703a);
  const dark = makeToonMaterial(0x8a5a2b);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.28), wood);
  bottom.position.y = 0.015;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.025), dark);
  back.position.set(0, 0.08, -0.13);
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.025), dark);
  front.position.set(0, 0.035, 0.13);
  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.12, 0.26), wood);
  sideL.position.set(-0.16, 0.06, 0);
  const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.12, 0.26), wood);
  sideR.position.set(0.16, 0.06, 0);
  g.add(bottom, back, front, sideL, sideR);
  // 逐件描边（禁止 traverse 中 addOutline：描边壳会被再次访问 → 无限递归）
  for (const part of [bottom, back, front, sideL, sideR]) {
    part.castShadow = true;
    addOutline(part);
  }
  return g;
}

/** 周边小样（置物盒内）：GLB 0.5× 克隆；回退 = 带 emoji 标签的小盒。 */
function makeMiniModel(color, skuId) {
  const glb = skuId ? cloneAsset(skuId, 0.3) : null;
  if (glb) return glb;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.1), makeToonMaterial(color));
  body.position.y = 0.06;
  addOutline(body);
  g.add(body);
  if (skuId && CONFIG.skus[skuId]) {
    const label = makeProductLabel(CONFIG.skus[skuId].emoji);
    label.scale.set(0.09, 0.09, 1);
    label.position.set(0, 0.07, 0.055);
    g.add(label);
  }
  return g;
}

/**
 * 程序化回退商品模型（GLB 未就绪/缺失时）：按品类差异化——
 * 桌游 = 带盖扁平盒；饮品 = 圆柱杯 + 盖 + 吸管；周边/默认 = 小盒 + 标签。
 * @param {number} color 占位色
 * @param {string|null} skuId
 * @returns {THREE.Group}
 */
function makeFallbackProduct(color, skuId) {
  const g = new THREE.Group();
  const sku = skuId && CONFIG.skus ? CONFIG.skus[skuId] : null;
  const cat = sku ? sku.cat : null;
  const tint = new THREE.Color(color);

  if (cat === 'boardgame_low' || cat === 'boardgame_high') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), makeToonMaterial(tint.getHex()));
    body.position.y = 0.1;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.28), makeToonMaterial(tint.clone().offsetHSL(0, 0, 0.08).getHex()));
    lid.position.y = 0.225;
    g.add(body, lid);
    if (sku) {
      const label = makeProductLabel(sku.emoji);
      label.position.set(0, 0.13, 0.14);
      g.add(label);
    }
  } else if (cat === 'snacks') {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.24, 12), makeToonMaterial(tint.getHex()));
    cup.position.y = 0.12;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.03, 12), makeToonMaterial(0xfff3dd));
    lid.position.y = 0.255;
    const straw = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 6), makeToonMaterial(0xe05252));
    straw.position.set(0.03, 0.32, 0);
    straw.rotation.z = 0.25;
    g.add(cup, lid, straw);
    if (sku) {
      const label = makeProductLabel(sku.emoji);
      label.position.set(0, 0.13, 0.1);
      g.add(label);
    }
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.22), makeToonMaterial(tint.getHex()));
    body.position.y = 0.13;
    g.add(body);
    if (sku) {
      const label = makeProductLabel(sku.emoji);
      label.position.set(0, 0.13, 0.12);
      g.add(label);
    }
  }
  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; }
  });
  for (const child of g.children) {
    if (child.isMesh) addOutline(child);
  }
  return g;
}

/** 品类 → 专属托盘资产 id（2026-09 需求：全品类专属托盘）。 */
const TRAY_OF = {
  boardgame_low: 'game_tray',
  boardgame_high: 'game_tray',
  snacks: 'drink_tray',
  merch: 'merch_bin',
};
/** 品类 → 小样缩放。 */
const MINI_SCALE_OF = { boardgame_low: 0.3, boardgame_high: 0.3, snacks: 0.32, merch: 0.3 };

/** 托盘（GLB 优先；回退 = 通用木盒托盘）。 */
function makeTray(trayId) {
  const glb = cloneAsset(trayId);
  if (glb) return glb;
  return makeMerchBin(); // 回退木盒托盘（merch_bin 缺省时同兜底）
}

/**
 * 单格陈列内容（有货格，2026-09 需求 3/追加）：
 * 全品类 = 专属托盘 + 小样，**托盘内小样数量与槽位 qty 一一对应**（上限 min(qty,9)）。
 * @returns {THREE.Group}
 */
function makeSlotDisplay(skuId, qty) {
  const sku = skuId ? CONFIG.skus[skuId] : null;
  const g = new THREE.Group();
  const cat = sku ? sku.cat : 'merch';
  g.add(makeTray(TRAY_OF[cat] || 'merch_bin'));
  const n = Math.min(Math.max(qty, 1), 9); // 数量与槽位 qty 一致（一格至多 9 件）
  const scale = MINI_SCALE_OF[cat] || 0.3;
  for (let i = 0; i < n; i += 1) {
    const mini = makeMiniModel(0xf29ec4, skuId, scale);
    // 3×3 网格摆进托盘内腔
    const col = i % 3;
    const rowIdx = Math.floor(i / 3);
    mini.position.set(-0.09 + col * 0.09, 0.04, -0.08 + rowIdx * 0.08);
    g.add(mini);
  }
  return g;
}

// ============================================================
// 陈列同步
// ============================================================

/**
 * 构建货架陈列层（挂在 shop.js 货架位置）。
 * @param {THREE.Scene} scene
 * @param {object} gs GameState
 * @param {{positions: object}} shopCtx buildShop 返回值（读 positions.shelves 数组）
 * @returns {{group: THREE.Group, sync: Function}}
 */
export function buildShelves(scene, gs, shopCtx) {
  const group = new THREE.Group();
  scene.add(group);

  /** @type {Map<number, {holder: THREE.Group, slots: Array<{key: string|null, group: THREE.Group|null, tag: THREE.Sprite|null}>}>} */
  const shelves = new Map();

  // GLB 资产加载完成 → 全部格标记过期（key 置 undefined），下一帧 sync 重建
  notifyAssetReady = () => {
    for (const entry of shelves.values()) {
      for (const s of entry.slots) s.key = undefined;
    }
  };

  return {
    group,
    /** 每帧（或库存变化后）刷新陈列。 */
    sync(currentGs) {
      syncShelves({ group, shelves }, currentGs, shopCtx);
    },
  };
}

/** 移除一格的陈列内容（模型 + 价格标签）。 */
function clearSlot(entry, i) {
  const s = entry.slots[i];
  if (s.group) {
    entry.holder.remove(s.group);
    disposeItem(s.group);
    s.group = null;
  }
  if (s.tag) {
    entry.holder.remove(s.tag);
    s.tag.geometry.dispose(); // PlaneGeometry 每标签独立
    s.tag.material.dispose(); // CanvasTexture 共享缓存，只 dispose 材质
    s.tag = null;
  }
  s.key = null;
}

/**
 * 货架陈列同步（独立导出便于测试）。
 * @param {object} ctx {group, shelves}
 * @param {object} gs GameState
 * @param {{positions: object}} shopCtx
 */
export function syncShelves(ctx, gs, shopCtx) {
  const slotsPerShelf = (CONFIG.shelf && CONFIG.shelf.slotsPerShelf) || 9;
  const shelfCount = (shopCtx.positions.shelves || []).length;
  // 货架升级视觉放大系数（与 shop.js / firstPerson.js 共用真值）
  const shelfScale = shelfVisualScale(gs && gs.upgrades ? gs.upgrades.shelf : 1);

  for (let shelfIdx = 0; shelfIdx < shelfCount; shelfIdx += 1) {
    const shelfPos = shopCtx.positions.shelves[shelfIdx];
    if (!shelfPos) continue;
    let entry = ctx.shelves.get(shelfIdx);
    if (!entry) {
      const holder = new THREE.Group();
      ctx.group.add(holder);
      entry = {
        holder,
        slots: Array.from({ length: slotsPerShelf }, () => ({ key: null, group: null, tag: null })),
      };
      ctx.shelves.set(shelfIdx, entry);
    }
    // 布局模式：货架可能被移动/旋转——holder 每帧对齐最新交互点与朝向
    entry.holder.position.copy(shelfPos);
    entry.holder.position.z -= 1.0;
    // 朝向：shelfPos 是「本体+前向 1.0」的交互点，用 layoutOf 的 rot 反推 holder 朝向
    const lp = gs ? layoutOf(gs).shelves[shelfIdx] : null;
    const rad = lp ? ((lp.rot || 0) * Math.PI) / 180 : 0;
    entry.holder.rotation.y = rad;
    // 交互点含前向偏移，holder 需回到本体中心
    if (rad !== 0) {
      const back = rotOffset(lp.rot || 0, 0, -1.0);
      entry.holder.position.set(shelfPos.x + back.x, 0, shelfPos.z + back.z);
    }

    for (let i = 0; i < slotsPerShelf; i += 1) {
      const slot = gs && gs.shelfSlots ? gs.shelfSlots[shelfIdx * slotsPerShelf + i] : null;
      const skuId = slot && slot.qty > 0 ? slot.sku : null;
      const price = skuId && gs.skuPrices ? gs.skuPrices[skuId] : 0;
      // v3 需求 5：桌游（boardgame_*）显示租价
      const isBoardgame = skuId
        && (CONFIG.skus[skuId].cat === 'boardgame_low' || CONFIG.skus[skuId].cat === 'boardgame_high');
      const rent = isBoardgame ? rentFeeOf(gs, skuId) : 0;
      // 重建键：SKU | 小样数量档（托盘数量与 qty 一致，9 档）| 价格 | 租价 | 放大系数
      const qtyBucket = skuId ? Math.min(slot.qty, 9) : 1;
      const key = skuId
        ? `${skuId}|${qtyBucket}|${price}|${rent}|${shelfScale}`
        : null;
      const cur = entry.slots[i];
      if (cur.key === key) continue;
      clearSlot(entry, i);
      cur.key = key;
      if (!skuId) continue;
      const off = slotOffset(i, shelfScale);
      const display = makeSlotDisplay(skuId, slot.qty);
      display.position.set(off.dx, off.dy, off.dz);
      display.userData.shelfSlot = shelfIdx * slotsPerShelf + i; // 右键拿货 raycast 命中用
      entry.holder.add(display);
      cur.group = display;
      // 价格标签：贴层板前缘（面向 +z 顾客侧的实体标牌，微上仰便于俯视阅读）
      const tag = makePriceTag(skuId, price, rent);
      tag.raycast = THREE.Mesh.prototype.raycast; // 恢复拾取（价签调价左键命中用；makeLabelPlane 默认禁）
      tag.userData.priceTag = true; // 左键调价 raycast 命中用
      tag.userData.shelfSlot = shelfIdx * slotsPerShelf + i;
      const row = Math.floor(i / 3);
      tag.position.set(off.dx, (0.36 + row * 0.55) * shelfScale, 0.385);
      tag.rotation.x = -0.18;
      entry.holder.add(tag);
      cur.tag = tag;
    }
  }
}
