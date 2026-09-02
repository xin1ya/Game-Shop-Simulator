/**
 * interaction.js — 玩家交互调度器（Mediator）：目标解算 + 按住 F 进度机 + 完成派发。
 *
 * 五类交互（InteractKind）：
 *   unbox（开箱 1.5s）/ pick（取货 0.6s）/ restock（上架 4.0s）
 *   pay（结账 2.0s/位，收银员在岗走 staff 通道）
 *   respond（响应气泡 1.5s，needs 结算）
 *
 * ★ 玩家单一交互槽 session.interaction（物理上一双手，天然互斥）。
 * ★ 2.5 距离闸门：第一人称生效（+ 朝向锥）；等距模式不生效（裁决 4 / 8）。
 * ★ 中断保留：进度存于目标对象（box.progress / slot），松手/走开不清零。
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/interaction
 */

import { CONFIG } from '../config.js';
import { shelfAnchorOf } from './layout.js';
import {
  findBox, claimBox, releaseBox, unboxTick, pickTick,
  skuHasRoom, placeFromHands,
  stashToBackroom, flattenBox, trashEmptyBoxes, recycleCardboard,
  pickCarryBox, placeCarriedBox,
} from './logistics.js';
import { canPlayerRespond } from './needs.js';

/**
 * 按键分班（2026-09 玩家反馈）：
 *   左键 lmb = 放置/操作/服务（开箱、上架、入库、丢弃、回收、结账、回应、放箱、开关门）
 *   右键 rmb = 拾起（取货、折叠、库房取货、抱起整箱）
 */
export const BTN_CLASS = {
  unbox: 'lmb', restock: 'lmb', stash: 'lmb', trash: 'lmb', recycle: 'lmb',
  pay: 'lmb', respond: 'lmb', placeBox: 'lmb', doorToggle: 'lmb',
  pick: 'rmb', flatten: 'rmb', takeout: 'rmb', carryBox: 'rmb',
};

/** 2D 距离。 */
export function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 朝向得分：dot(aimDir, toTarget 归一化)；无朝向信息返回 1（视为命中）。 */
export function aimScore(aimDir, from, to) {
  if (!aimDir) return 1;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return 1;
  return (aimDir.x * dx + aimDir.z * dz) / len;
}

/** 目标点解算（货架 → 交互锚点）。v3：按货架序号（0~3）取锚点；
 * 2026-09 布局模式：优先 layoutOf 动态位（customLayout 覆盖），回退 CONFIG 默认。 */
function shelfAnchor(gs, shelfIdx) {
  const dyn = shelfAnchorOf(gs, shelfIdx);
  return dyn || CONFIG.layout.shelfAnchors[shelfIdx] || CONFIG.layout.browseCenter;
}

/** 箱子锚点（v3：物理坐标优先；无坐标字段回退槽位表）。 */
function boxAnchor(box) {
  if (typeof box.x === 'number' && typeof box.z === 'number') return { x: box.x, z: box.z };
  return CONFIG.street.doorBoxSlots[box.slot % CONFIG.street.doorBoxSlots.length];
}

/**
 * 目标解算：从玩家位姿找出当前可交互对象（距离最近优先）。
 * v3（2026-09）：btn 参数按「左键放置/操作、右键拾起」过滤（BTN_CLASS）；
 * btn=null 时不过滤（测试兼容）。
 * @param {object} gs GameState
 * @param {object} session DaySession
 * @param {{x:number,z:number,yaw?:number,viewMode:string,aimDir?:{x,z}}} ctx
 * @param {'lmb'|'rmb'|null} [btn]
 * @returns {{kind:string,targetId:number,label:string,distance:number,inRange:boolean}|null}
 */
export function resolveTarget(gs, session, ctx, btn = null) {
  const range = CONFIG.firstPerson.interactRange;
  const rangeIso = CONFIG.firstPerson.interactRangeIso ?? range; // 俯瞰也限距（2026-09 试玩反馈）
  const isFp = ctx.viewMode === 'fp';
  const candidates = [];
  const carry = session.carry || null;
  const handsFree = !carry;

  // ① 箱子（SEALED：左键开箱 / 右键抱起整箱；OPEN：右键取货；EMPTY：右键折叠）
  for (const box of gs.logistics.boxes) {
    const anchor = boxAnchor(box);
    const dist = distance2D(ctx, anchor);
    const inRange = dist <= (isFp ? range : rangeIso);
    if (box.state === 'SEALED') {
      candidates.push({ kind: 'unbox', targetId: box.id, label: CONFIG.interaction.labels.unbox, distance: dist, inRange, anchor });
      if (handsFree) candidates.push({ kind: 'carryBox', targetId: box.id, label: CONFIG.interaction.labels.carryBox, distance: dist, inRange, anchor });
    } else if (box.state === 'OPEN') {
      if (handsFree) candidates.push({ kind: 'pick', targetId: box.id, label: CONFIG.interaction.labels.pick, distance: dist, inRange, anchor });
    } else if (box.state === 'EMPTY') {
      // 空手，或手上纸壳未满（≤10 张可继续叠）时可折叠
      const canFlatten = handsFree
        || (carry.type === 'cardboard' && carry.n < (CONFIG.stockroom.cardboardCarryCap ?? 10));
      if (canFlatten) candidates.push({ kind: 'flatten', targetId: box.id, label: CONFIG.interaction.labels.flatten, distance: dist, inRange, anchor });
    }
  }

  // ② 货架（左键上架：手上为商品且该架有格可放 → restock；targetId = 货架序号）
  const carrySku = carry && carry.type === 'item' && carry.qty > 0 ? carry.skuId : null;
  if (carrySku) {
    for (let i = 0; i < CONFIG.layout.shelfAnchors.length; i += 1) {
      if (!skuHasRoom(gs, carrySku, i)) continue;
      const anchor = shelfAnchor(gs, i);
      const dist = distance2D(ctx, anchor);
      candidates.push({
        kind: 'restock', targetId: i,
        label: CONFIG.interaction.labels.restock,
        distance: dist, inRange: dist <= (isFp ? range : rangeIso),
        anchor,
      });
    }
  }

  // ③ 收银台（队列非空 → pay，左键开找零面板）
  if (session.queue && session.queue.length > 0) {
    const anchor = CONFIG.layout.checkout;
    const dist = distance2D(ctx, anchor);
    candidates.push({
      kind: 'pay', targetId: 0, label: CONFIG.interaction.labels.pay,
      distance: dist, inRange: dist <= (isFp ? range : rangeIso),
      anchor,
    });
  }

  // ④ 需求气泡（PENDING → respond）
  for (const need of session.needs || []) {
    if (need.state !== 'PENDING') continue;
    const c = session.customers.find((x) => x.id === need.customerId);
    const anchor = c && c.pos ? c.pos : CONFIG.layout.browseCenter;
    const dist = distance2D(ctx, anchor);
    const check = canPlayerRespond(gs, session, need.id, { ...ctx, x: ctx.x, z: ctx.z });
    if (!check.ok && check.reason === 'cooldown') continue;
    candidates.push({
      kind: 'respond', targetId: need.id,
      label: CONFIG.interaction.labels.respond,
      distance: dist, inRange: dist <= (isFp ? range : rangeIso),
      anchor,
    });
  }

  // ⑤ 抱箱原地放下（2026-09 反馈：店内任何位置，不再局限库房锚点）
  if (carry && carry.type === 'box') {
    // 锚点放准星前方 0.8（fp 朝向锥过滤用；实际落点 = 玩家脚下，见 beginHold）
    const ax = ctx.x + (ctx.aimDir ? ctx.aimDir.x * 0.8 : 0);
    const az = ctx.z + (ctx.aimDir ? ctx.aimDir.z * 0.8 : 0);
    candidates.push({
      kind: 'placeBox', targetId: 0, label: CONFIG.interaction.labels.placeBox,
      distance: 0, inRange: true, anchor: { x: ax, z: az },
    });
  }

  // ⑥ 库房：入库（手上=商品/纸板）/ 取货（空手且后仓有货）
  {
    const anchor = CONFIG.layout.stockroom;
    const dist = distance2D(ctx, anchor);
    const inRange = dist <= (isFp ? range : rangeIso);
    const anyBackroom = CONFIG.skuOrder.some((id) => gs.skus[id].backroom > 0);
    if (carry && (carry.type === 'item' || carry.type === 'cardboard')) {
      candidates.push({ kind: 'stash', targetId: 0, label: CONFIG.interaction.labels.stash, distance: dist, inRange, anchor });
    } else if (handsFree && anyBackroom) {
      candidates.push({ kind: 'takeout', targetId: 0, label: CONFIG.interaction.labels.takeout, distance: dist, inRange, anchor });
    }
  }

  // ⑥ 垃圾桶（左键丢弃全部空箱）
  {
    const hasEmpty = gs.logistics.boxes.some((b) => b.state === 'EMPTY');
    const anchor = CONFIG.layout.trashBin;
    if (hasEmpty && anchor) {
      const dist = distance2D(ctx, anchor);
      candidates.push({
        kind: 'trash', targetId: 0, label: CONFIG.interaction.labels.trash,
        distance: dist, inRange: dist <= (isFp ? range : rangeIso), anchor,
      });
    }
  }

  // ⑦ 废品回收商人（账单日）：有纸板时可售卖
  if (session.recycler && gs.stockroom && gs.stockroom.cardboard > 0) {
    const anchor = CONFIG.layout.recyclerPoint;
    const dist = distance2D(ctx, anchor);
    candidates.push({
      kind: 'recycle', targetId: 0, label: CONFIG.interaction.labels.recycle,
      distance: dist, inRange: dist <= (isFp ? range : rangeIso),
      anchor,
    });
  }

  // ⑧ 员工通道门（左键手动开关；需求：不要自动开）
  {
    const anchor = CONFIG.layout.staffDoor;
    if (anchor) {
      const dist = distance2D(ctx, anchor);
      candidates.push({
        kind: 'doorToggle', targetId: 0,
        label: gs.staffDoorOpen ? CONFIG.interaction.labels.doorClose : CONFIG.interaction.labels.doorOpen,
        distance: dist, inRange: dist <= (isFp ? range : rangeIso), anchor,
      });
    }
  }

  // 按键分班过滤 + 第一人称距离/朝向锥过滤
  let filtered = btn ? candidates.filter((c) => BTN_CLASS[c.kind] === btn) : candidates;
  filtered = filtered.filter((c) => c.inRange);
  if (isFp && ctx.aimDir) {
    filtered = filtered.filter(
      (c) => aimScore(ctx.aimDir, ctx, c.anchor) >= CONFIG.interaction.aimConeCos,
    );
  }
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a.distance - b.distance);
  const best = filtered[0];
  return {
    kind: best.kind, targetId: best.targetId, label: best.label,
    distance: best.distance, inRange: true,
  };
}


/** 交互耗时（秒）。 */
export function holdDuration(gs, kind) {
  const lg = CONFIG.logistics;
  const ck = CONFIG.checkout;
  const it = CONFIG.interaction;
  switch (kind) {
    case 'unbox': return lg.unboxTime;
    case 'pick': return lg.pickTime;
    case 'restock': return lg.restockTime;
    case 'pay': return ck.playerPayTime;
    case 'respond': return CONFIG.needs.types.checkout.playerPayTime; // 1.5s 响应
    case 'stash': return it.stashTime;
    case 'flatten': return it.flattenTime;
    case 'trash': return it.trashTime;
    case 'recycle': return it.recycleTime;
    default: return lg.unboxTime;
  }
}

/**
 * 开始按住：校验占用 + 距离 → 占位（原子）。
 * 失败时零状态变化（共享约定 10）。
 * @returns {boolean}
 */
export function beginHold(gs, session, kind, targetId, ctx = null) {
  if (session.interaction) return false;
  // 距离校验：fp 用 2.5，iso（俯瞰店长）用 3.2——不再免距离隔空操作
  if (ctx && (ctx.viewMode === 'fp' || ctx.viewMode === 'iso')) {
    const limit = ctx.viewMode === 'fp'
      ? CONFIG.firstPerson.interactRange
      : (CONFIG.firstPerson.interactRangeIso ?? CONFIG.firstPerson.interactRange);
    const target = anchorOf(gs, session, kind, targetId);
    if (target && distance2D(ctx, target) > limit) {
      return false;
    }
  }
  // 占用校验
  if (kind === 'unbox' || kind === 'pick') {
    if (kind === 'pick' && session.carry) return false; // 手上有货不能再取
    if (!claimBox(gs, targetId, 'player', kind)) return false;
  } else if (kind === 'respond') {
    const need = (session.needs || []).find((n) => n.id === targetId);
    if (!need || need.state !== 'PENDING') return false;
    const check = canPlayerRespond(gs, session, targetId, ctx);
    if (!check.ok) return false;
    need.state = 'CLAIMED';
    need.claimedBy = 'player';
  } else if (kind === 'pay') {
    if (!session.queue || session.queue.length === 0) return false;
    // v3：手动结账只保留找零小游戏（instantHold 下无计时通道）
    if (CONFIG.interaction.instantHold) return false;
  } else if (kind === 'restock') {
    if (!Number.isInteger(targetId) || targetId < 0 || targetId >= CONFIG.layout.shelfAnchors.length) {
      return false;
    }
    if (!session.carry || session.carry.qty <= 0) return false; // v3：空手不能上架
  } else if (kind === 'stash') {
    if (!session.carry || (session.carry.type !== 'item' && session.carry.type !== 'cardboard')) return false;
  } else if (kind === 'flatten') {
    const box = findBox(gs, targetId);
    if (!box || box.state !== 'EMPTY') return false;
    // 折叠需空手，或手上纸壳未满（一次最多拿 10 张）
    if (session.carry
      && (session.carry.type !== 'cardboard'
        || session.carry.n >= (CONFIG.stockroom.cardboardCarryCap ?? 10))) return false;
  } else if (kind === 'trash') {
    if (!gs.logistics.boxes.some((b) => b.state === 'EMPTY')) return false;
  } else if (kind === 'recycle') {
    if (!session.recycler || !gs.stockroom || gs.stockroom.cardboard <= 0) return false;
  } else if (kind === 'carryBox') {
    if (session.carry) return false;
    const box = findBox(gs, targetId);
    if (!box || box.state !== 'SEALED') return false;
  } else if (kind === 'placeBox') {
    if (!session.carry || session.carry.type !== 'box') return false;
  } else if (kind === 'doorToggle') {
    // 随时可开关
  }
  // ★ 即时交互（instantHold）：校验通过即完成，不占交互槽、无进度条
  if (CONFIG.interaction.instantHold) {
    if (kind === 'unbox') {
      const box = findBox(gs, targetId);
      if (box) unboxTick(gs, box, CONFIG.logistics.unboxTime); // 一次到位（结算+释放）
    } else if (kind === 'pick') {
      const box = findBox(gs, targetId);
      if (box) pickTick(gs, box, CONFIG.logistics.pickTime, session); // 玩家通道入双手
    } else if (kind === 'carryBox') {
      return pickCarryBox(gs, session, targetId); // 整箱入双手（摘下世界箱）
    } else if (kind === 'placeBox') {
      return placeCarriedBox(gs, session, ctx ? ctx.x : 0, ctx ? ctx.z : 0); // 放到库房地面
    }
    // 派发类（restock/respond/stash/flatten/trash/recycle/doorToggle）：置槽 → finishHold 派发并清槽
    session.interaction = { kind, targetId, elapsed: 0, duration: 0, interrupted: false };
    finishHold(gs, session); // unbox/pick 已在 tick 内结算，此处空转；其余按 kind 派发
    return true;
  }
  session.interaction = {
    kind, targetId,
    elapsed: 0,
    duration: holdDuration(gs, kind),
    interrupted: false,
  };
  return true;
}

/** 目标锚点。 */
function anchorOf(gs, session, kind, targetId) {
  if (kind === 'unbox' || kind === 'pick') {
    const box = findBox(gs, targetId);
    return box ? boxAnchor(box) : null;
  }
  if (kind === 'restock') {
    return shelfAnchor(gs, targetId); // targetId = 货架序号
  }
  if (kind === 'pay') return CONFIG.layout.checkout;
  if (kind === 'respond') {
    const need = (session.needs || []).find((n) => n.id === targetId);
    const c = need && session.customers.find((x) => x.id === need.customerId);
    return c && c.pos ? c.pos : null;
  }
  // v3 库房 / 空箱 / 回收
  if (kind === 'stash' || kind === 'takeout') return CONFIG.layout.stockroom;
  if (kind === 'flatten' || kind === 'carryBox') {
    const box = findBox(gs, targetId);
    return box ? boxAnchor(box) : null;
  }
  if (kind === 'placeBox') return null; // 原地放下：无锚点、免距离校验
  if (kind === 'doorToggle') return CONFIG.layout.staffDoor || CONFIG.layout.stockroom;
  if (kind === 'trash') return CONFIG.layout.trashBin;
  if (kind === 'recycle') return CONFIG.layout.recyclerPoint;
  return null;
}

/**
 * 每帧推进（stepSession ④）：按住 → progress 累加；松手/走开 → 中断（保留进度）。
 * @param {boolean} holding 玩家是否仍按住 F
 * @param {object|null} ctx 每帧位姿（走开检测）
 */
export function stepHold(gs, session, dt, holding, ctx = null) {
  const it = session.interaction;
  if (!it) return;
  // 中断条件：松手 / 第一人称下走开
  let interrupted = !holding;
  if (!interrupted && ctx && ctx.viewMode === 'fp') {
    const anchor = anchorOf(gs, session, it.kind, it.targetId);
    if (anchor && distance2D(ctx, anchor) > CONFIG.firstPerson.interactRange) {
      interrupted = true;
    }
  }
  if (interrupted) {
    it.interrupted = true;
    cancelHold(gs, session, true); // 保留进度
    return;
  }
  it.elapsed += dt;
  // 目标对象上的进度同步（中断保留载体）
  if (it.kind === 'unbox' || it.kind === 'pick') {
    const box = findBox(gs, it.targetId);
    if (!box || box.state === 'EMPTY') { cancelHold(gs, session, true); return; }
    const done = it.kind === 'unbox'
      ? unboxTick(gs, box, dt)
      : pickTick(gs, box, dt, session); // v3：玩家取货入双手
    if (done) finishHold(gs, session);
    return;
  }
  if (it.elapsed >= it.duration) {
    finishHold(gs, session);
  }
}

/** 完成：派发到领域模块（结算单点）。 */
function finishHold(gs, session) {
  const it = session.interaction;
  if (!it) return;
  switch (it.kind) {
    case 'unbox':
    case 'pick': {
      // unboxTick/pickTick 内已结算并释放占用
      break;
    }
    case 'restock': {
      // v3 手持上架：targetId = 货架序号；手上货物落格（放满即停，剩余留手上）
      const carry = session.carry;
      if (carry && carry.type === 'item' && carry.qty > 0) {
        const put = placeFromHands(gs, carry.skuId, carry.qty, it.targetId);
        carry.qty -= put;
        if (carry.qty <= 0) session.carry = null;
      }
      break;
    }
    case 'pay': {
      // 队首结账由 day.js stepCheckout 消费 playerHoldDone 标记；
      // 这里只做 2.0s 计时，入账在 checkout 侧（防重复结算单点）
      session.playerPayDone = (session.playerPayDone || 0) + 1;
      break;
    }
    case 'respond': {
      // needs.respondNeed 完成结算（由 day.js 注入调用避免循环依赖）
      session.playerRespondDone = it.targetId;
      break;
    }
    // ---- v3 库房 / 空箱 / 回收 ----
    case 'stash':
      stashToBackroom(gs, session);
      break;
    case 'flatten':
      flattenBox(gs, it.targetId, session); // 纸壳入双手（自己抱进库房）
      break;
    case 'trash':
      trashEmptyBoxes(gs);
      break;
    case 'recycle': {
      const income = recycleCardboard(gs);
      if (income > 0) {
        gs.storyQueue.push(CONFIG.strings.recycleDone.replace('{income}', String(income)));
      }
      break;
    }
    case 'doorToggle':
      gs.staffDoorOpen = !gs.staffDoorOpen; // 手动开关库房门（含碰撞，main.js 重建障碍）
      break;
    default:
      break;
  }
  session.interaction = null;
}

/**
 * 中断/取消（保留进度）。
 * @param {boolean} keepProgress true 保留目标对象上的 progress
 */
export function cancelHold(gs, session, keepProgress = true) {
  const it = session.interaction;
  if (!it) return;
  if (!keepProgress) {
    if (it.kind === 'unbox' || it.kind === 'pick') {
      const box = findBox(gs, it.targetId);
      if (box) box.progress = 0;
    }
  }
  if (it.kind === 'unbox' || it.kind === 'pick') {
    releaseBox(gs, it.targetId);
  } else if (it.kind === 'respond') {
    const need = (session.needs || []).find((n) => n.id === it.targetId);
    if (need && need.state === 'CLAIMED' && need.claimedBy === 'player') {
      need.state = 'PENDING';
      need.claimedBy = null;
    }
  }
  session.interaction = null;
}

/** HUD 环形进度条数据源。 */
export function holdProgress(session) {
  const it = session.interaction;
  if (!it) return { active: false, kind: null, label: null, ratio: 0 };
  const ratio = it.kind === 'unbox' || it.kind === 'pick'
    ? boxRatio(session, it)
    : Math.min(1, it.elapsed / it.duration);
  return {
    active: true,
    kind: it.kind,
    label: CONFIG.interaction.labels[it.kind],
    ratio,
    interrupted: it.interrupted,
  };
}

/** 箱类进度以 box.progress 为真值（中断保留）。 */
function boxRatio(session, it) {
  // it.targetId 是 boxId；progress 存于 box
  // 此处通过 gs 查询不便（参数限制），用 session 缓存
  const cache = session.interactionBoxProgress;
  if (cache && cache.boxId === it.targetId) return Math.min(1, cache.progress / it.duration);
  return Math.min(1, it.elapsed / it.duration);
}
