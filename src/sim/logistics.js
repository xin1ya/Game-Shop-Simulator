/**
 * logistics.js — 物流状态机 + 库存四态 + 货架格位 + 虚拟搬运工。
 *
 * 状态机（架构 §4.1）：
 *   Delivery: ORDERED → IN_TRANSIT → ARRIVED → DONE
 *   Box:      SEALED → (开箱 1.5s) → OPEN → (取货 0.6s) → EMPTY → 移除
 *   库存四态: inTransit → inBox → backroom → onShelf → 售出 / 退货
 *
 * ★ 纪律（共享约定 9）：gs.inventory 是派生聚合，**只有本模块可写**；
 *   任何库存变更后必须调用 syncInventory(gs)。
 * ★ 一箱 = 一取 = 补满一格：boxCapacity(4) === restockPerAction(4) === stackCapByLevel[0](4)。
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/logistics
 */

import { CONFIG } from '../config.js';

/** v3：货架去品类化 —— 36 格全局格池（index = shelfIdx*9 + slotIdx），任何 SKU 可放任意格。 */

/** 某货架（0~3）的 9 个格位下标。 */
export function slotsOfShelf(gs, shelfIdx) {
  const per = CONFIG.shelf.slotsPerShelf;
  const base = shelfIdx * per;
  const out = [];
  for (let i = 0; i < per; i += 1) out.push(base + i);
  return out;
}

/** 全部格位下标（0~35，按货架顺序）。 */
export function slotsAll(gs) {
  return gs.shelfSlots.map((_, i) => i);
}

/** 目标 SKU 所在货架序号（第一个有货格）；无 → -1。 */
export function shelfIndexOfSku(gs, skuId) {
  for (let i = 0; i < gs.shelfSlots.length; i += 1) {
    const s = gs.shelfSlots[i];
    if (s.sku === skuId && s.qty > 0) return Math.floor(i / CONFIG.shelf.slotsPerShelf);
  }
  return -1;
}

/** 该品类任一在售 SKU 所在的第一个货架序号（浏览引导用）；无 → -1。 */
export function shelfIndexOfCat(gs, cat) {
  for (const id of CONFIG.skuOrder) {
    if (CONFIG.skus[id].cat !== cat) continue;
    const idx = shelfIndexOfSku(gs, id);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** 由全部 SKU 四态重算 gs.inventory（守恒不变式唯一维护点）。 */
export function syncInventory(gs) {
  for (const cat of CONFIG.categoryOrder) {
    let sum = 0;
    for (const id of CONFIG.skuOrder) {
      const s = CONFIG.skus[id];
      if (s.cat !== cat) continue;
      const st = gs.skus[id];
      sum += st.inTransit + st.inBox + st.backroom + st.onShelf;
    }
    gs.inventory[cat] = sum;
  }
}

/** 全店库存总件数（四态合计，测试守卫用）。 */
export function totalStock(gs) {
  let n = 0;
  for (const id of CONFIG.skuOrder) {
    const st = gs.skus[id];
    n += st.inTransit + st.inBox + st.backroom + st.onShelf;
  }
  return n;
}

/** 品类在架陈列量 = Σ sku.onShelf（唯一可售库存）。 */
export function onShelfOf(gs, cat) {
  let n = 0;
  for (const id of CONFIG.skuOrder) {
    const s = CONFIG.skus[id];
    if (s.cat === cat) n += gs.skus[id].onShelf;
  }
  return n;
}

/** 品类后仓量 = Σ sku.backroom。 */
export function backroomOfCat(gs, cat) {
  let n = 0;
  for (const id of CONFIG.skuOrder) {
    const s = CONFIG.skus[id];
    if (s.cat === cat) n += gs.skus[id].backroom;
  }
  return n;
}

/** 单 SKU 在架量。 */
export function skuOnShelf(gs, skuId) {
  return gs.skus[skuId].onShelf;
}

/** 品类陈列在售（onShelf>0）的 SKU 列表。 */
export function onSaleSkusOfCat(gs, cat) {
  return CONFIG.skuOrder.filter((id) => CONFIG.skus[id].cat === cat && gs.skus[id].onShelf > 0);
}

/** 全店有陈列的 SKU 数（陈列不足惩罚用，A13）。 */
export function displayedSkuCount(gs) {
  return CONFIG.skuOrder.filter((id) => gs.skus[id].onShelf > 0).length;
}

/** 陈列不足倍率：displayedSku < minDisplayedSku(4) → ×0.85（A13）。 */
export function sparseDisplayMult(gs) {
  return displayedSkuCount(gs) < CONFIG.shelf.minDisplayedSku
    ? CONFIG.shelf.sparseDisplayMult
    : 1;
}

/**
 * 货架三态（A10）：ON_SHELF / IN_BACKROOM / OUT_OF_STOCK。
 * @returns {'ON_SHELF'|'IN_BACKROOM'|'OUT_OF_STOCK'}
 */
export function shelfState(gs, cat) {
  if (onShelfOf(gs, cat) > 0) return 'ON_SHELF';
  if (backroomOfCat(gs, cat) > 0) return 'IN_BACKROOM';
  return 'OUT_OF_STOCK';
}

/**
 * 每格堆叠上限（v3 按实际体积）：min(SKU slotCap, 货架等级上限×2)。
 * 不传 skuId 时返回货架等级上限（旧语义，测试兼容用）。
 */
export function stackCap(gs, skuId = null) {
  const lvlCap = CONFIG.shelf.stackCapByLevel[gs.upgrades.shelf - 1];
  if (!skuId || !CONFIG.skus[skuId]) return lvlCap;
  return Math.min(CONFIG.skus[skuId].slotCap ?? lvlCap, lvlCap * 2);
}

// ============================================================
// 下单 / 发车 / 到店卸箱
// ============================================================

/**
 * 下单（由 economy.restock 调用）：扣现金已在调用方完成。
 * 本函数只生成 Delivery(ORDERED) 并把数量计入 sku.inTransit。
 * 到货时段（2026-09）：白天（MORNING/PREP）下单 → 当晚打烊整理时送到；
 * 晚上（EVENING）下单 → 次日早上备货时送到；其余阶段兜底次日早上。
 * @param {object} gs GameState
 * @param {Record<string, number>} skuOrders { skuId: qty }（已校验、已按箱规整）
 * @returns {{deliveryId: number, boxes: number}|null} 无有效量时返回 null
 */
export function placeOrder(gs, skuOrders) {
  const sameDayEvening = gs.phase !== 'EVENING'; // 白天（MORNING/PREP）下单当晚到
  const delivery = {
    id: gs.logistics.nextDeliveryId,
    state: 'ORDERED',
    eta: 0,
    boxes: [],
    orderedDay: gs.day,
    arriveDay: sameDayEvening ? gs.day : gs.day + 1,
    arrivePhase: sameDayEvening ? 'EVENING' : 'PREP', // 当晚到 / 次日早到
    delayed: gs.eventToday === 'delivery_delay',
  };
  gs.logistics.nextDeliveryId += 1;
  let boxCount = 0;
  const cap = CONFIG.logistics.boxCapacity;
  for (const skuId of CONFIG.skuOrder) {
    const qty = Number(skuOrders[skuId]) || 0;
    if (qty <= 0) continue;
    const nBoxes = Math.floor(qty / cap);
    const rest = qty % cap;
    for (let i = 0; i < nBoxes; i += 1) {
      delivery.boxes.push(makeBox(gs, delivery.id, skuId, cap, delivery.boxes));
      boxCount += 1;
    }
    if (rest > 0) {
      delivery.boxes.push(makeBox(gs, delivery.id, skuId, rest, delivery.boxes));
      boxCount += 1;
    }
    gs.skus[skuId].inTransit += qty;
  }
  if (boxCount === 0) {
    gs.logistics.nextDeliveryId -= 1; // 空单不占 id
    return null;
  }
  gs.logistics.deliveries.push(delivery);
  syncInventory(gs);
  return { deliveryId: delivery.id, boxes: boxCount };
}

/** 收货落点选择（2026-09 需求 5 + 试玩反馈修正）：3×3 列平铺优先——
 * 每次选当前最矮的列（并列取列序靠前者），先铺满一层再自然叠高；
 * 不再「单列堆满再开新列」（实测全部摞在一柱、超 27 箱后无限向上）。 */
function chooseDropColumn(gs, pendingBoxes = []) {
  const dz = CONFIG.street.dropZone;
  const H = CONFIG.logistics.boxHalf;
  const heightOf = (col) => {
    // 层数 = 列内箱数（已到店箱 + 当前订单在建箱；同单连续落点必须错列）
    let n = 0;
    for (const b of [...gs.logistics.boxes, ...pendingBoxes]) {
      if (Math.abs(b.x - col.x) < H * 1.5 && Math.abs(b.z - col.z) < H * 1.5) n += 1;
    }
    return n;
  };
  let best = 0;
  let bestH = Infinity;
  for (let i = 0; i < dz.columns.length; i += 1) {
    const h = heightOf(dz.columns[i]);
    if (h < bestH) { bestH = h; best = i; }
  }
  return { col: best, x: dz.columns[best].x, z: dz.columns[best].z };
}

/** 生成一个快递箱（v3：落点 = dropZone 列式堆叠区 + 物理沉降 {x,z,y,vy,settled}）。
 * pendingBoxes：当前订单已建箱（chooseDropColumn 计入，防同单全部落一列）。 */
function makeBox(gs, deliveryId, skuId, qty, pendingBoxes = []) {
  const drop = chooseDropColumn(gs, pendingBoxes);
  const box = {
    id: gs.logistics.nextBoxId,
    deliveryId,
    sku: skuId,
    qty,
    state: 'SEALED',
    slot: drop.col,
    progress: 0,
    claimedBy: null,
    claimedKind: null,
    // v3 物理（需求 8）：世界坐标 + 竖直速度 + 落定标记
    x: drop.x,
    z: drop.z,
    y: 0, // 卸箱时才从货车落出（unloadDelivery 置 boxDropHeight）
    vy: 0,
    settled: true,
  };
  gs.logistics.nextBoxId += 1;
  return box;
}

/**
 * 阶段开始发车：到期且时段匹配的订单 ORDERED → IN_TRANSIT，写 eta。
 * 到货时段（2026-09）：PREP 发「早上到」单，EVENING 发「当晚到」单；
 * phase 缺省（null）= 不过滤时段、发全部到期单（测试/工具用法；游戏流程必传时段）。
 * 「快递延迟」事件：本日订购的货车 eta += delayEventExtra（A07）。
 * @param {object} gs
 * @param {'PREP'|'EVENING'|null} [phase] 发车时段（null=全部）
 * @returns {number} 本次发车的订单数
 */
export function startDeliveries(gs, phase = null) {
  const lg = CONFIG.logistics;
  let started = 0;
  for (const d of gs.logistics.deliveries) {
    if (d.state !== 'ORDERED') continue;
    if ((d.arriveDay ?? gs.day) > gs.day) continue; // 未到期
    if (phase !== null && (d.arrivePhase ?? 'PREP') !== phase) continue; // 时段不匹配
    d.state = 'IN_TRANSIT';
    d.eta = lg.truckEta + (d.delayed ? lg.delayEventExtra : 0);
    started += 1;
  }
  return started;
}

/**
 * 每 tick 推进在途货车：eta 递减 → ARRIVED → 卸箱。
 * PREP 与 OPEN 阶段均推进（未搬完的箱子在 OPEN 继续）。
 */
export function stepDeliveries(gs, dt) {
  let arrived = false;
  for (const d of gs.logistics.deliveries) {
    if (d.state !== 'IN_TRANSIT') continue;
    d.eta -= dt;
    if (d.eta <= 0) {
      unloadDelivery(gs, d);
      arrived = true;
    }
  }
  stepBoxPhysics(gs, dt); // v3：箱体沉降（需求 8）
  return arrived;
}

// ============================================================
// v3 箱体物理（需求 8：轴对齐 AABB 重力沉降堆叠 + 玩家推箱）
// ============================================================

/** 箱子的支撑面高度：地面 0 或已落定且 xz 半重叠的箱顶。 */
function supportFloor(gs, b) {
  const H = CONFIG.logistics.boxHalf;
  let floor = 0;
  for (const o of gs.logistics.boxes) {
    if (o === b || !o.settled) continue;
    if (Math.abs(o.x - b.x) < H * 1.5 && Math.abs(o.z - b.z) < H * 1.5) {
      floor = Math.max(floor, o.y + H * 2);
    }
  }
  return floor;
}

/** 每 tick 箱体物理：未落定箱受重力下落，落到支撑面即稳（低的先落定）。
 * 已落定箱每 tick 复查支撑——下层箱被搬走/折叠/丢弃后，上层自动重新沉降。 */
export function stepBoxPhysics(gs, dt) {
  const boxes = gs.logistics.boxes;
  if (boxes.length === 0) return;
  const G = CONFIG.logistics.boxGravity;
  const sorted = [...boxes].sort((a, b) => a.y - b.y);
  for (const b of sorted) {
    if (b.settled) {
      // 支撑面消失（抽走下箱）→ 唤醒重新下落
      if (b.y > 0.01 && supportFloor(gs, b) < b.y - 0.01) {
        b.settled = false;
        b.vy = 0;
      } else {
        continue;
      }
    }
    b.vy += G * dt;
    b.y -= b.vy * dt; // vy 向下为正
    const floor = supportFloor(gs, b);
    if (b.y <= floor) {
      b.y = floor;
      b.vy = 0;
      b.settled = true;
    }
  }
}

/**
 * 玩家推箱（需求 8 碰撞）：水平推移落地箱；撞墙/撞箱即停；推出支撑则重新沉降。
 * @returns {boolean} 是否实际移动
 */
export function pushBox(gs, boxId, dx, dz) {
  const b = findBox(gs, boxId);
  if (!b || !b.settled) return false;
  if (b.y > 0.01) return false; // 堆叠上层的箱不推（防整塔塌方）
  const H = CONFIG.logistics.boxHalf;
  let nx = b.x + dx;
  let nz = b.z + dz;
  // 世界边界（与玩家同界；箱心再加半宽余量）
  const eb = {
    minX: CONFIG.firstPerson.bounds.minX + H,
    maxX: CONFIG.firstPerson.bounds.maxX - H,
    minZ: CONFIG.firstPerson.bounds.minZ + H,
    maxZ: CONFIG.street.blockZ - H,
  };
  nx = Math.min(Math.max(nx, eb.minX), eb.maxX);
  nz = Math.min(Math.max(nz, eb.minZ), eb.maxZ);
  // 临街墙平面（z=4.9，门洞 x∈[4.9,6.7]）：箱不穿墙进店
  const inDoorGap = nx > 4.9 && nx < 6.7;
  if (!inDoorGap && b.z > 4.9 + H && nz < 4.9 + H) nz = 4.9 + H;
  if (!inDoorGap && b.z < 4.9 - H && nz > 4.9 - H) nz = 4.9 - H;
  // 撞箱即停（同层落定箱 AABB）
  for (const o of gs.logistics.boxes) {
    if (o === b || !o.settled) continue;
    if (Math.abs(o.y - b.y) < H * 2
      && Math.abs(o.x - nx) < H * 2 && Math.abs(o.z - nz) < H * 2) {
      return false;
    }
  }
  b.x = nx;
  b.z = nz;
  // 推出支撑面 → 重新沉降
  if (b.y > 0.01 && supportFloor(gs, b) < b.y - 0.01) {
    b.settled = false;
    b.vy = 0;
  }
  return true;
}

/** 到店卸箱：sku.inTransit -= boxQty；inBox += boxQty；箱子从货车高度落出（v3 物理）。 */
function unloadDelivery(gs, d) {
  d.state = 'ARRIVED';
  d.eta = 0;
  for (const box of d.boxes) {
    box.y = CONFIG.logistics.boxDropHeight; // 从车厢落出，下 tick 沉降
    box.vy = 0;
    box.settled = false;
    gs.logistics.boxes.push(box);
    const st = gs.skus[box.sku];
    st.inTransit -= box.qty;
    st.inBox += box.qty;
  }
  syncInventory(gs);
}

/** 按 id 找箱（从全部 delivery.boxes 里找，含未卸与已卸）。 */
export function findBox(gs, boxId) {
  for (const d of gs.logistics.deliveries) {
    for (const b of d.boxes) {
      if (b.id === boxId) return b;
    }
  }
  return null;
}

/** 货车单是否全部箱子已取空（→DONE，货车驶离）。 */
function checkDeliveryDone(gs, d) {
  if (d.state !== 'ARRIVED') return;
  const all = d.boxes.every((b) => b.state === 'EMPTY');
  if (all) d.state = 'DONE';
}

// ============================================================
// 开箱 / 取货 / 上架（占用协议 + 中断保留）
// ============================================================

/** 申请占用箱子（claimedKind: 'unbox' | 'pick'）。已被占用返回 false（零状态变化）。 */
export function claimBox(gs, boxId, by, kind) {
  const box = findBox(gs, boxId);
  if (!box) return false;
  if (box.claimedBy !== null) return false;
  if (kind === 'unbox' && box.state !== 'SEALED') return false;
  if (kind === 'pick' && box.state !== 'OPEN') return false;
  box.claimedBy = by;
  box.claimedKind = kind;
  return true;
}

/** 释放占用（中断 / 完成），progress 保留。 */
export function releaseBox(gs, boxId) {
  const box = findBox(gs, boxId);
  if (!box) return;
  box.claimedBy = null;
  box.claimedKind = null;
}

/**
 * 开箱推进：SEALED 箱 progress += dt；≥ unboxTime → OPEN。
 * 调用方须已通过 claimBox('unbox') 占用。
 * @returns {boolean} 本 tick 是否完成开箱
 */
export function unboxTick(gs, box, dt) {
  if (box.state !== 'SEALED' || box.claimedKind !== 'unbox') return false;
  box.progress += dt;
  if (box.progress >= CONFIG.logistics.unboxTime) {
    box.state = 'OPEN';
    box.progress = 0;
    box.claimedBy = null;
    box.claimedKind = null;
    gs.today.boxesOpened += 1;
    return true;
  }
  return false;
}

/**
 * 取货推进：OPEN 箱 progress += dt；≥ pickTime → EMPTY。
 * v3 手持（需求 3）：玩家亲手取货且传入 session → 货入双手（session.carry）；
 * 否则（auto/员工/无 session）→ inBox → backroom（旧语义不变）。
 * @param {object|null} [session] DaySession（仅玩家通道传）
 * @returns {boolean} 本 tick 是否完成取货
 */
export function pickTick(gs, box, dt, session = null) {
  if (box.state !== 'OPEN' || box.claimedKind !== 'pick') return false;
  box.progress += dt;
  if (box.progress >= CONFIG.logistics.pickTime) {
    const st = gs.skus[box.sku];
    st.inBox -= box.qty;
    if (session && box.claimedBy === 'player') {
      // 货入双手（离开四态体系，打烊 closeOutDay 自动入库兜底）
      session.carry = { type: 'item', skuId: box.sku, qty: box.qty };
    } else {
      st.backroom += box.qty;
    }
    box.state = 'EMPTY';
    box.progress = 0;
    box.claimedBy = null;
    box.claimedKind = null;
    syncInventory(gs);
    const d = gs.logistics.deliveries.find((x) => x.id === box.deliveryId);
    if (d) checkDeliveryDone(gs, d);
    // v3：EMPTY 箱不再立即移除（留待折叠/丢弃处理，需求 9）
    return true;
  }
  return false;
}

/** 格位填充（只动格位，不动四态）：同 SKU 未满格优先 → 空格。返回填入件数。 */
function fillSlots(gs, skuId, n, shelfIdx = null) {
  const cap = stackCap(gs, skuId);
  const idxs = shelfIdx === null ? slotsAll(gs) : slotsOfShelf(gs, shelfIdx);
  let put = 0;
  while (n > 0) {
    let target = -1;
    for (const i of idxs) {
      const s = gs.shelfSlots[i];
      if (s.sku === skuId && s.qty < cap) { target = i; break; }
    }
    if (target === -1) {
      for (const i of idxs) {
        if (gs.shelfSlots[i].sku === null) { target = i; break; }
      }
    }
    if (target === -1) break; // 无空位
    const slot = gs.shelfSlots[target];
    const amount = Math.min(n, cap - slot.qty);
    slot.sku = skuId;
    slot.qty += amount;
    n -= amount;
    put += amount;
  }
  return put;
}

/**
 * 补货上架（backroom → onShelf），落格算法（确定性）。
 * v3 自由放置：shelfIdx 指定目标货架（该架放满即停，不外溢到其他货架）；
 * 缺省 null 时全店格池（同 SKU 未满格优先 → 空格按货架顺序）。
 * 玩家交互通过 interaction.js 的进度条调用；员工直接调用（瞬时结算由其 duration 控制）。
 * @param {object} gs GameState
 * @param {string} skuId 目标 SKU
 * @param {number} [maxAmount] 本次上限（默认 restockPerAction = 4）
 * @param {number|null} [shelfIdx] 目标货架序号（0~3）
 * @returns {number} 实际上架件数
 */
export function restockToSlot(gs, skuId, maxAmount = CONFIG.logistics.restockPerAction, shelfIdx = null) {
  const st = gs.skus[skuId];
  if (!st) return 0;
  const n = Math.min(maxAmount, st.backroom);
  if (n <= 0) return 0;
  const put = fillSlots(gs, skuId, n, shelfIdx);
  st.backroom -= put;
  st.onShelf += put;
  if (put > 0) syncInventory(gs);
  return put;
}

/**
 * v3 手持上架（需求 3）：手上货物直接落格（hands → onShelf，不经后仓）。
 * 调用方负责扣减 session.carry。
 * @returns {number} 实际上架件数
 */
export function placeFromHands(gs, skuId, n, shelfIdx = null) {
  const st = gs.skus[skuId];
  if (!st || n <= 0) return 0;
  const put = fillSlots(gs, skuId, n, shelfIdx);
  st.onShelf += put;
  if (put > 0) syncInventory(gs);
  return put;
}

/**
 * 售出取货：从「该 SKU 有货」的格中取 qty 最大的一格（并列取 index 最小）。
 * 取空即解绑格位（qty=0 → sku=null），否则空格仍绑定旧 SKU 会导致
 * restockToSlot 找不到可放格（同 SKU 未满格匹配不上、空格也匹配不上）→
 * 货架永久卡死无法上新（实测第 3 天起全店货架锁 0 的根因）。
 * @returns {boolean} 是否成功
 */
export function takeFromShelf(gs, skuId) {
  const st = gs.skus[skuId];
  if (!st || st.onShelf <= 0) return false;
  let best = -1;
  let bestQty = -1;
  for (const i of slotsAll(gs)) {
    const s = gs.shelfSlots[i];
    if (s.sku === skuId && s.qty > bestQty) {
      best = i;
      bestQty = s.qty;
    }
  }
  if (best === -1) {
    // 格位与四态不同步（迁移兜底）：直接从四态扣
    st.onShelf -= 1;
    syncInventory(gs);
    return true;
  }
  gs.shelfSlots[best].qty -= 1;
  if (gs.shelfSlots[best].qty === 0) {
    gs.shelfSlots[best].sku = null; // 取空解绑，允许其他 SKU 重用该格
  }
  st.onShelf -= 1;
  syncInventory(gs);
  return true;
}

/** 玩家从货架拿起一整格商品入双手（2026-09：右键拿货重新放置）。
 * 取空解绑该格；手上非空拒绝。 @returns {boolean} */
export function takeSlotToHands(gs, session, slotIdx) {
  if (session.carry) return false;
  const slot = gs.shelfSlots && gs.shelfSlots[slotIdx];
  if (!slot || slot.qty <= 0 || !slot.sku) return false;
  const st = gs.skus[slot.sku];
  if (!st) return false;
  session.carry = { type: 'item', skuId: slot.sku, qty: slot.qty };
  st.onShelf -= slot.qty;
  slot.qty = 0;
  slot.sku = null; // 取空解绑（与 takeFromShelf 同语义）
  syncInventory(gs);
  return true;
}

/** 怒走/离店退货：onShelf += 1 并回填格位（全店格池，库存不损失，A24）。 */
export function returnToShelf(gs, skuId) {
  const st = gs.skus[skuId];
  if (!st) return;
  st.onShelf += 1;
  const cap = stackCap(gs, skuId);
  let filled = false;
  for (const i of slotsAll(gs)) {
    const s = gs.shelfSlots[i];
    if (s.sku === skuId && s.qty < cap) {
      s.qty += 1;
      filled = true;
      break;
    }
  }
  if (!filled) {
    for (const i of slotsAll(gs)) {
      if (gs.shelfSlots[i].sku === null) {
        gs.shelfSlots[i].sku = skuId;
        gs.shelfSlots[i].qty = 1;
        filled = true;
        break;
      }
    }
  }
  syncInventory(gs);
}

/**
 * 打烊清场（U6）：未取空的箱子直接转 backroom（不损失货）。
 * 订单保留规则（2026-09 二版）：未到期（次日+）ORDERED 单保留；
 * 当天到期的 ORDERED 单中，「当晚 EVENING 到」的单保留（等 EVENING 发车）。
 */
export function closeOutBoxes(gs) {
  for (const box of gs.logistics.boxes) {
    const st = gs.skus[box.sku];
    if (box.state === 'SEALED' || box.state === 'OPEN') {
      st.inBox -= box.qty;
      st.backroom += box.qty;
      box.state = 'EMPTY';
      box.claimedBy = null;
      box.claimedKind = null;
    }
  }
  gs.logistics.boxes = [];
  // 保留未到车的 ORDERED 单：次日+ 到的单，以及「当晚 EVENING 到」的单（等打烊整理发车）。
  // ★bug 修复：此前只留 arriveDay > 今天——当天 EVENING 到的单被误删（货财两失、永远不到）。
  gs.logistics.deliveries = gs.logistics.deliveries.filter((d) => {
    if (d.state !== 'ORDERED') return false;
    if ((d.arriveDay ?? gs.day) > gs.day) return true; // 未到期（明天+）
    return (d.arrivePhase ?? 'PREP') === 'EVENING'; // 当天到期：只留当晚到的单
  });
  syncInventory(gs);
}

// ============================================================
// 虚拟搬运工 stepAutoStock（C1 的解；A32 一键理货同源）
// ============================================================

/**
 * 虚拟搬运工：以与玩家完全相同的耗时（1.5/0.6/4.0s）**串行**处理一个箱子。
 * 与玩家互斥（箱子被 player 占用时跳过）；不占用玩家交互槽。
 * UI 默认关闭（autoStockDefaultOn=false），headless 测试显式置 session.autoStock=true。
 * @param {object} session DaySession
 */
export function stepAutoStock(gs, session, dt) {
  if (!session.autoStock) return;
  const p = session.autoStockProgress;
  const lg = CONFIG.logistics;
  // restock 进行中：先推进计时（boxId === null 表示后仓上架动作）
  if (p && p.boxId === null && p.kind === 'restock') {
    p.elapsed += dt;
    if (p.elapsed >= lg.restockTime) {
      const skuId = pickRestockableSku(gs);
      if (skuId !== null) restockToSlot(gs, skuId, lg.restockPerAction);
      session.autoStockProgress = null;
    }
    return;
  }
  if (!p || p.boxId === null) {
    // 找下一个未占用、非空的箱子
    const box = gs.logistics.boxes.find((b) => b.state !== 'EMPTY' && b.claimedBy === null);
    if (!box) {
      // 无箱可搬：把后仓的货自动上架（与玩家相同耗时 4.0s/次）
      const skuId = pickRestockableSku(gs);
      if (skuId !== null) {
        session.autoStockProgress = { boxId: null, kind: 'restock', elapsed: 0 };
      }
      return;
    }
    const kind = box.state === 'SEALED' ? 'unbox' : 'pick';
    if (claimBox(gs, box.id, 'auto', kind)) {
      session.autoStockProgress = { boxId: box.id, kind, elapsed: 0 };
    }
    return;
  }
  p.elapsed += dt;
  const box = findBox(gs, p.boxId);
  if (!box || box.state === 'EMPTY') {
    session.autoStockProgress = null;
    return;
  }
  if (box.claimedBy !== 'auto') { // 被玩家抢占（理论上不会，防御）
    session.autoStockProgress = null;
    return;
  }
  if (p.kind === 'unbox') {
    if (unboxTick(gs, box, dt) || box.state === 'OPEN') {
      session.autoStockProgress = null; // 开完箱，下一步取货
    }
  } else {
    if (pickTick(gs, box, dt) || box.state === 'EMPTY') {
      session.autoStockProgress = null;
    }
  }
}

/** 选一个「后仓有货且有格可放」的 SKU（确定性：按 skuOrder 顺序；可限定单货架）。 */
export function pickRestockTargetSku(gs, shelfIdx = null) {
  for (const skuId of CONFIG.skuOrder) {
    if (gs.skus[skuId].backroom <= 0) continue;
    if (skuHasRoom(gs, skuId, shelfIdx)) return skuId;
  }
  return null;
}

/** 全店范围内选第一个可补的 SKU（stepAutoStock / 员工兜底用）。 */
function pickRestockableSku(gs) {
  return pickRestockTargetSku(gs);
}

/** 该 SKU 是否还有可放的格位（同 SKU 未满格或空格；可限定单货架）。 */
export function skuHasRoom(gs, skuId, shelfIdx = null) {
  const cap = stackCap(gs, skuId);
  const idxs = shelfIdx === null ? slotsAll(gs) : slotsOfShelf(gs, shelfIdx);
  return idxs.some((i) => {
    const s = gs.shelfSlots[i];
    return s.sku === null || (s.sku === skuId && s.qty < cap);
  });
}

/**
 * A32「一键理货」：消耗 autoStockTime(15s) 一次性把后仓货按 60% 效率上架。
 * （P2 特性，本轮实现核心，UI 按钮由另一名工程师接入。）
 * @returns {number} 上架件数
 */
export function autoStockBurst(gs) {
  let put = 0;
  for (const skuId of CONFIG.skuOrder) {
    if (gs.skus[skuId].backroom <= 0) continue;
    put += restockToSlot(gs, skuId);
  }
  return put;
}

// ============================================================
// 测试 / 迁移专用工具
// ============================================================

/**
 * 测试专用铺货（禁止直接赋值 gs.inventory）。
 * @param {object} gs GameState
 * @param {string} skuId
 * @param {'onShelf'|'backroom'|'inBox'|'inTransit'} state
 * @param {number} qty 追加量
 * @param {boolean} [toSlots] onShelf 时是否同时铺格位（默认 true）
 */
export function grantStock(gs, skuId, state, qty, toSlots = true) {
  const st = gs.skus[skuId];
  if (!st || qty < 0) return;
  if (state === 'onShelf') {
    st.onShelf += qty;
    if (toSlots) {
      const cap = stackCap(gs, skuId);
      let rest = qty;
      const idxs = slotsAll(gs);
      while (rest > 0) {
        let target = -1;
        for (const i of idxs) {
          const s = gs.shelfSlots[i];
          if (s.sku === skuId && s.qty < cap) { target = i; break; }
        }
        if (target === -1) {
          for (const i of idxs) {
            if (gs.shelfSlots[i].sku === null) { target = i; break; }
          }
        }
        if (target === -1) break;
        const slot = gs.shelfSlots[target];
        const amount = Math.min(rest, cap - slot.qty);
        slot.sku = skuId;
        slot.qty += amount;
        rest -= amount;
      }
    }
  } else {
    st[state] += qty;
  }
  syncInventory(gs);
}

/**
 * 三条守恒不变式 + 非负整数校验（测试守卫）。
 * v3 格池化后：② 全店格位 qty 合计 === 全店 onShelf 合计；③ 单 SKU 跨格 === sku.onShelf。
 * ① inventory[cat] === Σ 四态
 * ② 全店 36 格 qty 之和 === Σ 全店 sku.onShelf
 * ③ 单 SKU 跨格 qty 之和 === sku.onShelf
 * ④ 四态分量非负整数
 */
export function stockInvariantOk(gs) {
  for (const id of CONFIG.skuOrder) {
    const st = gs.skus[id];
    for (const k of ['inTransit', 'inBox', 'backroom', 'onShelf']) {
      if (!Number.isInteger(st[k]) || st[k] < 0) return false;
    }
  }
  for (const cat of CONFIG.categoryOrder) {
    let four = 0;
    for (const id of CONFIG.skuOrder) {
      if (CONFIG.skus[id].cat !== cat) continue;
      const st = gs.skus[id];
      four += st.inTransit + st.inBox + st.backroom + st.onShelf;
    }
    if (gs.inventory[cat] !== four) return false;
  }
  // ② 全店格位合计 === 全店在架合计
  let slotQty = 0;
  for (const s of gs.shelfSlots) slotQty += s.qty;
  let totalOnShelf = 0;
  for (const id of CONFIG.skuOrder) totalOnShelf += gs.skus[id].onShelf;
  if (slotQty !== totalOnShelf) return false;
  // ③ 单 SKU 维度
  for (const id of CONFIG.skuOrder) {
    let q = 0;
    for (const s of gs.shelfSlots) {
      if (s.sku === id) q += s.qty;
    }
    if (q !== gs.skus[id].onShelf) return false;
  }
  return true;
}

/** 门口箱数（视觉 / 减速判定用）。 */
export function doorBoxCount(gs) {
  return gs.logistics.boxes.length;
}

// ============================================================
// v3 库房 / 空箱处理 / 废品回收（需求 9/10）
// 2026-09 重构：双手统一模型 session.carry =
//   {type:'item', skuId, qty} | {type:'box', box} | {type:'cardboard', n}
// ============================================================

/** 双手是否空闲。 */
export function carryEmpty(session) {
  return !session.carry;
}

/** 手上货物入后仓 / 纸板入纸板堆（stash）。box 请走 placeCarriedBox。 */
export function stashToBackroom(gs, session) {
  const carry = session.carry;
  if (!carry) return 0;
  if (carry.type === 'cardboard') {
    if (!gs.stockroom) gs.stockroom = { cardboard: 0 };
    gs.stockroom.cardboard = Math.min(
      ((gs.expansion && gs.expansion.stockroom_plus) ? 2 : 1) * CONFIG.stockroom.cardboardCap,
      gs.stockroom.cardboard + carry.n,
    );
    session.carry = null;
    return 1;
  }
  if (carry.type !== 'item') return 0;
  const st = gs.skus[carry.skuId];
  if (!st) return 0;
  st.backroom += carry.qty;
  session.carry = null;
  syncInventory(gs);
  return 1;
}

/**
 * 库房取货上手（takeout）：后仓 → 双手（≤ 一箱 4 件）。
 * @returns {number} 实际取货件数（0 = 失败：手上有货/该 SKU 无后仓库存）
 */
export function takeOutToHands(gs, session, skuId) {
  if (session.carry) return 0;
  const st = gs.skus[skuId];
  if (!st || st.backroom <= 0) return 0;
  const n = Math.min(CONFIG.logistics.boxCapacity, st.backroom);
  st.backroom -= n;
  session.carry = { type: 'item', skuId, qty: n };
  syncInventory(gs);
  return n;
}

/** 折叠空箱（flatten）：EMPTY 箱移除 → 折叠纸板入双手；
 * 手上已是纸壳时可继续叠加，一次最多拿 cardboardCarryCap（10）张。 */
export function flattenBox(gs, boxId, session = null) {
  const box = findBox(gs, boxId);
  if (!box || box.state !== 'EMPTY') return false;
  const carryCap = CONFIG.stockroom.cardboardCarryCap ?? 10;
  if (session && session.carry
    && (session.carry.type !== 'cardboard' || session.carry.n >= carryCap)) {
    return false; // 手上有其他物品，或纸壳已满
  }
  gs.logistics.boxes = gs.logistics.boxes.filter((b) => b.id !== boxId);
  if (session) {
    if (session.carry) session.carry.n += 1;
    else session.carry = { type: 'cardboard', n: 1 };
  } else {
    // 无 session（测试直调）：直接入堆
    if (!gs.stockroom) gs.stockroom = { cardboard: 0 };
    gs.stockroom.cardboard = Math.min(
      ((gs.expansion && gs.expansion.stockroom_plus) ? 2 : 1) * CONFIG.stockroom.cardboardCap,
      gs.stockroom.cardboard + 1,
    );
  }
  return true;
}

/**
 * 抱起未拆封整箱（carryBox，需求：抱起放入仓库）：SEALED 箱离手上手，
 * 从世界箱列表摘下（放下时重新入列）。
 */
export function pickCarryBox(gs, session, boxId) {
  if (session.carry) return false;
  const box = findBox(gs, boxId);
  if (!box || box.state !== 'SEALED') return false;
  gs.logistics.boxes = gs.logistics.boxes.filter((b) => b.id !== boxId);
  session.carry = { type: 'box', box };
  return true;
}

/** 放箱（placeBox，2026-09 反馈：不再局限库房）：手上整箱放到脚下，
 * 钳制在店内范围（含库房；收购翼房后含翼房）；同位有箱自动叠顶。 */
export function placeCarriedBox(gs, session, x, z) {
  const carry = session.carry;
  if (!carry || carry.type !== 'box') return false;
  const H = CONFIG.logistics.boxHalf;
  const wing = gs.expansion && gs.expansion.wing_right;
  const bx = Math.min(Math.max(x, -9.9 + H), (wing ? 11.6 : 6.75) - H);
  const bz = Math.min(Math.max(z, -3.9 + H), 4.4 - H);
  const box = carry.box;
  box.x = bx;
  box.z = bz;
  box.vy = 0;
  box.carriedBy = null;
  gs.logistics.boxes.push(box);
  box.y = supportFloor(gs, box); // 同位有箱 → 叠上去
  box.settled = true;
  session.carry = null;
  return true;
}

/** 垃圾桶丢弃全部空箱（trash；无材料收益，即时清洁）。@returns {number} 丢弃数 */
export function trashEmptyBoxes(gs) {
  const before = gs.logistics.boxes.length;
  gs.logistics.boxes = gs.logistics.boxes.filter((b) => b.state !== 'EMPTY');
  return before - gs.logistics.boxes.length;
}

/** 回收商人收购全部纸板（recycle）。@returns {number} 收入（0 = 无纸板） */
export function recycleCardboard(gs) {
  const n = (gs.stockroom && gs.stockroom.cardboard) || 0;
  if (n <= 0) return 0;
  const income = n * CONFIG.stockroom.cardboardPrice;
  gs.stockroom.cardboard = 0;
  gs.cash += income;
  gs.today.restockCost -= 0; // 不冲减进货成本；单独记 revenue 附项
  gs.today.revenue += income;
  return income;
}

/**
 * 门口堆积减速倍率（A06，软惩罚）：箱子 > maxBoxesAtDoor 且 pos 在门口区域 → ×0.7。
 * @param {{x:number,z:number}} pos 玩家位置
 */
export function doorSlowFactor(gs, pos) {
  const lg = CONFIG.logistics;
  if (gs.logistics.boxes.length <= lg.maxBoxesAtDoor) return 1;
  const near = Math.abs(pos.x - CONFIG.layout.door.x) < 1.6 && pos.z > 4.0;
  return near ? lg.doorSlowMult : 1;
}
