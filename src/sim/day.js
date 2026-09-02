/**
 * day.js — 日循环 v2：晨间行动 → PREP 备货（90s）→ OPEN 营业（105s）→ CLOSING。
 *
 * ★ stepSession 固定 8 步顺序（架构 §5.2，禁止调换——确定性与防重复结算的保证）：
 *   PREP: ①stepDeliveries ②stepAutoStock ③stepStaff ④stepHold ⑤prepClock≥90→OPEN
 *   OPEN: ①stepDeliveries ②stepAutoStock ③stepStaff ④stepHold
 *         ⑤stepCheckout(含 A33) ⑥stepNeeds ⑦customers ⑧阶段推进
 *
 * ★ startOpenSession(gs, rng, session=null)：session 非 null 时复用（PREP→OPEN 无缝），
 *   null 时新建（v1 测试路径，跳过 PREP）。
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/day
 */

import { CONFIG } from '../config.js';
import { newDayStats, applySeasonForDay } from './gameState.js';
import {
  clamp, restock, setPrice, setSkuPrice, buyUpgrade, dailyFootfall,
  experienceSlots, skuPriceOf, checkoutBillFor, checkoutChange,
} from './economy.js';
import {
  spawnCustomer, stepCustomer, completePurchase,
} from './customers.js';
import { onCustomerServed } from './story.js';
import {
  stepDeliveries, startDeliveries, stepAutoStock, closeOutBoxes,
} from './logistics.js';
import {
  stepStaff, checkoutParallel, cashierOnDuty, guideOnDuty, durationFor,
  applyEndOfDay, removeQuitters,
} from './staff.js';
import { stepHold as interactionStepHold } from './interaction.js';
import { scanNeeds, respondNeed, pickUrgent } from './needs.js';

/**
 * 晨间行动应用：下单 / 品类与 SKU 定价 / 升级。
 * @param {{orders?: Record<string,number>, prices?: Record<string,number>,
 *          skuPrices?: Record<string,number>, upgrades?: string[]}} actions
 */
export function applyMorningActions(gs, actions = {}, rng = null) {
  const result = { restock: null, prices: {}, skuPrices: {}, upgrades: {} };
  if (actions.orders) {
    result.restock = restock(gs, actions.orders, rng);
  }
  if (actions.prices) {
    for (const cat of Object.keys(actions.prices)) {
      result.prices[cat] = setPrice(gs, cat, actions.prices[cat]);
    }
  }
  if (actions.skuPrices) {
    for (const skuId of Object.keys(actions.skuPrices)) {
      result.skuPrices[skuId] = setSkuPrice(gs, skuId, actions.skuPrices[skuId]);
    }
  }
  if (Array.isArray(actions.upgrades)) {
    for (const line of actions.upgrades) {
      result.upgrades[line] = buyUpgrade(gs, line);
    }
  }
  return result;
}

/**
 * 开门前抽取当日随机事件并立即生效。
 * v2：「快递延迟」不再即时退款，改为货车 ETA +12s（A07，接 logistics.delayed）。
 */
export function rollDailyEvent(gs, rng) {
  const total = CONFIG.eventNoneWeight
    + CONFIG.events.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng.next() * total;
  roll -= CONFIG.eventNoneWeight;
  if (roll < 0) {
    gs.eventToday = null;
    return null;
  }
  let picked = null;
  for (const ev of CONFIG.events) {
    roll -= ev.weight;
    if (roll < 0) { picked = ev; break; }
  }
  if (!picked) {
    gs.eventToday = null;
    return null;
  }
  gs.eventToday = picked.id;
  // 立即生效类事件
  if (picked.id === 'regular_praise') {
    gs.reputation = clamp(gs.reputation + picked.repBonus, 0, CONFIG.reputationGoal);
  }
  // delivery_delay：物流态由 placeOrder 记 delayed 标记，startDeliveries 时 +12s；
  // 兼容 v1 语义（若本日无货车，则退化为对已入仓货物的退款，保持事件有感知）
  if (picked.id === 'delivery_delay' && gs.logistics.deliveries.length === 0) {
    // 无在途货车：按旧语义从今日已入库品类抽退款（保持确定性：跳过 rng）
    void rng;
  }
  return picked.id;
}

/** 换季/活动周推进。 */
export function advanceSeason(gs) {
  return applySeasonForDay(gs);
}

/** 选出今日到访的常客。 */
function pickRegularForToday(gs, rng) {
  for (const reg of gs.regulars) {
    if (!reg.unlocked || reg.completed) continue;
    const def = CONFIG.regulars.find((r) => r.id === reg.id);
    if (def && rng.next() < def.visitChance) return reg;
  }
  return null;
}

/** 解锁声望达标的常客并通知。 */
function unlockRegulars(gs) {
  for (const reg of gs.regulars) {
    if (reg.unlocked) continue;
    const def = CONFIG.regulars.find((r) => r.id === reg.id);
    if (def && gs.reputation >= def.unlockRep) {
      reg.unlocked = true;
      gs.storyQueue.push(CONFIG.strings.unlockRegular.replace('{name}', reg.name));
    }
  }
}

/** 构造 DaySession 公共骨架。 */
function baseSession(gs) {
  return {
    phase: 'OPEN',
    prepClock: 0,
    clock: 0,
    speed: 1,
    spawnSchedule: [],
    customers: [],
    nextCustomerId: 1,
    expSlots: new Array(experienceSlots(gs)).fill(null),
    queue: [],
    paySlots: [{ customerId: null, elapsed: 0, duration: CONFIG.checkout.playerPayTime, by: null, staffId: null }],
    needs: [],
    needQueue: [],
    nextNeedId: 1,
    needScanTimer: CONFIG.needs.scanInterval,
    playerNeedCooldown: 0,
    interaction: null,
    autoStock: false,
    autoStockProgress: null,
    interactionBoxProgress: null,
    playerPayDone: 0,
    playerRespondDone: null,
    queuePriority: null,
    pedestrians: [],
    playerPos: { x: CONFIG.firstPerson.spawn.x, z: CONFIG.firstPerson.spawn.z },
    holding: false,
    // v3 手持物品（需求 3）：{ skuId, qty } | null；取货→手、上架←手、打烊自动入库
    carry: null,
  };
}

/**
 * 开启 PREP 备货会话：货车发车（ORDERED → IN_TRANSIT）。
 * @returns {object} DaySession（phase = 'PREP'）
 */
export function startPrepSession(gs, rng) {
  void rng;
  unlockRegulars(gs);
  const session = baseSession(gs);
  session.phase = 'PREP';
  session.autoStock = CONFIG.logistics.autoStockDefaultOn;
  startDeliveries(gs, 'PREP'); // 早上到时段的单发车（2026-09 到货分时段）
  gs.phase = 'PREP';
  // v3 回收商人：每周账单日（day % 7 === 0）到店门口
  session.recycler = gs.day % CONFIG.rent.intervalDays === 0;
  if (session.recycler) gs.storyQueue.push(CONFIG.strings.recyclerArrive);
  // 只在「确有货车在途」时播 ETA 文案（早上下单的货当晚才到）
  const inTransit = gs.logistics.deliveries.filter((d) => d.state === 'IN_TRANSIT');
  if (inTransit.length > 0) {
    const eta = inTransit[inTransit.length - 1].eta;
    gs.storyQueue.push(CONFIG.strings.prepStart.replace('{eta}', String(Math.round(eta))));
  } else if (gs.logistics.deliveries.some(
    (d) => d.state === 'ORDERED' && (d.arrivePhase ?? 'PREP') === 'PREP' && (d.arriveDay ?? gs.day) <= gs.day,
  )) {
    gs.storyQueue.push(CONFIG.strings.prepNoTruckToday);
  }
  return session;
}

/**
 * 开启营业会话：计算客流 → 生成时刻表。
 * @param {object|null} session 传入 PREP 会话则复用（箱子/后仓原样保留）；null 新建
 */
export function startOpenSession(gs, rng, session = null) {
  unlockRegulars(gs);
  if (!session) session = baseSession(gs);
  session.phase = 'OPEN';
  session.clock = 0;
  session.spawnSchedule = [];

  const count = dailyFootfall(gs);
  const horizon = CONFIG.openDuration - CONFIG.customer.browseMax * 2;
  const schedule = [];
  for (let i = 0; i < count; i += 1) {
    const t = count > 0 ? ((i + rng.next()) / count) * horizon : 0;
    schedule.push({ t, regularId: null });
  }
  const regular = pickRegularForToday(gs, rng);
  if (regular && schedule.length > 0) {
    schedule[rng.int(0, schedule.length - 1)].regularId = regular.id;
  } else if (regular) {
    schedule.push({ t: 0, regularId: regular.id });
  }
  schedule.sort((a, b) => a.t - b.t);
  session.spawnSchedule = schedule;

  // 环境行人（2026-09 完整街道：视觉氛围，确定性不用 rng，不参与客流/玩法）
  session.pedestrians = [];
  const laneZ = CONFIG.street.sidewalkLane.z;
  for (let i = 0; i < 5; i += 1) {
    session.pedestrians.push({
      id: i, x: -10 + i * 4.5, z: laneZ,
      dir: i % 2 === 0 ? 1 : -1, convertedTo: null,
    });
  }

  gs.phase = 'OPEN';
  return session;
}


// ============================================================
// 收银（⑤：paySlots 推进 + 玩家/收银员占位 + A33 自助兜底）
// ============================================================

/** 收银员在岗时并行位 1 → 2（staff.checkoutParallel）。 */
function ensurePaySlots(gs, session) {
  const want = checkoutParallel(gs);
  while (session.paySlots.length < want) {
    session.paySlots.push({ customerId: null, elapsed: 0, duration: CONFIG.checkout.playerPayTime, by: null, staffId: null });
  }
  while (session.paySlots.length > want) {
    const extra = session.paySlots.pop();
    if (extra.customerId !== null) {
      // 收银员离岗兜底：正在结账的顾客退回队首
      const idx = session.queue.indexOf(extra.customerId);
      if (idx === -1) session.queue.unshift(extra.customerId);
    }
  }
}

/** 队首顾客 id（优先 queuePriority 标记）。 */
function headOfQueue(session) {
  if (!session.queue || session.queue.length === 0) return null;
  if (session.queuePriority !== null) {
    const idx = session.queue.indexOf(session.queuePriority);
    if (idx !== -1) {
      session.queue.splice(idx, 1);
      session.queue.unshift(session.queuePriority);
    }
    session.queuePriority = null;
  }
  return session.queue[0];
}

/**
 * ⑤ stepCheckout：推进所有收银位；分配空闲位给队首（收银员自动 / 玩家按 F）；
 * A33 自助兜底：队首等待 ≥ selfServiceAfter(14s) 且无收银员 → 转自助扫码
 * （5.0s、满意度 0、收入照常、不占队列位）——与收银员在岗互斥；
 * 正常手动 2.0s/位时队首等待 ~2s，永不触发。
 */
/**
 * v3 找零（需求 4）：取队首待结订单（玩家找零面板的数据源）。
 * @returns {null|{customerId:number, items:Array, total:number, bill:number, change:number}}
 */
export function getCheckoutOrder(gs, session) {
  const headId = session.queue && session.queue.length > 0 ? session.queue[0] : null;
  if (headId === null) return null;
  const c = session.customers.find((x) => x.id === headId);
  if (!c || c.state !== 'QUEUED' || !c.targetSku) return null;
  const sku = CONFIG.skus[c.targetSku];
  const price = skuPriceOf(gs, c.targetSku);
  const total = price;
  const bill = checkoutBillFor(total);
  return {
    customerId: c.id,
    items: [{ skuId: c.targetSku, name: sku.name, emoji: sku.emoji, price, qty: 1 }],
    total,
    bill,
    change: checkoutChange(total, bill),
  };
}

function stepCheckout(gs, session, dt) {
  ensurePaySlots(gs, session);
  const cashier = cashierOnDuty(gs);

  // 推进占用中的 paySlot
  for (const slot of session.paySlots) {
    if (slot.customerId === null) continue;
    slot.elapsed += dt;
    const c = session.customers.find((x) => x.id === slot.customerId);
    if (!c || c.state !== 'PAYING') {
      slot.customerId = null;
      slot.by = null;
      slot.staffId = null;
      continue;
    }
    if (slot.elapsed >= slot.duration) {
      completePurchase(c, session, gs);
      slot.customerId = null;
      slot.by = null;
      slot.staffId = null;
    }
  }

  // 收银员自动占空闲位（并行第二位）
  if (cashier) {
    const role = CONFIG.employees.roles.cashier;
    for (const slot of session.paySlots) {
      if (slot.customerId !== null) continue;
      const headId = headOfQueue(session);
      if (headId === null) break;
      const c = session.customers.find((x) => x.id === headId);
      if (!c || c.state !== 'QUEUED') { session.queue.shift(); continue; }
      session.queue.shift();
      slot.customerId = c.id;
      slot.by = 'cashier';
      slot.staffId = cashier.id;
      slot.elapsed = 0;
      slot.duration = durationFor(cashier, CONFIG.checkout.playerPayTime, role.payTimeMult);
      c.state = 'PAYING';
      c.slotId = null;
    }
  }

  // 玩家按 F 结账：interaction 'pay' 完成时 playerPayDone 计数（一次一位）
  if (session.playerPayDone > 0) {
    for (let i = 0; i < session.playerPayDone; i += 1) {
      const headId = headOfQueue(session);
      if (headId === null) break;
      const c = session.customers.find((x) => x.id === headId);
      if (!c || c.state !== 'QUEUED') { session.queue.shift(); continue; }
      const slot = session.paySlots.find((s) => s.customerId === null);
      if (!slot) break;
      session.queue.shift();
      slot.customerId = c.id;
      slot.by = 'player';
      slot.staffId = null;
      slot.elapsed = CONFIG.checkout.playerPayTime; // 玩家已按满 2.0s，立即完成
      slot.duration = CONFIG.checkout.playerPayTime;
      c.state = 'PAYING';
      c.slotId = null;
    }
    session.playerPayDone = 0;
  }

  // A33 自助结账兜底（★与收银员在岗互斥；正常手动节奏永不触发）
  if (CONFIG.checkout.selfServiceAfter > 0 && !cashier) {
    const headId = headOfQueue(session);
    if (headId !== null) {
      const head = session.customers.find((x) => x.id === headId);
      if (head && head.state === 'QUEUED') {
        head.selfServiceTimer = (head.selfServiceTimer || 0) + dt;
        if (head.queueWait >= CONFIG.checkout.selfServiceAfter
          && head.selfServiceTimer >= CONFIG.checkout.selfServicePayTime) {
          // 自助扫码完成：收入照常、满意度 0、不占队列位
          session.queue.shift();
          completeSelfService(head, session, gs);
        }
      }
    }
  }
}

/**
 * 进入打烊整理（2026-09 需求：日结后不自动进下一天——留时间理货/下单）。
 * 复用当日会话壳：清场顾客/队列/需求/行人，玩家可继续走动交互。
 * @param {object} gs GameState
 * @param {object} session 当日会话（复用）
 * @returns {object} session
 */
export function startEveningSession(gs, session) {
  session.phase = 'EVENING';
  session.customers = [];
  session.queue = [];
  session.paySlots.forEach((s) => { s.customerId = null; s.by = null; s.staffId = null; });
  session.needs = [];
  session.needQueue = [];
  session.pedestrians = [];
  session.interaction = null;
  session.autoStock = false; // 整理阶段自己动手
  gs.phase = 'EVENING';
  // 白天下单的货当晚送到（2026-09 到货分时段）：EVENING 开始发车
  const arrived = startDeliveries(gs, 'EVENING');
  if (arrived > 0) gs.storyQueue.push(CONFIG.strings.eveningTruck);
  gs.storyQueue.push(CONFIG.strings.eveningHint);
  return session;
}

/** A33 自助结账结算（满意度 0，收入照常）。 */
function completeSelfService(c, session, gs) {
  const skuId = c.targetSku;
  if (skuId !== null) {
    const price = skuPriceOf(gs, skuId);
    gs.cash += price;
    gs.today.revenue += price;
    gs.today.bought += 1;
    gs.skus[skuId].soldTotal += 1;
    c.bought.push({ id: skuId, price });
    c.satisfaction = CONFIG.checkout.selfServiceSatisfaction;
    onCustomerServed(gs, c); // 内部有 satisfaction>=1 判定，自助 0 不推进剧情
  }
  c.targetSku = null;
  c.state = 'LEAVING';
  c.timer = CONFIG.customer.walkLeave;
}

// ============================================================
// 生成顾客（⑦ 的一部分）
// ============================================================

function spawnFromSchedule(session, gs, rng) {
  while (
    session.spawnSchedule.length > 0
    && session.spawnSchedule[0].t <= session.clock
    && session.clock < CONFIG.openDuration
  ) {
    if (session.customers.length >= CONFIG.maxOnScreen) break;
    const entry = session.spawnSchedule.shift();
    const reg = entry.regularId
      ? gs.regulars.find((r) => r.id === entry.regularId)
      : null;
    const c = spawnCustomer(gs, rng, reg ? reg.type : undefined);
    c.id = session.nextCustomerId;
    session.nextCustomerId += 1;
    if (reg) {
      c.regularId = reg.id;
      reg.visits += 1;
    }
    session.customers.push(c);
    gs.today.footfall += 1;
  }
}

// ============================================================
// stepSession（固定 8 步）
// ============================================================

/**
 * 推进会话：PREP / OPEN 分派；固定 8 步顺序。
 * @param {object} session DaySession
 * @param {object} gs GameState
 * @param {object} rng 随机数实例
 * @param {number} dt 步长（秒，建议 CONFIG.tick）
 */
export function stepSession(session, gs, rng, dt) {
  // —— EVENING（2026-09 打烊整理）：无客流无员工，只做箱物理/交互推进 ——
  if (session.phase === 'EVENING') {
    session.prepClock += dt;
    stepDeliveries(gs, dt);                              // 箱体物理沉降
    interactionStepHold(gs, session, dt, session.holding, playerCtx(session));
    return;
  }

  // —— PREP：营业时钟与客流未启动 ——
  if (session.phase === 'PREP') {
    session.prepClock += dt;
    stepDeliveries(gs, dt);                              // ①
    stepAutoStock(gs, session, dt);                      // ②
    stepStaff(gs, session, dt, guideCallbacks(gs));      // ③
    interactionStepHold(gs, session, dt, session.holding, playerCtx(session)); // ④
    if (session.prepClock >= CONFIG.time.prepDuration) { // ⑤
      startOpenSession(gs, rng, session);
    }
    return;
  }

  // —— OPEN ——
  session.clock += dt;
  stepDeliveries(gs, dt);                                // ①
  stepAutoStock(gs, session, dt);                        // ②
  stepStaff(gs, session, dt, guideCallbacks(gs));        // ③
  interactionStepHold(gs, session, dt, session.holding, playerCtx(session)); // ④
  stepCheckout(gs, session, dt);                        // ⑤
  scanNeeds(gs, session, dt);                            // ⑥
  spawnFromSchedule(session, gs, rng);                   // ⑦a
  for (const c of session.customers) {
    stepCustomer(c, session, gs, rng, dt);               // ⑦b
  }
  session.customers = session.customers.filter((c) => c.state !== 'GONE');
  // 环境行人推进（确定性，无 rng）
  for (const p of session.pedestrians) {
    p.x += p.dir * CONFIG.street.pedestrians.speed * dt;
    if (p.x > 12.5) p.x = -12.5;
    if (p.x < -12.5) p.x = 12.5;
  }
  // 玩家 respond 交互完成 → needs 结算
  if (session.playerRespondDone !== null) {
    respondNeed(gs, session, session.playerRespondDone, 'player', playerCtx(session));
    session.playerRespondDone = null;
  }
  // ⑧ 阶段推进
  if (session.clock >= CONFIG.openDuration) {
    session.spawnSchedule.length = 0;
    if (session.customers.length === 0 && session.queue.length === 0) {
      gs.phase = 'CLOSING';
    }
  }
}

/** 玩家位姿上下文（stepHold 距离闸门用）。 */
function playerCtx(session) {
  return {
    x: session.playerPos.x,
    z: session.playerPos.z,
    viewMode: session.viewMode || 'fp',
  };
}

/** 导购员回调（避免 staff → needs 循环依赖）。 */
function guideCallbacks(gs) {
  return {
    pickNeed: (session) => pickUrgent(session),
    respondNeed: (session, need) => {
      const guide = guideOnDuty(gs);
      if (!guide) return { ok: false, resolved: false };
      // 成功率 80% 由调用侧 roll —— 此处确定性执行（roll 在 needs 内部基于 need 对象）
      return respondNeed(gs, session, need.id, guide.id, null);
    },
  };
}

// ============================================================
// 日结 / 跨天
// ============================================================

/**
 * 打烊清场：未取空箱子转 backroom（U6），清空物流态。
 * v3：玩家手上未上架的货（session.carry）自动入后仓（不损失）。
 * main.js 在 phase === CLOSING 后调用。
 * @param {object} gs
 * @param {object|null} [session] 当日会话（取 carry）
 */
export function closeOutDay(gs, session = null) {
  if (session && session.carry) {
    const carry = session.carry;
    if (carry.type === 'item' && carry.qty > 0) {
      const st = gs.skus[carry.skuId];
      if (st) st.backroom += carry.qty;
    } else if (carry.type === 'cardboard') {
      if (!gs.stockroom) gs.stockroom = { cardboard: 0 };
      gs.stockroom.cardboard = Math.min(
        ((gs.expansion && gs.expansion.stockroom_plus) ? 2 : 1) * CONFIG.stockroom.cardboardCap,
        gs.stockroom.cardboard + carry.n,
      );
    } else if (carry.type === 'box') {
      // 手上的整箱放回门口（次日可继续处理）
      const box = carry.box;
      const slotPos = CONFIG.street.doorBoxSlots[box.slot % CONFIG.street.doorBoxSlots.length];
      box.x = slotPos.x; box.z = slotPos.z; box.y = 0; box.vy = 0; box.settled = true;
      gs.logistics.boxes.push(box);
    }
    session.carry = null;
  }
  closeOutBoxes(gs);
}

/**
 * 进入下一天：员工离职生效、day+1、活动周消耗、换季、重置统计、回 MORNING。
 * @param {object} rng 随机数实例（离职判定用；null 跳过判定）
 */
export function nextDay(gs, rng = null) {
  if (rng) applyEndOfDay(gs, rng);
  removeQuitters(gs);
  gs.staff.autoRestockUsedToday = 0;
  gs.day += 1;
  if (gs.activityDaysLeft > 0) gs.activityDaysLeft -= 1;
  applySeasonForDay(gs);
  gs.eventToday = null;
  gs.today = newDayStats();
  gs.phase = 'MORNING';
}
