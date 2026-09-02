/**
 * gameState.js — GameState v2 创建、序列化/反序列化、v1→v2 一次迁移。
 *
 * GameState 是唯一可变状态树，整体可 JSON 序列化（DaySession 不入档）。
 * v2 新增：skus（四态真值）/ skuPrices / shelfSlots(36) / logistics / staff /
 * today.{wages,severance,boxesOpened,needsResolved}。
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/gameState
 */

import { CONFIG } from '../config.js';
import { syncInventory, stockInvariantOk } from './logistics.js';

/**
 * 构造当日统计（DayStats）。
 * @returns {object} 当日累计数据。
 */
export function newDayStats() {
  const restocked = {};
  for (const cat of CONFIG.categoryOrder) restocked[cat] = 0;
  return {
    revenue: 0,           // 销售收入（整数金币）
    experienceIncome: 0,  // 体验费收入
    rentalIncome: 0,      // v3 桌游租用收入（需求 5）
    restockCost: 0,       // 当日进货成本
    wages: 0,             // 员工薪资（v2）
    severance: 0,         // 遣散费（v2）
    footfall: 0,          // 进店人数
    bought: 0,            // 完成购买人数
    lost: 0,              // 未购买离店人数（含怒流失）
    satisfactionSum: 0,   // 满意度合计（日结时结算为声望）
    boxesOpened: 0,       // 开箱次数（v2）
    needsResolved: 0,     // 需求气泡响应次数（v2）
    restocked,            // 当日进货量（"快递延迟"事件兼容字段）
  };
}

/** 构造 13 个 SKU 的四态库存（全部 0）。 */
function newSkuStocks() {
  const out = {};
  for (const id of CONFIG.skuOrder) {
    out[id] = {
      inTransit: 0, inBox: 0, backroom: 0, onShelf: 0, soldTotal: 0,
    };
  }
  return out;
}

/** 构造 SKU 初始价格（指导价）。 */
function newSkuPrices() {
  const out = {};
  for (const id of CONFIG.skuOrder) out[id] = CONFIG.skus[id].guidePrice;
  return out;
}

/** 构造 36 个货架格位（v3 格池化：4 货架 × 9 格，不限品类；index = shelfIdx*9 + slotIdx）。 */
export function newShelfSlots() {
  const out = [];
  for (let shelf = 0; shelf < 4; shelf += 1) {
    for (let i = 0; i < CONFIG.shelf.slotsPerShelf; i += 1) {
      out.push({ sku: null, qty: 0 });
    }
  }
  return out;
}

/** 构造空物流态。 */
function newLogisticsState() {
  return {
    deliveries: [],
    boxes: [],
    nextDeliveryId: 1,
    nextBoxId: 1,
  };
}

/** 构造空员工态。 */
function newStaffState() {
  return {
    members: [],
    candidates: [],
    nextId: 1,
    autoRestockUsedToday: 0,
  };
}

/** 初始库存按品类默认 SKU 归入 backroom（U1：货架初始为空，A11）。 */
function grantInitialInventory(gs) {
  for (const cat of CONFIG.categoryOrder) {
    const qty = CONFIG.initialInventory[cat] || 0;
    if (qty <= 0) continue;
    if (CONFIG.shelf.startBackroom) {
      gs.skus[CONFIG.categoryDefaultSku[cat]].backroom += qty;
    } else {
      gs.skus[CONFIG.categoryDefaultSku[cat]].onShelf += qty;
    }
  }
  syncInventory(gs);
}

/**
 * 创建新游戏状态（v2）。
 * @param {number} seed 随机种子（同时作为 rngState 初值）。
 * @returns {object} GameState
 */
export function newGame(seed = 1) {
  const prices = {};
  for (const cat of CONFIG.categoryOrder) {
    prices[cat] = CONFIG.products[cat].guidePrice;
  }
  const gs = {
    day: 1,
    phase: 'MORNING',
    cash: CONFIG.initialCash,
    reputation: CONFIG.initialReputation,
    inventory: { boardgame_low: 0, boardgame_high: 0, snacks: 0, merch: 0 },
    prices,
    // —— v2 ——
    skus: newSkuStocks(),
    skuPrices: newSkuPrices(),
    shelfSlots: newShelfSlots(),
    logistics: newLogisticsState(),
    // v3（需求 9）：库房资源（纸板等可回收物）
    stockroom: { cardboard: 0 },
    // 2026-09：库房门手动开关（默认关；关门时门洞有碰撞）
    staffDoorOpen: false,
    // 2026-09：店铺扩张（三级独立购买项）
    expansion: { stockroom_plus: false, wing_right: false, loft: false },
    // 2026-09：店内布局自定义（稀疏覆盖表；null=默认 CONFIG.layout，见 sim/layout.js）
    customLayout: null,
    staff: newStaffState(),
    // —— v1 保留 ——
    upgrades: { experience: 1, shelf: 1, decor: 1 },
    regulars: CONFIG.regulars.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      visits: 0,
      storyStage: 0,
      completed: false,
      unlocked: false,
    })),
    collectibles: CONFIG.collectibles.map((c) => ({
      id: c.id,
      name: c.name,
      rarity: c.rarity,
      owned: false,
    })),
    season: CONFIG.seasons.order[0],
    eventToday: null,
    activityDaysLeft: 0,
    today: newDayStats(),
    rngState: seed >>> 0,
    storyQueue: [],   // 待展示的剧情/通知文本队列（UI 逐条弹出）
    freePlay: false,  // VICTORY 后进入自由经营
  };
  grantInitialInventory(gs);
  applySeasonForDay(gs);
  return gs;
}

/**
 * 按当前 day 计算季节并处理换季/活动周（写入 gs.season / gs.activityDaysLeft / 通知）。
 * @param {object} gs GameState
 * @returns {{seasonChanged: boolean, activityStarted: boolean}}
 */
export function applySeasonForDay(gs) {
  const cfg = CONFIG.seasons;
  const idx = Math.floor((gs.day - 1) / cfg.lengthDays) % cfg.order.length;
  const newSeason = cfg.order[idx];
  const seasonChanged = newSeason !== gs.season;
  gs.season = newSeason;
  const isSeasonFirstDay = (gs.day - 1) % cfg.lengthDays === 0;
  let activityStarted = false;
  if (isSeasonFirstDay) {
    gs.activityDaysLeft = cfg.activityDays;
    activityStarted = true;
    if (gs.storyQueue) {
      gs.storyQueue.push(
        CONFIG.strings.seasonBanner
          .replace('{emoji}', cfg.emojis[newSeason])
          .replace('{name}', cfg.names[newSeason]),
      );
      gs.storyQueue.push(
        CONFIG.strings.activityWeek.replace('{days}', String(cfg.activityDays)),
      );
    }
  }
  return { seasonChanged, activityStarted };
}

/** 序列化 GameState 为 JSON 字符串（含版本字段）。 */
export function serialize(gs) {
  return JSON.stringify({ v: CONFIG.version, ...gs });
}

/** 反序列化 JSON 为 GameState，并补齐缺失字段（向前兼容）。 */
export function deserialize(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== 'object' || typeof data.day !== 'number') {
    return null;
  }
  if (data.v === 1) return migrateV1toV2(data);
  const fresh = newGame(data.rngState || 1);
  const gs = { ...fresh, ...data };
  delete gs.v;
  gs.inventory = { ...fresh.inventory, ...(data.inventory || {}) };
  gs.prices = { ...fresh.prices, ...(data.prices || {}) };
  gs.skuPrices = { ...fresh.skuPrices, ...(data.skuPrices || {}) };
  gs.upgrades = { ...fresh.upgrades, ...(data.upgrades || {}) };
  gs.today = { ...newDayStats(), ...(data.today || {}) };
  gs.today.restocked = { ...newDayStats().restocked, ...((data.today || {}).restocked || {}) };
  gs.regulars = Array.isArray(data.regulars) ? data.regulars : fresh.regulars;
  gs.collectibles = Array.isArray(data.collectibles) ? data.collectibles : fresh.collectibles;
  gs.storyQueue = Array.isArray(data.storyQueue) ? data.storyQueue : [];
  gs.freePlay = Boolean(data.freePlay);
  // v2 结构兜底
  gs.skus = deepMergeSkuStocks(fresh.skus, data.skus);
  gs.shelfSlots = Array.isArray(data.shelfSlots) && data.shelfSlots.length === fresh.shelfSlots.length
    ? data.shelfSlots
    : fresh.shelfSlots;
  gs.logistics = mergeLogistics(fresh.logistics, data.logistics);
  gs.staff = mergeStaff(fresh.staff, data.staff);
  // 守恒自愈：以 skus 为真值重算
  syncInventory(gs);
  if (!stockInvariantOk(gs)) {
    rebuildSlotsFromSku(gs);
    syncInventory(gs);
  }
  return gs;
}

/** v2 存档的 skus 字段深合并（缺 SKU 用 0 兜底）。 */
function deepMergeSkuStocks(fresh, saved) {
  const out = {};
  for (const id of CONFIG.skuOrder) {
    const s = saved && saved[id] ? saved[id] : {};
    out[id] = {
      inTransit: nonNegInt(s.inTransit),
      inBox: nonNegInt(s.inBox),
      backroom: nonNegInt(s.backroom),
      onShelf: nonNegInt(s.onShelf),
      soldTotal: nonNegInt(s.soldTotal),
    };
  }
  return out;
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function mergeLogistics(fresh, saved) {
  if (!saved || typeof saved !== 'object') return fresh;
  // v3：老档箱子没有物理字段（x/y/vy/settled），以槽位落点 + 落定态兜底
  const boxes = Array.isArray(saved.boxes) ? saved.boxes.map((b) => {
    if (b && typeof b.x === 'number' && typeof b.y === 'number') return b;
    const slotPos = CONFIG.street.doorBoxSlots[(b?.slot ?? 0) % CONFIG.street.doorBoxSlots.length];
    return { ...b, x: slotPos.x, z: slotPos.z, y: 0, vy: 0, settled: true };
  }) : [];
  return {
    deliveries: Array.isArray(saved.deliveries) ? saved.deliveries.map((d) => (
      d && typeof d === 'object' && !d.arrivePhase ? { ...d, arrivePhase: 'PREP' } : d
    )) : [], // 2026-09 到货分时段：老档订单默认次日早到（PREP）
    boxes,
    nextDeliveryId: Number.isFinite(saved.nextDeliveryId) ? saved.nextDeliveryId : 1,
    nextBoxId: Number.isFinite(saved.nextBoxId) ? saved.nextBoxId : 1,
  };
}

function mergeStaff(fresh, saved) {
  if (!saved || typeof saved !== 'object') return fresh;
  return {
    members: Array.isArray(saved.members) ? saved.members : [],
    candidates: Array.isArray(saved.candidates) ? saved.candidates : [],
    nextId: Number.isFinite(saved.nextId) ? saved.nextId : 1,
    autoRestockUsedToday: Number.isFinite(saved.autoRestockUsedToday) ? saved.autoRestockUsedToday : 0,
  };
}

/**
 * v1 → v2 一次迁移（架构 §7.1，12 条字段映射）。
 * 任何字段缺失/非法用 newGame 默认值兜底，不整体拒绝（旧档绝不能失效）。
 * @param {object} raw v1 反序列化对象
 * @returns {object} GameState v2
 */
export function migrateV1toV2(raw) {
  const seed = Number.isFinite(raw.rngState) ? raw.rngState : 1;
  const gs = newGame(seed);
  gs.day = Number.isFinite(raw.day) && raw.day >= 1 ? Math.floor(raw.day) : 1;
  gs.cash = Number.isFinite(raw.cash) ? Math.round(raw.cash) : CONFIG.initialCash;
  gs.reputation = Number.isFinite(raw.reputation)
    ? Math.min(CONFIG.reputationGoal, Math.max(0, Math.round(raw.reputation)))
    : 0;
  gs.rngState = seed >>> 0;

  // upgrades 逐项兜底
  const up = raw.upgrades || {};
  gs.upgrades = {
    experience: clampLevel(up.experience),
    shelf: clampLevel(up.shelf),
    decor: clampLevel(up.decor),
  };

  // 品类级迁移：inventory → 默认 SKU.onShelf（A-Q4：老档开门即满架，不劣化）
  const inv = raw.inventory || {};
  for (const cat of CONFIG.categoryOrder) {
    const qty = nonNegInt(inv[cat]);
    if (qty <= 0) continue;
    const skuId = CONFIG.categoryDefaultSku[cat];
    gs.skus[skuId].onShelf += qty;
  }
  // 品类价格：保留（兼容字段）
  const prices = raw.prices || {};
  for (const cat of CONFIG.categoryOrder) {
    gs.prices[cat] = Number.isFinite(prices[cat])
      ? Math.round(prices[cat])
      : CONFIG.products[cat].guidePrice;
  }
  // SKU 价格：按品类指导价比等比缩放（A28）
  for (const skuId of CONFIG.skuOrder) {
    const sku = CONFIG.skus[skuId];
    const catGuide = CONFIG.products[sku.cat].guidePrice;
    const ratioBase = gs.prices[sku.cat] / catGuide;
    const scaled = Math.round(sku.guidePrice * ratioBase);
    gs.skuPrices[skuId] = Math.min(
      Math.round(sku.guidePrice * CONFIG.economy.priceClampMax),
      Math.max(Math.round(sku.guidePrice * CONFIG.economy.priceClampMin), scaled),
    );
  }

  // 其余 v1 字段透传
  gs.regulars = Array.isArray(raw.regulars) && raw.regulars.length === gs.regulars.length
    ? raw.regulars
    : gs.regulars;
  gs.collectibles = Array.isArray(raw.collectibles) && raw.collectibles.length === gs.collectibles.length
    ? raw.collectibles
    : gs.collectibles;
  if (typeof raw.season === 'string' && CONFIG.seasons.order.includes(raw.season)) {
    gs.season = raw.season;
  }
  gs.eventToday = typeof raw.eventToday === 'string' ? raw.eventToday : null;
  gs.activityDaysLeft = nonNegInt(raw.activityDaysLeft);
  gs.storyQueue = Array.isArray(raw.storyQueue) ? raw.storyQueue : [];
  gs.freePlay = Boolean(raw.freePlay);
  // 会话不可序列化：OPEN/PREP/CLOSING 一律改 MORNING（U10）；GAMEOVER/VICTORY 保留
  gs.phase = (raw.phase === 'GAMEOVER' || raw.phase === 'VICTORY') ? raw.phase : 'MORNING';
  gs.today = newDayStats();

  // 落格：onShelf 反推填格（超格容量部分留在 onShelf 但不占格，保守不丢失）
  rebuildSlotsFromSku(gs);
  syncInventory(gs);
  if (!stockInvariantOk(gs)) {
    // 极端兜底：格位与四态仍不一致 → 清格重算（onShelf 保留在四态真值中）
    gs.shelfSlots = newShelfSlots();
    rebuildSlotsFromSku(gs);
    syncInventory(gs);
  }
  return gs;
}

function clampLevel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(CONFIG.upgrades.maxLevel, Math.max(1, Math.round(n)));
}

/** 以 skus[*].onShelf 为真值重铺格位（v3 全局格池；超出格容量的留在 onShelf 四态里）。 */
function rebuildSlotsFromSku(gs) {
  gs.shelfSlots = newShelfSlots();
  const lvlCap = CONFIG.shelf.stackCapByLevel[gs.upgrades.shelf - 1];
  for (const skuId of CONFIG.skuOrder) {
    let rest = gs.skus[skuId].onShelf;
    if (rest <= 0) continue;
    const cap = Math.min(CONFIG.skus[skuId].slotCap ?? lvlCap, lvlCap * 2);
    for (let i = 0; i < gs.shelfSlots.length && rest > 0; i += 1) {
      const slot = gs.shelfSlots[i];
      if (slot.sku !== null && slot.sku !== skuId) continue;
      const amount = Math.min(rest, cap - slot.qty);
      if (amount > 0) {
        slot.sku = skuId;
        slot.qty += amount;
        rest -= amount;
      }
    }
  }
}
