/**
 * staff.js — 员工系统：雇佣 / 解雇 / 排班 / 疲劳 / 离职（次日生效）/ 星级 /
 * 四岗位自动作业（收银 cashier / 导购 guide / 体验官 host / 仓管 stocker）。
 *
 * 与玩家并存协议（架构 §6.2）：
 *  - 员工（stepSession ③）先于玩家（④）：员工抢到 claimedBy 后玩家 beginHold 失败
 *  - 玩家占用的对象员工跳过；玩家不可被抢占
 *  - 导购不受玩家 3s 全局冷却限制，但受顾客同类 6s 冷却约束
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/staff
 */

import { CONFIG } from '../config.js';
import { claimBox, pickTick, restockToSlot, doorBoxCount, stackCap, slotsAll } from './logistics.js';

// ============================================================
// 效率换算（架构 §3.5 唯一公式）
// ============================================================

/** 星级效果倍率（1.0 / 1.25 / 1.5）。 */
export function starMult(s) {
  return CONFIG.employees.stars.effect[s.stars - 1];
}

/** 疲劳效率倍率（≤70 → 1.0；71–90 → penaltyMult；>90 → severeMult）。 */
export function fatigueMult(s) {
  const f = CONFIG.employees.fatigue;
  if (s.fatigue > f.severeAt) return f.severeMult;
  if (s.fatigue > f.penaltyAt) return f.penaltyMult;
  return 1;
}

/** 综合效率 = starMult × fatigueMult。 */
export function efficiency(s) {
  return starMult(s) * fatigueMult(s);
}

/** 动作耗时 = base × roleMult / efficiency。 */
export function durationFor(s, base, roleMult = 1) {
  return (base * roleMult) / efficiency(s);
}

// ============================================================
// 查询
// ============================================================

/** 在岗（今日排班且未离职）员工。 */
export function onDutyMembers(gs) {
  return gs.staff.members.filter((m) => m.onDutyToday && !m.quitting);
}

/** 指定岗位的在岗员工列表。 */
export function onDutyOfRole(gs, role) {
  return onDutyMembers(gs).filter((m) => m.role === role);
}

export function cashierOnDuty(gs) {
  return onDutyOfRole(gs, 'cashier')[0] || null;
}

export function guideOnDuty(gs) {
  return onDutyOfRole(gs, 'guide')[0] || null;
}

export function hostOnDuty(gs) {
  return onDutyOfRole(gs, 'host')[0] || null;
}

export function stockerOnDuty(gs) {
  return onDutyOfRole(gs, 'stocker')[0] || null;
}

/** 并行收银位数：收银员在岗 → cashierParallelSlots(2)，否则 parallelSlots(1)。 */
export function checkoutParallel(gs) {
  return cashierOnDuty(gs) ? CONFIG.employees.roles.cashier.parallelSlots : CONFIG.checkout.parallelSlots;
}

/** 员工日薪 = round(dailyWage × stars.wage[★-1] × wageMult)。 */
export function dailyWageOf(s) {
  const role = CONFIG.employees.roles[s.role];
  return Math.round(role.dailyWage * CONFIG.employees.stars.wage[s.stars - 1] * (s.wageMult || 1));
}

/** 当日应发薪资（仅 onDutyToday；★不上班不付薪）。 */
export function payrollFor(gs) {
  let sum = 0;
  for (const m of gs.staff.members) {
    if (m.onDutyToday) sum += dailyWageOf(m);
  }
  return sum;
}

/** 解雇遣散费 = severanceDays(1) 天日薪。 */
export function severanceFor(s) {
  return dailyWageOf(s) * CONFIG.employees.severanceDays;
}

// ============================================================
// 雇佣 / 解雇 / 排班
// ============================================================

/** 从 namePool 取名（确定性：按 nextId）。 */
function pickName(gs) {
  const pool = CONFIG.employees.namePool;
  return pool[(gs.staff.nextId - 1) % pool.length];
}

/**
 * 雇佣：扣签约金；星级按权重抽取（rng 注入）。
 * @param {object} gs GameState
 * @param {object} rng 种子随机实例
 * @param {string} role 岗位 id
 * @param {number} [stars] 强制星级（测试用；缺省按权重抽取）
 * @returns {{ok: boolean, staff?: object, reason?: string}}
 */
export function hire(gs, rng, role, stars = null) {
  const cfg = CONFIG.employees;
  const roleDef = cfg.roles[role];
  if (!roleDef) return { ok: false, reason: 'invalid_role' };
  if (gs.staff.members.length >= cfg.maxCount) return { ok: false, reason: 'full' };
  const bonus = roleDef.signBonus;
  if (gs.cash < bonus) return { ok: false, reason: 'cash' };
  let starLevel = stars;
  if (starLevel === null) {
    const roll = rng.next();
    const w = cfg.stars.weights;
    starLevel = roll < w[0] ? 1 : (roll < w[0] + w[1] ? 2 : 3);
  }
  gs.cash -= bonus;
  const member = {
    id: gs.staff.nextId,
    name: pickName(gs),
    role,
    stars: Math.min(3, Math.max(1, Math.round(starLevel))),
    fatigue: 0,
    onDutyToday: true,
    hiredDay: gs.day,
    wageMult: 1,
    quitting: false,
    pos: { x: 0, z: 0 },
    task: null,
    timer: 0,
  };
  gs.staff.nextId += 1;
  gs.staff.members.push(member);
  gs.storyQueue.push(
    CONFIG.strings.staffHired
      .replace('{name}', member.name)
      .replace('{role}', roleDef.name)
      .replace('{stars}', String(member.stars))
      .replace('{bonus}', String(bonus)),
  );
  return { ok: true, staff: member };
}

/**
 * 解雇：立即扣遣散费（1 天日薪）。
 * @returns {{ok: boolean, cost: number, reason?: string}}
 */
export function fire(gs, id) {
  const idx = gs.staff.members.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: false, cost: 0, reason: 'not_found' };
  const member = gs.staff.members[idx];
  const cost = severanceFor(member);
  if (gs.cash < cost) return { ok: false, cost: 0, reason: 'cash' };
  gs.cash -= cost;
  gs.today.severance += cost;
  gs.staff.members.splice(idx, 1);
  gs.storyQueue.push(
    CONFIG.strings.staffFired.replace('{name}', member.name).replace('{cost}', String(cost)),
  );
  return { ok: true, cost };
}

/**
 * 排班阀门：★「不上班不付薪」。
 * @returns {boolean}
 */
export function setDuty(gs, id, onDuty) {
  const m = gs.staff.members.find((x) => x.id === id);
  if (!m) return false;
  m.onDutyToday = Boolean(onDuty);
  return true;
}

// ============================================================
// 每日结算（CLOSING 后、nextDay 前调用）
// ============================================================

/**
 * 日终结算：疲劳 ±、离职判定（次日生效）。
 * - 在岗 fatigue += workGain(25)；休息 fatigue -= restRecover(40)；clamp [0,100]
 * - 欠薪（结算后 cash < 0 且在岗）→ 离职概率 unpaidChance(35%)
 * - fatigue > severeAt(90) → severeChance(20%)；其余 normalChance(2%)
 * @param {object} gs GameState
 * @param {object} rng 种子随机实例
 * @returns {{quitIds: number[], fatigueAfter: Record<number, number>}}
 */
export function applyEndOfDay(gs, rng) {
  const f = CONFIG.employees.fatigue;
  const q = CONFIG.employees.quit;
  const quitIds = [];
  const fatigueAfter = {};
  for (const m of gs.staff.members) {
    m.fatigue = m.onDutyToday
      ? Math.min(100, m.fatigue + f.workGain)
      : Math.max(0, m.fatigue - f.restRecover);
    fatigueAfter[m.id] = m.fatigue;
    if (m.quitting) continue; // 已判定者不重复判定
    let chance = q.normalChance;
    if (m.onDutyToday && gs.cash < 0) chance = q.unpaidChance;
    else if (m.fatigue > f.severeAt) chance = q.severeChance;
    if (rng.next() < chance) {
      m.quitting = true;
      quitIds.push(m.id);
      gs.storyQueue.push(CONFIG.strings.staffQuit.replace('{name}', m.name));
    }
  }
  return { quitIds, fatigueAfter };
}

/** 移除已离职员工（nextDay 时调用）。 */
export function removeQuitters(gs) {
  gs.staff.members = gs.staff.members.filter((m) => !m.quitting);
}

// ============================================================
// 每 tick 自动作业（stepSession ③，早于玩家 ④）
// ============================================================

/**
 * 员工 tick：按岗位推进自动作业。
 * - stocker：找未占用箱子（开/取），或后仓补货（duration = restockTime×0.375/eff → 1.5s）
 * - guide：每 respondInterval(12s)/eff 响应一个 PENDING 气泡（由 needs 提供回调）
 * - cashier：在岗 → paySlots.length = 2（由 day.js 的 ensurePaySlots 处理），本 tick 占空闲位
 * - host：不占位，仅修改体验时长/概率倍率（customers.js 读取）
 * @param {object} session DaySession
 * @param {object} needsCallbacks { pickNeed, respondNeed } — 由 day.js 注入，避免循环依赖
 */
export function stepStaff(gs, session, dt, needsCallbacks = null) {
  for (const m of onDutyMembers(gs)) {
    if (m.task !== null) {
      advanceTask(gs, session, m, dt);
      continue;
    }
    if (m.timer > 0) {
      m.timer -= dt;
      continue;
    }
    switch (m.role) {
      case 'stocker':
        stepStocker(gs, m);
        break;
      case 'guide':
        stepGuide(gs, session, m, needsCallbacks);
        break;
      case 'cashier':
        // 收银位占用由 day.js stepCheckout 统一处理（占用协议单点）
        m.timer = CONFIG.checkout.playerPayTime;
        break;
      case 'host':
        // host 无 tick 动作（被动倍率）
        m.timer = 9999;
        break;
      default:
        m.timer = 9999;
        break;
    }
  }
}

/** 仓管员：优先处理门口箱子，无箱则补货（1.5s/次）。 */
function stepStocker(gs, m) {
  const lg = CONFIG.logistics;
  const role = CONFIG.employees.roles.stocker;
  const box = gs.logistics.boxes.find((b) => b.state !== 'EMPTY' && b.claimedBy === null);
  if (box) {
    const kind = box.state === 'SEALED' ? 'unbox' : 'pick';
    if (claimBox(gs, box.id, m.id, kind)) {
      m.task = {
        kind: 'restock',          // 统一记 'restock'（箱链路），UI 按 boxState 派生动作
        needBoxKind: kind,        // 'unbox' | 'pick'
        targetId: box.id,
        elapsed: 0,
        duration: kind === 'unbox'
          ? durationFor(m, lg.unboxTime)
          : durationFor(m, lg.pickTime),
      };
      return;
    }
  }
  // 后仓 → 货架
  const skuId = pickStockerSku(gs);
  if (skuId !== null) {
    m.task = {
      kind: 'restock', targetId: null, skuId,
      elapsed: 0,
      duration: durationFor(m, lg.restockTime, role.restockTimeMult),
    };
  } else {
    m.timer = lg.truckEta; // 无事可做，稍后再看
  }
}

/** 仓管员补货目标：优先「后仓有货且货架最空的 SKU」（v3 全店格池，确定性）。 */
function pickStockerSku(gs) {
  let best = null;
  let bestScore = -1;
  for (const skuId of CONFIG.skuOrder) {
    const st = gs.skus[skuId];
    if (st.backroom <= 0) continue;
    const cap = stackCap(gs, skuId);
    let onShelfQty = 0;
    let freeSlots = 0;
    for (const i of slotsAll(gs)) {
      const s = gs.shelfSlots[i];
      onShelfQty += s.sku === skuId ? s.qty : 0;
      if (s.sku === null || (s.sku === skuId && s.qty < cap)) freeSlots += 1;
    }
    if (freeSlots === 0) continue;
    const score = st.backroom * 10 + freeSlots * 100 - onShelfQty;
    if (score > bestScore) {
      bestScore = score;
      best = skuId;
    }
  }
  return best;
}

/** 导购员：每 12s/eff 响应一个最紧急的 PENDING 气泡（成功率 80%，由 needs 回调结算）。 */
function stepGuide(gs, session, m, needsCallbacks) {
  if (!needsCallbacks || typeof needsCallbacks.pickNeed !== 'function') {
    m.timer = 9999;
    return;
  }
  const need = needsCallbacks.pickNeed(session);
  if (!need) {
    m.timer = CONFIG.employees.roles.guide.respondInterval;
    return;
  }
  const role = CONFIG.employees.roles.guide;
  // 响应动作耗时 ≈ interval / 3（12s 节奏内的服务时长），效率折算
  m.task = {
    kind: 'respond', targetId: need.id, needId: need.id,
    elapsed: 0,
    duration: durationFor(m, role.respondInterval / 3),
  };
}

/** 推进员工任务到完成（结算单点）。 */
function advanceTask(gs, session, m, dt) {
  const t = m.task;
  t.elapsed += dt;
  if (t.elapsed < t.duration) return;
  // 到期结算（只执行一次）
  if (t.kind === 'restock' && t.skuId) {
    restockToSlot(gs, t.skuId, CONFIG.logistics.restockPerAction);
  } else if (t.kind === 'restock' && t.targetId !== null) {
    // 箱链路（开箱 / 取货）
    const box = gs.logistics.boxes.find((b) => b.id === t.targetId)
      || findDeliveryBox(gs, t.targetId);
    if (box && box.claimedBy === m.id) {
      if (t.needBoxKind === 'unbox' && box.state === 'SEALED') {
        box.state = 'OPEN';
        box.progress = 0;
        box.claimedBy = null;
        box.claimedKind = null;
        gs.today.boxesOpened += 1;
      } else if (t.needBoxKind === 'pick' && box.state === 'OPEN') {
        pickTickBoxDirect(gs, box);
      }
    }
  }
  m.task = null;
  m.timer = 0; // 立即找下一个任务
}

/** 在 delivery.boxes 中找箱（未卸车的）。 */
function findDeliveryBox(gs, boxId) {
  for (const d of gs.logistics.deliveries) {
    for (const b of d.boxes) {
      if (b.id === boxId) return b;
    }
  }
  return null;
}

/**
 * 员工走位目标（2026-09 员工 AI 行为：与 sim 任务系统联动的走位点选择）。
 * 纯函数——director.js 每帧调用，把返回点交给避障移动。
 * @param {object} gs GameState
 * @param {object} session DaySession
 * @param {object} positions shopCtx.positions（交互点真值）
 * @param {object} m 员工（含 role / task）
 * @returns {{x: number, z: number}}
 */
export function staffTargetOf(gs, session, positions, m) {
  const p = positions;
  switch (m.role) {
    case 'cashier':
      return p.checkout;
    case 'stocker': {
      // 箱链路任务：走到目标箱旁（开箱/取货）
      if (m.task && m.task.kind === 'restock' && m.task.targetId !== null
        && m.task.targetId !== undefined) {
        const box = gs.logistics.boxes.find((b) => b.id === m.task.targetId)
          || findDeliveryBox(gs, m.task.targetId);
        if (box && typeof box.x === 'number') return { x: box.x, z: box.z };
      }
      // 后仓补货任务 / 空闲：守后仓门
      return p.staffDoor || p.checkout;
    }
    case 'guide': {
      // 导购：走向自己认领的需求顾客；否则在店中央待客点驻守
      if (m.task && m.task.kind === 'respond' && m.task.needId !== undefined) {
        const need = (session.needs || []).find((n) => n.id === m.task.needId);
        const c = need && session.customers.find((x) => x.id === need.customerId);
        if (c && c.pos) return { x: c.pos.x, z: c.pos.z };
      }
      return p.waitPoint;
    }
    case 'host':
      return (p.experienceSlots && p.experienceSlots[0]) || p.waitPoint;
    default:
      return p.waitPoint;
  }
}

/** 仓管员取货结算（不经过 claimedKind 判定的直达版本）。 */
function pickTickBoxDirect(gs, box) {
  const st = gs.skus[box.sku];
  st.inBox -= box.qty;
  st.backroom += box.qty;
  box.state = 'EMPTY';
  box.progress = 0;
  box.claimedBy = null;
  box.claimedKind = null;
  gs.logistics.boxes = gs.logistics.boxes.filter((b) => b.state !== 'EMPTY');
}
