/**
 * economy.js — 经济公式：购买概率（SKU 化）、客流、SKU 定价、季节热度、
 * 日结（含员工薪资）、租金、破产/胜利判定、下单（→ inTransit）与升级。
 *
 * 纯 ES Module，禁止 import DOM / window / three；无裸数字（全部取 CONFIG）。
 *
 * @module sim/economy
 */

import { CONFIG } from '../config.js';
import { rollCollectibleDrop, hasLegendary } from './story.js';
import { placeOrder, syncInventory, sparseDisplayMult, onShelfOf } from './logistics.js';
import { payrollFor, severanceFor } from './staff.js';

/** 数值工具：clamp。 */
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 当前价格倍率 r = price / guidePrice（品类级，兼容 v1）。 */
export function priceRatio(gs, catId) {
  return gs.prices[catId] / CONFIG.products[catId].guidePrice;
}

/** SKU 价格倍率 r = skuPrices[sku] / skus[sku].guidePrice。 */
export function skuPriceRatio(gs, skuId) {
  return skuPriceOf(gs, skuId) / CONFIG.skus[skuId].guidePrice;
}

/** SKU 当前售价（玩法真值）。 */
export function skuPriceOf(gs, skuId) {
  return gs.skuPrices[skuId];
}

/**
 * v3 桌游租金（需求 5）：售价 × feeRatio，下限 minFee，取整。
 * 仅 boardgame_* 品类有意义（调用方判断品类）。
 */
export function rentFeeOf(gs, skuId) {
  const r = CONFIG.rental;
  return Math.max(r.minFee, Math.round(skuPriceOf(gs, skuId) * r.feeRatio));
}

/** v3 找零（需求 4）：最小整钞面额（50/100/200/500；超额按百取整）。 */
export function checkoutBillFor(total) {
  for (const bill of [50, 100, 200, 500]) {
    if (bill >= total) return bill;
  }
  return Math.ceil(total / 100) * 100;
}

/** v3 找零：应找金额 = 实收 - 应收。 */
export function checkoutChange(total, bill) {
  return bill - total;
}

/** 品类季节热度修正倍率 heatMult = 1 + seasonHeat。 */
export function seasonHeatMult(gs, catId) {
  return 1 + CONFIG.seasons.heat[gs.season][catId];
}

/** 库存上限（2026-09 需求：取消每品类在库上限，放开为不限）。 */
export function inventoryCap(gs) {
  void gs;
  return Number.POSITIVE_INFINITY;
}

/** 体验位数量 = slotBase + experienceLevel + （收购右邻铺 +2）。 */
export function experienceSlots(gs) {
  return CONFIG.experience.slotBase + gs.upgrades.experience
    + ((gs.expansion && gs.expansion.wing_right) ? 2 : 0);
}

/** 纸板堆叠上限（库房扩容 ×2）。 */
export function cardboardCapOf(gs) {
  return ((gs.expansion && gs.expansion.stockroom_plus) ? 2 : 1) * CONFIG.stockroom.cardboardCap;
}

/**
 * 购买店铺扩张项（2026-09）：独立一次性购买，解锁真实区域/上限/声望。
 * 效果：stockroom_plus → 纸板上限 ×2（cardboardCapOf 动态读）；
 *       wing_right → 右翼房 +2 体验位（experienceSlots）；
 *       loft → 声望 +10（一次性）。
 * @param {object} gs
 * @param {string} id CONFIG.expansion.levels[].id
 * @returns {boolean}
 */
export function buyExpansion(gs, id) {
  const def = (CONFIG.expansion.levels || []).find((l) => l.id === id);
  if (!def) return false;
  if (!gs.expansion) gs.expansion = { stockroom_plus: false, wing_right: false, loft: false };
  if (gs.expansion[id]) return false; // 已购
  if (gs.cash < def.cost) return false;
  gs.cash -= def.cost;
  gs.expansion[id] = true;
  if (id === 'loft') {
    gs.reputation = clamp(gs.reputation + 10, 0, CONFIG.reputationGoal);
  }
  return true;
}

/** 体验费 = feeBase + feePerLevel × experienceLevel。 */
export function experienceFee(gs) {
  return CONFIG.experience.feeBase + CONFIG.experience.feePerLevel * gs.upgrades.experience;
}

/** 当前租金（按最高升级线等级 1/2/3 → 400/600/800）。 */
export function rentFor(gs) {
  const maxLevel = Math.max(
    gs.upgrades.experience, gs.upgrades.shelf, gs.upgrades.decor,
  );
  return CONFIG.rent.byLevel[maxLevel - 1];
}

/**
 * SKU 是否已解锁（声望门槛，A19）。
 * @returns {boolean}
 */
export function skuUnlocked(gs, skuId) {
  return gs.reputation >= CONFIG.skus[skuId].unlockRep;
}

/**
 * 购买概率（SKU def；兼容品类 def —— 缺 cat 时按 id 取品类）。
 * p = clamp(p0 × priceFactor × heatMult × decorMult × expBonus × appealMult × sparseMult, pMin, pMax)
 * - p0 = pBase + pPrefScale × pref[cat]
 * - priceFactor：r ≤ 1 → 1 + priceDownFactor×(1-r)；r > 1 → 1 - priceUpFactor×(r-1)
 * - appealMult = sku.appeal[customer.type] ?? 1（SKU 层微调）
 * - sparseMult：全店陈列 SKU < 4 → ×0.85（A13 陈列不足惩罚）
 * - 预算硬约束：price > budget → p ×= budgetPenalty
 * @param {object} customer 顾客（pref / budget / type）
 * @param {object} skuDef SKU 或品类定义
 * @param {object} gs GameState
 * @param {boolean} [afterExperience] 体验区二次判定（×expBuyBonus）
 * @returns {number} 0~1
 */
export function purchaseProbability(customer, skuDef, gs, afterExperience = false) {
  const e = CONFIG.economy;
  const catId = skuDef.cat || skuDef.id;
  const skuId = skuDef.id && CONFIG.skus[skuDef.id] ? skuDef.id : null;
  const guide = skuId ? CONFIG.skus[skuId].guidePrice : CONFIG.products[catId].guidePrice;
  const price = skuId ? skuPriceOf(gs, skuId) : gs.prices[catId];
  const r = clamp(price / guide, e.priceClampMin, e.priceClampMax);
  const p0 = e.pBase + e.pPrefScale * (customer.pref[catId] || 0);
  const priceFactor = r <= 1
    ? 1 + e.priceDownFactor * (1 - r)
    : 1 - e.priceUpFactor * (r - 1);
  const heatMult = seasonHeatMult(gs, catId);
  const decorMult = 1 + e.decorStep * (gs.upgrades.decor - 1);
  const expMult = afterExperience ? e.expBuyBonus : 1;
  const appealMult = skuId && customer.type && skuDef.appeal && skuDef.appeal[customer.type] !== undefined
    ? skuDef.appeal[customer.type]
    : 1;
  const sparseMult = skuId ? sparseDisplayMult(gs) : 1;
  let p = p0 * priceFactor * heatMult * decorMult * expMult * appealMult * sparseMult;
  if (price > customer.budget) {
    p *= e.budgetPenalty;
  }
  return clamp(p, e.pMin, e.pMax);
}

/**
 * 每日客流。
 * footfall = round((base + reputation/repDivisor) × eventMult × activityMult × legendMult)
 */
export function dailyFootfall(gs) {
  const f = CONFIG.footfall;
  const base = f.base + gs.reputation / f.repDivisor;
  const ev = CONFIG.events.find((e) => e.id === gs.eventToday);
  const eventMult = ev && typeof ev.footfallMult === 'number' ? ev.footfallMult : 1;
  const activityMult = gs.activityDaysLeft > 0 ? f.activityMult : 1;
  const legendMult = hasLegendary(gs) ? f.legendMult : 1;
  return Math.max(0, Math.round(base * eventMult * activityMult * legendMult));
}

/**
 * 品类四态合计（含在途），供上限判定。
 */
function catTotal(gs, cat) {
  return gs.inventory[cat] || 0;
}

/**
 * 进货下单：校验库存上限与现金 → 生成 Delivery(ORDERED)，数量计入 sku.inTransit。
 * **签名与返回结构与 v1 完全一致**（内部从「立即入 inventory」改为「inTransit 在途」）。
 * orders 键兼容两种：品类 id（按默认 SKU 下单，v1 测试路径）或 SKU id。
 * 超上限的数量截断；总价超现金则整单拒绝。
 * @param {object} gs GameState
 * @param {Record<string, number>} orders 品类或 SKU 进货数量
 * @param {object|null} [rng] 随机数实例（传入才会 roll 收藏掉落）
 * @returns {{ok: boolean, spent: number, fulfilled: Record<string, number>, drops: object[]}}
 */
export function restock(gs, orders, rng = null) {
  // ① 归一化：品类键展开成默认 SKU，与 SKU 键合并
  const skuOrders = {};
  for (const key of Object.keys(orders)) {
    const raw = Number(orders[key]);
    const want = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    if (want <= 0) continue;
    if (CONFIG.skus[key]) {
      skuOrders[key] = (skuOrders[key] || 0) + want;
    } else if (CONFIG.products[key]) {
      const defaultSku = CONFIG.categoryDefaultSku[key];
      skuOrders[defaultSku] = (skuOrders[defaultSku] || 0) + want;
    }
  }
  // ② 逐品类上限截断（品类四态合计含在途）
  const fulfilled = {};
  const catPlanned = {};
  for (const skuId of CONFIG.skuOrder) {
    const want = skuOrders[skuId] || 0;
    if (want <= 0) continue;
    const cat = CONFIG.skus[skuId].cat;
    const cap = inventoryCap(gs);
    const used = catPlanned[cat] || catTotal(gs, cat);
    const qty = Math.min(want, Math.max(0, cap - used));
    catPlanned[cat] = used + qty;
    fulfilled[skuId] = qty;
  }
  // ③ 现金校验（整数金额）
  let spent = 0;
  for (const skuId of Object.keys(fulfilled)) {
    spent += fulfilled[skuId] * CONFIG.skus[skuId].cost;
  }
  if (spent > gs.cash) {
    return { ok: false, spent: 0, fulfilled: {}, drops: [] };
  }
  // ④ 下单（→ inTransit）+ 记账
  placeOrder(gs, fulfilled);
  for (const skuId of Object.keys(fulfilled)) {
    const qty = fulfilled[skuId];
    const cat = CONFIG.skus[skuId].cat;
    if (qty > 0) {
      gs.today.restocked[cat] += qty;
    }
  }
  gs.cash -= spent;
  gs.today.restockCost += spent;
  syncInventory(gs);
  // merch 品类掉落（按品类单位计，与 v1 行为一致）
  let merchQty = 0;
  for (const skuId of Object.keys(fulfilled)) {
    if (CONFIG.skus[skuId].cat === 'merch') merchQty += fulfilled[skuId];
  }
  const drops = rng && merchQty > 0
    ? rollCollectibleDrop(gs, rng, merchQty)
    : [];
  return { ok: true, spent, fulfilled, drops };
}

/**
 * 品类级定价（v1 兼容；玩法真值走 setSkuPrice）。
 */
export function setPrice(gs, catId, price) {
  if (typeof price !== 'number' || Number.isNaN(price)) {
    return gs.prices[catId];
  }
  const guide = CONFIG.products[catId].guidePrice;
  const e = CONFIG.economy;
  const clamped = clamp(
    Math.round(price),
    Math.round(guide * e.priceClampMin),
    Math.round(guide * e.priceClampMax),
  );
  gs.prices[catId] = clamped;
  // 同步品类默认 SKU（保持两套价格一致性，避免老断言漂移）
  const defaultSku = CONFIG.categoryDefaultSku[catId];
  if (defaultSku) {
    setSkuPrice(gs, defaultSku, clamped * (CONFIG.skus[defaultSku].guidePrice / guide));
  }
  return clamped;
}

/**
 * SKU 级定价（A18）：clamp 到指导价 ±50% 并取整。
 * 非数值 / NaN 输入直接忽略（保持原价）。
 * @returns {number} 实际生效价格
 */
export function setSkuPrice(gs, skuId, price) {
  if (typeof price !== 'number' || Number.isNaN(price)) {
    return skuPriceOf(gs, skuId);
  }
  const guide = CONFIG.skus[skuId].guidePrice;
  const e = CONFIG.economy;
  const clamped = clamp(
    Math.round(price),
    Math.round(guide * e.priceClampMin),
    Math.round(guide * e.priceClampMax),
  );
  gs.skuPrices[skuId] = clamped;
  return clamped;
}

/**
 * 购买升级。成功扣款并 +1 级。
 */
export function buyUpgrade(gs, line) {
  const cfg = CONFIG.upgrades;
  if (!cfg.lines.includes(line)) return false;
  const level = gs.upgrades[line];
  if (level >= cfg.maxLevel) return false;
  const cost = cfg.costs[level + 1];
  if (gs.cash < cost) return false;
  gs.cash -= cost;
  gs.upgrades[line] += 1;
  return true;
}

/**
 * 日结：计算 DayReport，应用租金、员工薪资与遣散费、声望，判定破产/胜利。
 * - 净利 = 销售收入 + 体验费 − 当日进货成本 − 薪资 − 遣散费（租金单列）
 * - 账单日（day % intervalDays === 0）扣租金
 * - reputation = clamp(reputation + satisfactionSum, 0, 100)
 * - 账单日结算后 cash < 0 → GAMEOVER；reputation ≥ 100 → VICTORY
 * @param {object} gs GameState（phase 应为 CLOSING）
 * @returns {object} DayReport
 */
export function settleDay(gs) {
  const t = gs.today;
  const wages = payrollFor(gs);
  const severance = t.severance;
  gs.cash -= wages + severance;
  t.wages = wages;
  const rentDue = gs.day % CONFIG.rent.intervalDays === 0;
  const rent = rentDue ? rentFor(gs) : 0;
  gs.cash -= rent;
  const repBefore = gs.reputation;
  gs.reputation = clamp(gs.reputation + t.satisfactionSum, 0, CONFIG.reputationGoal);

  const gameover = rentDue && gs.cash < 0;
  const victory = !gameover && !gs.freePlay && gs.reputation >= CONFIG.reputationGoal;
  if (gameover) gs.phase = 'GAMEOVER';
  else if (victory) gs.phase = 'VICTORY';

  return {
    day: gs.day,
    revenue: t.revenue,
    experienceIncome: t.experienceIncome,
    rentalIncome: t.rentalIncome || 0, // v3 租用收入（单列）
    restockCost: t.restockCost,
    wages,
    severance,
    staffCost: wages + severance,
    net: t.revenue + t.experienceIncome + (t.rentalIncome || 0) - t.restockCost - wages - severance,
    rentDue,
    rent,
    cash: gs.cash,
    footfall: t.footfall,
    bought: t.bought,
    lost: t.lost,
    satisfactionSum: t.satisfactionSum,
    repBefore,
    reputation: gs.reputation,
    gameover,
    victory,
  };
}
