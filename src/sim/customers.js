/**
 * customers.js — 顾客类型消费、顾客生成器、AI 状态机步进 stepCustomer()。
 *
 * 状态机（v2，架构 §4.3）：
 *   ENTERING → BROWSING → TO_CHECKOUT → QUEUED → PAYING → LEAVING → GONE
 *                 ↓  ↑（体验后二次判定）         ↓ 队列满（第 6 位）→ LEAVING（退货）
 *              TO_EXPERIENCE → EXPERIENCING
 *   任意耐心耗尽 → LEAVING_ANGRY → GONE；队列耐心并行倒计时取先耗尽者
 *
 * v2 变更（最小化）：
 *  - target 保持品类级；成交时派生 targetSku（在售中售价最接近 budget）
 *  - 顾客只在 onShelf > 0 时购买；takeFromShelf 在判定成功瞬间执行（未成交）
 *  - QUEUED：队列容量 5；队首耐心 20s / 其余 14s；耐心归零退货不损失
 *  - 结账完成才计入收入（PAYING 到期由 day.js stepCheckout 派发 completePurchase）
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/customers
 */

import { CONFIG } from '../config.js';
import { purchaseProbability, seasonHeatMult, experienceFee, skuPriceOf, rentFeeOf } from './economy.js';
import { onShelfOf, onSaleSkusOfCat, takeFromShelf, returnToShelf } from './logistics.js';
import { onCustomerServed } from './story.js';
import { cleanupCustomerNeeds } from './needs.js';

/** 这些状态不再消耗耐心。 */
const NO_PATIENCE_STATES = ['EXPERIENCING', 'PAYING', 'LEAVING', 'LEAVING_ANGRY', 'GONE'];

/** 品类综合热度 = 基础热度 × 季节修正。 */
function categoryHeat(gs, cat) {
  return CONFIG.products[cat].baseHeat * seasonHeatMult(gs, cat);
}

/** 按权重抽取顾客类型；高声望提升 core/collector 出现率。 */
function pickType(gs, rng) {
  const boost = 1 + gs.reputation / CONFIG.repSpawnBoostDivisor;
  const weights = {};
  let total = 0;
  for (const t of CONFIG.customerTypeOrder) {
    let w = CONFIG.spawnWeights[t];
    if (t === 'core' || t === 'collector') w *= boost;
    weights[t] = w;
    total += w;
  }
  let roll = rng.next() * total;
  for (const t of CONFIG.customerTypeOrder) {
    roll -= weights[t];
    if (roll <= 0) return t;
  }
  return CONFIG.customerTypeOrder[CONFIG.customerTypeOrder.length - 1];
}

/**
 * 生成顾客。
 * @returns {object} Customer（id 由调用方分配）
 */
export function spawnCustomer(gs, rng, forcedType) {
  const type = forcedType || pickType(gs, rng);
  const def = CONFIG.customerTypes[type];
  const patience = rng.int(def.patience[0], def.patience[1]);
  return {
    id: 0,
    type,
    budget: rng.int(def.budget[0], def.budget[1]),
    patience,
    patienceMax: patience,
    pref: { ...def.pref },
    state: 'ENTERING',
    target: null,
    targetSku: null,
    slotId: null,
    timer: CONFIG.customer.walkEnter,
    bought: [],
    satisfaction: 0,
    regularId: null,
    expTried: false,
    // —— v2 ——
    pos: { ...CONFIG.layout.door },
    queueWait: 0,
    queuePatience: 0,
    needCooldown: {},
    buyFailed: false,
    buyMult: 1,
    rerollRecommend: false,
    expWait: 0,
    // —— v3 ——
    rentSku: null,      // 租用中的 SKU（需求 5：boardgame 可租）
    changeWrong: false, // 找零答错标记（需求 4：该客满意度上限 0）
  };
}

/**
 * 派生 targetSku（裁决 Q6）：品类在售 SKU 中售价最接近 budget 的那个。
 * 平局取 appeal 高者；再平取 skuOrder 靠前者（RNG 无关，可复现）。
 * @returns {string|null} 无陈列返回 null
 */
export function deriveTargetSku(gs, c) {
  if (c.target === null) return null;
  const onSale = onSaleSkusOfCat(gs, c.target);
  if (onSale.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  let bestAppeal = -Infinity;
  for (const skuId of onSale) {
    const sku = CONFIG.skus[skuId];
    const price = skuPriceOf(gs, skuId);
    const diff = Math.abs(price - c.budget);
    const appeal = (sku.appeal && sku.appeal[c.type]) || 1;
    if (diff < bestDiff - 1e-9
      || (Math.abs(diff - bestDiff) < 1e-9 && appeal > bestAppeal)) {
      best = skuId;
      bestDiff = diff;
      bestAppeal = appeal;
    }
  }
  return best;
}

/** 浏览选品：按 pref × heat × 有货（onShelf）加权随机；品类全空返回 null。 */
function chooseTarget(c, gs, rng) {
  const weights = {};
  let total = 0;
  for (const cat of CONFIG.categoryOrder) {
    const inStock = onShelfOf(gs, cat) > 0 ? 1 : 0;
    const w = (c.pref[cat] || 0) * categoryHeat(gs, cat) * inStock;
    weights[cat] = w;
    total += w;
  }
  if (total <= 0) return null;
  let roll = rng.next() * total;
  for (const cat of CONFIG.categoryOrder) {
    roll -= weights[cat];
    if (roll <= 0) return cat;
  }
  return null;
}

function acquireExperienceSlot(c, session) {
  for (let i = 0; i < session.expSlots.length; i += 1) {
    if (session.expSlots[i] === null) {
      session.expSlots[i] = c.id;
      return i;
    }
  }
  return -1;
}

function releaseExperienceSlot(c, session) {
  if (c.slotId !== null && session.expSlots[c.slotId] === c.id) {
    session.expSlots[c.slotId] = null;
  }
}

function goCheckout(c) {
  c.state = 'TO_CHECKOUT';
  c.timer = CONFIG.customer.walkToCheckout;
}

function enterLeavingAngry(c, session, gs) {
  releaseExperienceSlot(c, session);
  if (c.state === 'QUEUED') removeFromQueue(c, session);
  c.slotId = null;
  c.satisfaction = CONFIG.satisfaction.angry;
  c.state = 'LEAVING_ANGRY';
  c.timer = CONFIG.customer.walkLeave;
  // 怒走退货：手上拿的货回货架（库存不损失，A24）
  if (c.targetSku !== null && c.bought.length === 0) {
    returnToShelf(gs, c.targetSku);
    c.targetSku = null;
  }
  // v3 租用中的桌游也必须归还（在店内玩，离店不带走）
  if (c.rentSku) {
    returnToShelf(gs, c.rentSku);
    c.rentSku = null;
  }
  cleanupCustomerNeeds(session, c.id);
}

/** 平静离店（满意度 0，不扣声望，U7）。 */
function enterLeavingCalm(c, session, gs) {
  releaseExperienceSlot(c, session);
  if (c.state === 'QUEUED') removeFromQueue(c, session);
  c.slotId = null;
  c.satisfaction = 0;
  c.state = 'LEAVING';
  c.timer = CONFIG.customer.walkLeave;
  if (c.targetSku !== null && c.bought.length === 0) {
    returnToShelf(gs, c.targetSku);
    c.targetSku = null;
  }
  if (c.rentSku) {
    returnToShelf(gs, c.rentSku);
    c.rentSku = null;
  }
  cleanupCustomerNeeds(session, c.id);
}

function finalizeDeparture(c, gs) {
  c.state = 'GONE';
  gs.today.satisfactionSum += c.satisfaction;
  if (c.bought.length === 0) {
    gs.today.lost += 1;
  }
}

function beginBrowsing(c, gs, rng) {
  c.target = chooseTarget(c, gs, rng);
  c.state = 'BROWSING';
  c.timer = c.target === null
    ? 0 // 无货可看：下一 tick 直接走流失/体验判定
    : rng.int(CONFIG.customer.browseMin, CONFIG.customer.browseMax);
}

/** 队列操作。 */
function removeFromQueue(c, session) {
  if (!session.queue) return;
  const idx = session.queue.indexOf(c.id);
  if (idx !== -1) session.queue.splice(idx, 1);
}

/**
 * 浏览结束：命中偏好且有陈列 → 派生 targetSku + 概率判定 → 取货入队。
 */
function decideAfterBrowse(c, session, gs, rng) {
  if (c.target !== null && onShelfOf(gs, c.target) > 0) {
    const skuId = deriveTargetSku(gs, c);
    if (skuId !== null) {
      const skuDef = CONFIG.skus[skuId];
      let p = purchaseProbability(c, skuDef, gs, false);
      if (c.buyMult !== 1) p = Math.min(CONFIG.economy.pMax, p * c.buyMult); // findItem 气泡 ×1.3
      if (rng.next() < p) {
        // v3 租用分流（需求 5）：桌游 SKU 按类型概率改走「店内租用」
        const isBoardgame = skuDef.cat === 'boardgame_low' || skuDef.cat === 'boardgame_high';
        const rentChance = (CONFIG.rental && CONFIG.rental.rentChanceByType[c.type]) ?? 0;
        if (isBoardgame && rng.next() < rentChance) {
          c.rentSku = skuId;
          c.expTried = true;
          takeFromShelf(gs, skuId); // 租的这套先离架（玩完归还，不占售出）
          c.state = 'TO_EXPERIENCE';
          c.timer = CONFIG.customer.walkToExp;
          return;
        }
        c.targetSku = skuId;
        takeFromShelf(gs, skuId); // 取货（onShelf-1，尚未成交）
        goCheckout(c);
        return;
      }
    }
  }
  c.buyFailed = true;
  maybeExperienceOrLeave(c, session, gs, rng);
}

function maybeExperienceOrLeave(c, session, gs, rng) {
  const cc = CONFIG.customer;
  if (!c.expTried && rng.next() < cc.expTryChance) {
    c.state = 'TO_EXPERIENCE';
    c.timer = cc.walkToExp;
    return;
  }
  if (rng.next() < cc.leaveAngryChance) {
    enterLeavingAngry(c, session, gs);
  } else {
    c.satisfaction = 0;
    c.state = 'LEAVING';
    c.timer = cc.walkLeave;
    cleanupCustomerNeeds(session, c.id);
  }
}

/** 体验结束：二次购买判定（×expBuyBonus ×host加成）。 */
function decideAfterExperience(c, session, gs, rng) {
  c.target = chooseTarget(c, gs, rng);
  if (c.target !== null && onShelfOf(gs, c.target) > 0) {
    const skuId = deriveTargetSku(gs, c);
    if (skuId !== null) {
      const p = purchaseProbability(c, CONFIG.skus[skuId], gs, true);
      if (rng.next() < p) {
        c.targetSku = skuId;
        takeFromShelf(gs, skuId);
        goCheckout(c);
        return;
      }
    }
  }
  c.satisfaction = CONFIG.satisfaction.experienceOk;
  c.state = 'LEAVING';
  c.timer = CONFIG.customer.walkLeave;
}

/**
 * 收银完成（由 day.js stepCheckout 派发；★此刻才计入收入）。
 */
export function completePurchase(c, session, gs) {
  const skuId = c.targetSku;
  if (skuId !== null) {
    const price = skuPriceOf(gs, skuId);
    gs.cash += price;
    gs.today.revenue += price;
    gs.today.bought += 1;
    gs.skus[skuId].soldTotal += 1;
    c.bought.push({ id: skuId, price });
    const guide = CONFIG.skus[skuId].guidePrice;
    // v3 找零答错（需求 4）：该客满意度封顶 0（不奖不罚）
    c.satisfaction = c.changeWrong ? 0 : (price <= guide * CONFIG.economy.cheapThreshold
      ? CONFIG.satisfaction.buyCheap
      : CONFIG.satisfaction.buyPricey);
    onCustomerServed(gs, c);
  }
  c.targetSku = null;
  c.state = 'LEAVING';
  c.timer = CONFIG.customer.walkLeave;
  cleanupCustomerNeeds(session, c.id);
}

/**
 * 顾客 AI 状态机步进。
 * 耐心从进店起倒计时；QUEUED 时队列耐心并行倒计时（取先耗尽者）。
 * @param {object} c Customer
 * @param {object} session DaySession（含 expSlots / queue / paySlots）
 * @param {object} gs GameState
 * @param {object} rng 随机数实例
 * @param {number} dt 步长（秒）
 */
export function stepCustomer(c, session, gs, rng, dt) {
  if (c.state === 'GONE') return;
  // 自身耐心（非排队状态）
  if (!NO_PATIENCE_STATES.includes(c.state) && c.state !== 'QUEUED') {
    c.patience -= dt;
    if (c.patience <= 0) {
      enterLeavingAngry(c, session, gs);
      return;
    }
  }
  // 队列耐心（QUEUED 专属，与自身耐心并行取先耗尽）
  if (c.state === 'QUEUED') {
    c.queueWait += dt;
    if (c.queuePatience <= 0) c.queuePatience = CONFIG.checkout.queuePatienceHead;
    c.queuePatience -= dt;
    if (c.queuePatience <= 0) {
      enterLeavingAngry(c, session, gs);
      return;
    }
  }
  // 体验排队等待累计（explain 气泡触发条件）
  if (c.state === 'TO_EXPERIENCE') c.expWait += dt;

  c.timer -= dt;
  const cc = CONFIG.customer;
  switch (c.state) {
    case 'ENTERING':
      if (c.timer <= 0) beginBrowsing(c, gs, rng);
      break;
    case 'BROWSING':
      if (c.timer <= 0) decideAfterBrowse(c, session, gs, rng);
      break;
    case 'TO_EXPERIENCE': {
      const idx = acquireExperienceSlot(c, session);
      if (idx !== -1) {
        c.slotId = idx;
        c.state = 'EXPERIENCING';
        c.expTried = true;
        c.expWait = 0;
        c.timer = rng.int(CONFIG.experience.durationMin, CONFIG.experience.durationMax);
        // v3 租用（需求 5）：带 rentSku 入座收租金（按时计），否则收体验费（互斥）
        if (c.rentSku) {
          const fee = rentFeeOf(gs, c.rentSku);
          gs.cash += fee;
          gs.today.rentalIncome = (gs.today.rentalIncome || 0) + fee;
        } else {
          const fee = experienceFee(gs);
          gs.cash += fee;
          gs.today.experienceIncome += fee;
        }
      }
      // 无空位：原地等待，耐心照扣
      break;
    }
    case 'EXPERIENCING':
      if (c.timer <= 0) {
        releaseExperienceSlot(c, session);
        c.slotId = null;
        if (c.rentSku) {
          // 租玩结束：归还上架（有同 SKU 格回填，否则空格/后仓兜底），满意平静离店
          returnToShelf(gs, c.rentSku);
          c.rentSku = null;
          c.satisfaction = CONFIG.satisfaction.experienceOk;
          c.state = 'LEAVING';
          c.timer = CONFIG.customer.walkLeave;
          cleanupCustomerNeeds(session, c.id);
          break;
        }
        decideAfterExperience(c, session, gs, rng);
      }
      break;
    case 'TO_CHECKOUT': {
      if (c.timer > 0) break;
      // 走到收银区：队列容量 5；第 6 位平静离店（满意度 0、退货，U7）
      if (!session.queue) session.queue = [];
      if (session.queue.length >= CONFIG.checkout.queueCapacity) {
        enterLeavingCalm(c, session, gs);
        break;
      }
      session.queue.push(c.id);
      c.state = 'QUEUED';
      c.queueWait = 0;
      c.queuePatience = session.queue.length === 1
        ? CONFIG.checkout.queuePatienceHead
        : CONFIG.checkout.queuePatienceTail;
      break;
    }
    case 'QUEUED':
      // paySlot 分配由 day.js stepCheckout 处理
      break;
    case 'PAYING':
      // 计时由 day.js stepCheckout 的 paySlot.elapsed 驱动
      break;
    case 'LEAVING':
    case 'LEAVING_ANGRY':
      if (c.timer <= 0) finalizeDeparture(c, gs);
      break;
    default:
      break;
  }
}
