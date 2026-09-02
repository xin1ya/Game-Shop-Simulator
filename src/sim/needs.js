/**
 * needs.js — 顾客需求气泡：扫描生成 / 优先级 / TTL / 冷却 / 响应结算 / 超时后果。
 *
 * 5 类气泡（PRD §3.2.2）：
 *   findItem ❓ 货架空+后仓有货 → 补 1 件；奖励 满意度+1 × 购买概率1.3；TTL 8s
 *   complain 😠 耐心<25%       → 安抚(成本5)；耐心回满至60%；TTL 5s
 *   checkout 💳 队列≥3 且队首等待>6s → 临时收银1.5s；满意度+1；TTL 6s
 *   explain  💬 体验位外排队>3s → 安抚/入座；耐心+8s；TTL 8s
 *   recommend⭐ 购买判定失败且预算足 → 换品类重掷；TTL 5s
 *
 * ★ 距离闸门：fp 限 interactRange（2.5）、iso 限 interactRangeIso（3.2，2026-09 试玩反馈后不再免距）。
 *   唯一真值 CONFIG.firstPerson.interactRange / interactRangeIso。
 * ★ 玩家全局 3s 冷却；同一顾客同类 6s 冷却；员工不受玩家冷却约束。
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/needs
 */

import { CONFIG } from '../config.js';
import { shelfState, restockToSlot, onShelfOf, onSaleSkusOfCat } from './logistics.js';

const NEED_KINDS = ['findItem', 'complain', 'checkout', 'explain', 'recommend'];

/** 气泡紧急度：complain(5) > checkout(4) > findItem(3) > explain(2) > recommend(1)。 */
export function needPriority(kind) {
  return CONFIG.needs.types[kind].priority;
}

/** 同屏可见气泡（PENDING + CLAIMED）≤ maxOnScreen(3)。 */
export function activeNeeds(session) {
  return session.needs.filter((n) => n.state === 'PENDING' || n.state === 'CLAIMED');
}

/** 取紧急度最高的 PENDING 气泡（导购员 / UI 高亮用）。 */
export function pickUrgent(session) {
  let best = null;
  for (const n of session.needs) {
    if (n.state !== 'PENDING') continue;
    if (!best || needPriority(n.kind) > needPriority(best.kind)) best = n;
  }
  return best;
}

/** 同屏超上限时，把低紧急度的挂起等待（needQueue，仍在 TTL 倒计时外等待）。 */
function promoteFromQueue(session) {
  while (activeNeeds(session).length < CONFIG.needs.maxOnScreen && session.needQueue.length > 0) {
    // 队内按紧急度降序取
    session.needQueue.sort((a, b) => needPriority(b.kind) - needPriority(a.kind));
    const next = session.needQueue.shift();
    next.state = 'PENDING';
    session.needs.push(next);
  }
}

/** 顾客同类冷却是否仍在生效。 */
function inRepeatCooldown(c, kind, nowClock) {
  const cd = c.needCooldown && c.needCooldown[kind];
  return typeof cd === 'number' && nowClock < cd;
}

/** 生成气泡对象（不进活跃列表）。 */
function makeNeed(session, customer, kind) {
  const def = CONFIG.needs.types[kind];
  return {
    id: session.nextNeedId,
    customerId: customer.id,
    kind,
    ttl: def.ttl,
    maxTtl: def.ttl,
    priority: def.priority,
    state: 'PENDING',
    claimedBy: null,
    createdAt: session.clock,
  };
}

/**
 * 触发条件逐类判定。
 * @returns {boolean} 是否应生成
 */
function shouldTrigger(gs, session, c, kind) {
  const t = CONFIG.needs.types[kind];
  switch (kind) {
    case 'findItem':
      // 货架空 + 后仓有货（该顾客目标品类）
      return c.target !== null && shelfState(gs, c.target) === 'IN_BACKROOM';
    case 'complain':
      // 耐心 < 25%（c.patience 为剩余秒；用初始耐心近似）
      return c.patience / Math.max(1, c.patienceMax || 40) < 0.25
        && !['LEAVING', 'LEAVING_ANGRY', 'GONE', 'PAYING', 'QUEUED'].includes(c.state);
    case 'checkout': {
      if (session.queue.length < t.trigger.queueLen) return false;
      const headId = session.queue[0];
      const head = session.customers.find((x) => x.id === headId);
      return Boolean(head) && head.queueWait > t.trigger.waitTime;
    }
    case 'explain':
      // 体验位外排队 > 3s
      return c.state === 'TO_EXPERIENCE'
        && (c.expWait || 0) > t.trigger.waitTime;
    case 'recommend':
      // 购买判定失败（BROWSING 结束未进 TO_CHECKOUT）且预算充足
      return c.state === 'BROWSING' && c.buyFailed === true && c.budget > 20;
    default:
      return false;
  }
}

/**
 * 0.5s 节流扫描：生成 / TTL 递减 / 超时后果 / 冷却递减 / 挂起晋升。
 * @param {object} session DaySession
 */
export function scanNeeds(gs, session, dt) {
  session.needScanTimer -= dt;
  // 冷却每 tick 递减（玩家全局）
  if (session.playerNeedCooldown > 0) {
    session.playerNeedCooldown = Math.max(0, session.playerNeedCooldown - dt);
  }
  // 顾客同类冷却随 clock 判定（存的是绝对 clock 时刻），无需递减

  // TTL 与超时（每 tick，不只扫描时刻）
  for (const n of session.needs) {
    if (n.state === 'RESOLVED' || n.state === 'EXPIRED') continue;
    if (n.state === 'CLAIMED') continue; // 处理中不超时
    n.ttl -= dt;
    if (n.ttl <= 0) {
      n.state = 'EXPIRED';
      applyTimeoutEffect(gs, session, n);
    }
  }
  session.needs = session.needs.filter((n) => n.state === 'PENDING' || n.state === 'CLAIMED');

  if (session.needScanTimer > 0) return;
  session.needScanTimer = CONFIG.needs.scanInterval;

  // 生成扫描
  for (const c of session.customers) {
    if (['LEAVING', 'LEAVING_ANGRY', 'GONE'].includes(c.state)) continue;
    // 已有活跃气泡的顾客不再叠加（一次一个）
    const hasActive = session.needs.some(
      (n) => n.customerId === c.id && (n.state === 'PENDING' || n.state === 'CLAIMED'),
    );
    if (hasActive) continue;
    for (const kind of NEED_KINDS) {
      if (inRepeatCooldown(c, kind, session.clock)) continue;
      if (!shouldTrigger(gs, session, c, kind)) continue;
      const need = makeNeed(session, c, kind);
      session.nextNeedId += 1;
      // 同屏上限：超了进等待队列
      if (activeNeeds(session).length < CONFIG.needs.maxOnScreen) {
        session.needs.push(need);
      } else {
        need.state = 'QUEUED';
        session.needQueue.push(need);
      }
      break; // 每顾客一次只生成一个
    }
  }
  promoteFromQueue(session);
}

/** 超时后果（PRD §3.2.2 最后一列）。 */
function applyTimeoutEffect(gs, session, need) {
  const c = session.customers.find((x) => x.id === need.customerId);
  if (!c) return;
  switch (need.kind) {
    case 'findItem':
    case 'recommend':
      // 转入原流失判定（不改即时状态，顾客 AI 自行处理）
      break;
    case 'complain':
      // 耐心继续耗尽流失（不改状态）
      break;
    case 'checkout':
      // 队首耐心继续倒计时（不改状态）
      break;
    case 'explain':
      // 耐心正常扣减（不改状态）
      break;
    default:
      break;
  }
  // 同类冷却起算（超时也算一次触发，防刷）
  setRepeatCooldown(c, need.kind, session.clock);
}

/** 写顾客同类冷却（绝对时刻）。 */
function setRepeatCooldown(c, kind, clock) {
  if (!c.needCooldown) c.needCooldown = {};
  c.needCooldown[kind] = clock + CONFIG.needs.repeatCooldown;
}

/**
 * 玩家可否响应：距离（fp 2.5 / iso 3.2）+ 全局 3s 冷却 + 目标可抢占。
 * @param {object} gs GameState
 * @param {object} session DaySession
 * @param {number} needId
 * @param {{x:number,z:number,viewMode:string}} playerCtx 视图模式与坐标
 * @returns {{ok: boolean, reason?: string}}
 */
export function canPlayerRespond(gs, session, needId, playerCtx) {
  const need = session.needs.find((n) => n.id === needId);
  if (!need || need.state !== 'PENDING') return { ok: false, reason: 'not_pending' };
  if (session.playerNeedCooldown > 0) return { ok: false, reason: 'cooldown' };
  if (playerCtx && (playerCtx.viewMode === 'fp' || playerCtx.viewMode === 'iso')) {
    const limit = playerCtx.viewMode === 'fp'
      ? CONFIG.firstPerson.interactRange
      : (CONFIG.firstPerson.interactRangeIso ?? CONFIG.firstPerson.interactRange);
    const c = session.customers.find((x) => x.id === need.customerId);
    if (c && c.pos) {
      const dist = Math.hypot(c.pos.x - playerCtx.x, c.pos.z - playerCtx.z);
      if (dist > limit) {
        return { ok: false, reason: 'distance' };
      }
    }
  }
  // 俯瞰同受距离约束（2026-09 试玩反馈：不再隔空响应）
  return { ok: true };
}

/**
 * 响应气泡（玩家或导购员）。完成后写满意度 / 耐心 / 库存效果。
 * @param {string|number} by 'player' 或 staffId
 * @param {object|null} playerCtx 玩家响应时的位姿（第一人称距离校验）
 * @returns {{ok: boolean, resolved: boolean, reason?: string}}
 */
export function respondNeed(gs, session, needId, by, playerCtx = null) {
  const need = session.needs.find((n) => n.id === needId);
  if (!need) return { ok: false, resolved: false, reason: 'not_found' };
  if (need.state === 'CLAIMED' && need.claimedBy !== by) {
    return { ok: false, resolved: false, reason: 'claimed' };
  }
  if (by === 'player' && playerCtx) {
    const check = canPlayerRespond(gs, session, needId, playerCtx);
    if (!check.ok) return { ok: false, resolved: false, reason: check.reason };
  }
  const c = session.customers.find((x) => x.id === need.customerId);
  const t = CONFIG.needs.types[need.kind];
  let resolved = true;

  if (c) {
    switch (need.kind) {
      case 'findItem': {
        // 从后仓补 1 件到货架（找到后仓有货的该品类 SKU）
        const cat = c.target || 'snacks';
        let restocked = false;
        for (const skuId of onSaleSkusOfCat(gs, cat)) {
          void skuId;
        }
        // 找后仓有货的同品类 SKU
        let targetSku = null;
        for (const skuId of CONFIG.skuOrder) {
          if (CONFIG.skus[skuId].cat === cat && gs.skus[skuId].backroom > 0) {
            targetSku = skuId;
            break;
          }
        }
        if (targetSku) {
          restocked = restockToSlot(gs, targetSku, 1) > 0;
        }
        c.satisfaction += t.satisfaction;
        gs.today.satisfactionSum += t.satisfaction;
        if (restocked) c.buyMult = t.buyMult; // 后续购买判定 ×1.3
        resolved = restocked;
        break;
      }
      case 'complain': {
        const cost = t.cost;
        if (gs.cash < cost) {
          resolved = false;
          break;
        }
        gs.cash -= cost;
        c.patience = Math.max(c.patience, c.patienceMax * t.patienceRefill);
        // 满意度 0（本可 -1）：不写
        break;
      }
      case 'checkout': {
        // 玩家亲自开临时收银：队首完成结账由 day.js stepCheckout 的 pay 交互处理；
        // 气泡响应本身给满意度 +1 并把队首标记为优先服务
        c.satisfaction += t.satisfaction;
        gs.today.satisfactionSum += t.satisfaction;
        session.queuePriority = need.customerId; // 队首插队标记（stepCheckout 消费）
        break;
      }
      case 'explain': {
        // 有空位立即入座；无空位安抚 +8s 耐心
        const freeIdx = session.expSlots.findIndex((s) => s === null);
        if (freeIdx !== -1 && c.state === 'TO_EXPERIENCE') {
          session.expSlots[freeIdx] = c.id;
          c.slotId = freeIdx;
          c.state = 'EXPERIENCING';
          c.expTried = true;
          c.timer = 15; // 由 customers.js 正常路径覆盖精确时长
        } else {
          c.patience += t.patienceBonus;
        }
        break;
      }
      case 'recommend': {
        // 换品类重掷：直接给一次重掷机会（顾客 AI 在下一步消费 reroll 标记）
        c.rerollRecommend = true;
        break;
      }
      default:
        resolved = false;
    }
  }

  if (resolved) {
    need.state = 'RESOLVED';
    need.claimedBy = null;
    setRepeatCooldown(c, need.kind, session.clock);
    gs.today.needsResolved += 1;
    if (by === 'player') {
      session.playerNeedCooldown = CONFIG.needs.playerCooldown;
    }
  }
  session.needs = session.needs.filter((n) => n.state === 'PENDING' || n.state === 'CLAIMED');
  return { ok: true, resolved };
}

/** 气泡展示派生（UI 用）：emoji + SKU 名 + 售价。 */
export function needDisplay(gs, session, need) {
  const def = CONFIG.needs.types[need.kind];
  const c = session.customers.find((x) => x.id === need.customerId);
  let skuInfo = '';
  if (c && c.targetSku && CONFIG.skus[c.targetSku]) {
    const s = CONFIG.skus[c.targetSku];
    skuInfo = `${s.emoji}${s.name} 💰${gs.skuPrices[c.targetSku]}`;
  } else if (c && c.target) {
    skuInfo = CONFIG.products[c.target].emoji;
  }
  return {
    id: need.id,
    emoji: def.emoji,
    label: def.label,
    kind: need.kind,
    priority: need.priority,
    ttl: need.ttl,
    maxTtl: need.maxTtl,
    customerId: need.customerId,
    sku: skuInfo,
    urgent: needPriority(need.kind) >= 4,
  };
}

/** 顾客离店时清理其气泡。 */
export function cleanupCustomerNeeds(session, customerId) {
  session.needs = session.needs.filter(
    (n) => !(n.customerId === customerId && n.state !== 'CLAIMED'),
  );
  session.needQueue = session.needQueue.filter((n) => n.customerId !== customerId);
}
