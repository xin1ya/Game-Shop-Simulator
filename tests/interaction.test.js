/**
 * interaction.test.js — 玩家交互调度器测试（Mediator）。
 *
 * 覆盖（裁决 4/8，P0 不可裁剪项）：
 *  - ★ 2.5 距离闸门：第一人称生效（2.4u 可响应 / 2.6u 拒绝）、等距模式不生效
 *  - 按住 F 五类交互的进度/中断保留/完成派发
 *  - 单一交互槽（物理上一双手，天然互斥）
 *  - 占用协议：玩家占用后员工跳过
 *
 * 运行：node --test tests/interaction.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import { restock } from '../src/sim/economy.js';
import {
  startDeliveries, stepDeliveries, grantStock, stockInvariantOk,
} from '../src/sim/logistics.js';
import {
  resolveTarget, beginHold, stepHold, cancelHold, holdProgress,
} from '../src/sim/interaction.js';
import { buildObstacles } from '../src/scene/firstPerson.js';
import { startPrepSession } from '../src/sim/day.js';

const RANGE = CONFIG.firstPerson.interactRange; // 唯一真值 2.5
const FP = CONFIG.firstPerson;

function setup() {
  const gs = newGame(42);
  const rng = createRng(42);
  return { gs, rng };
}

/** 造一个门口有箱子的场景。 */
function setupWithBox() {
  const { gs, rng } = setup();
  restock(gs, { dice_keychain: 4 });
  gs.day += 1; // v3 次日达：推进到次日
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const session = startPrepSession(gs, rng);
  return { gs, rng, session, box: gs.logistics.boxes[0] };
}

// ---------- ★ 2.5 距离闸门（不可裁剪项，第一人称生效/等距不生效）----------

test('距离闸门：第一人称 2.4u 内可交互 / 2.6u 拒绝', () => {
  const { gs, session, box } = setupWithBox();
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  // 恰好距离边界：把玩家放在锚点 ±2.4 / ±2.6
  const near = { x: anchor.x - 2.4, z: anchor.z, viewMode: 'fp', yaw: 0 };
  const far = { x: anchor.x - 2.6, z: anchor.z, viewMode: 'fp', yaw: 0 };
  const tNear = resolveTarget(gs, session, near);
  const tFar = resolveTarget(gs, session, far);
  // 近处应能解出目标（箱子），远处同目标应超距
  if (tNear) assert.ok(tNear.distance <= RANGE + 1e-9);
  if (tFar && tFar.targetId === box.id) {
    assert.ok(false, 'fp 模式下 2.6u 外的箱子不应被解出');
  }
  // 直接 beginHold 校验距离闸门
  assert.equal(beginHold(gs, session, 'unbox', box.id, near), true, 'fp 2.4u 内可开始交互');
  cancelHold(gs, session);
  assert.equal(beginHold(gs, session, 'unbox', box.id, far), false, 'fp 2.6u 外拒绝交互');
});

test('距离闸门：等距俯瞰限 3.2u（2026-09 试玩反馈：不再隔空交互）', () => {
  const { gs, session, box } = setupWithBox();
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  // 先验超距：拒绝且零状态变化（箱子保持 SEALED）
  const isoFar = { x: anchor.x - 3.4, z: anchor.z, viewMode: 'iso', yaw: 0 };
  assert.equal(beginHold(gs, session, 'unbox', box.id, isoFar), false,
    'iso 3.4u 外拒绝交互');
  assert.equal(box.state, 'SEALED', '拒绝时零状态变化');
  // 再验近距：3.0u 内可交互
  const isoNear = { x: anchor.x - 3.0, z: anchor.z, viewMode: 'iso', yaw: 0 };
  assert.equal(beginHold(gs, session, 'unbox', box.id, isoNear), true,
    'iso 3.0u 内可交互');
  assert.equal(box.state, 'OPEN');
});

test('距离闸门：第一人称超距拒绝，即时完成无中断态（v3）', () => {
  const { gs, session, box } = setupWithBox();
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  const near = { x: anchor.x - 1.0, z: anchor.z, viewMode: 'fp', yaw: 0 };
  assert.equal(beginHold(gs, session, 'unbox', box.id, near), true);
  assert.equal(box.state, 'OPEN', '★即时交互：近处按下即完成');
  assert.equal(session.interaction, null, '无进度态可中断');
});

// ---------- 即时交互（v3 instantHold：取消按住进度条） ----------

test('开箱：F 按下即时完成（SEALED → OPEN，无进度条）', () => {
  const { gs, session, box } = setupWithBox();
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  const ctx = { x: anchor.x - 1.0, z: anchor.z, viewMode: 'fp', yaw: 0 };
  assert.equal(beginHold(gs, session, 'unbox', box.id, ctx), true);
  assert.equal(box.state, 'OPEN', '★即时交互：按下即开盖，无需按住');
  assert.equal(session.interaction, null, '不占交互槽');
});

test('即时交互幂等：重复 begin 已开箱目标被拒绝', () => {
  const { gs, session, box } = setupWithBox();
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  const ctx = { x: anchor.x - 1.0, z: anchor.z, viewMode: 'fp', yaw: 0 };
  assert.equal(beginHold(gs, session, 'unbox', box.id, ctx), true);
  assert.equal(box.state, 'OPEN');
  assert.equal(beginHold(gs, session, 'unbox', box.id, ctx), false, '已开盖箱不可再开');
});

test('手动结账无计时通道：beginHold(pay) 恒拒（仅找零小游戏）', () => {
  const { gs } = setup();
  const session = { interaction: null, queue: [1], needs: [], carry: null };
  const ctx = { x: 0, z: 0, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'pay', 0, ctx), false, 'pay 只能走找零面板');
});

test('restock：手持货物时按住 F 4.0s 上架到目标货架（v3 自由放置 + 手持）', () => {
  const { gs } = setup();
  const session = { interaction: null, queue: [], needs: [], carry: { type: 'item', skuId: 'boba_tea', qty: 4 } };
  const shelfIdx = 2;
  const before = gs.skus.boba_tea.onShelf;
  const ctx = { x: 0, z: 0, viewMode: 'iso' }; // 货架 2 在 iso 限距 3.2 内（dist≈2.7）
  assert.equal(beginHold(gs, session, 'restock', shelfIdx, ctx), true);
  for (let i = 0; i < 41; i += 1) stepHold(gs, session, 0.1, true, ctx);
  assert.ok(gs.skus.boba_tea.onShelf > before, 'restock 完成后货架库存增加');
  assert.equal(gs.shelfSlots[18].sku, 'boba_tea', '落在目标货架（货架 2 首格）');
  assert.equal(session.carry, null, '手上货物已全部上架');
});

test('restock：空手不能上架（v3 手持约束）', () => {
  const { gs } = setup();
  const session = { interaction: null, queue: [], needs: [], carry: null };
  const ctx = { x: 0, z: 0, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'restock', 0, ctx), false, '空手 beginHold 拒绝');
});

test('restock：目标货架满格时不外溢（剩余留手上）', () => {
  const { gs } = setup();
  const session = { interaction: null, queue: [], needs: [], carry: { type: 'item', skuId: 'boba_tea', qty: 4 } };
  for (const id of CONFIG.skuOrder) gs.skus[id].backroom = 0;
  // 货架 0 全部 9 格塞满 cat_cafe（slotCap 4 × 9 = 36）
  grantStock(gs, 'cat_cafe', 'onShelf', 36);
  const before = gs.skus.boba_tea.onShelf;
  const ctx = { x: -3.5, z: -2.2, viewMode: 'iso' }; // 货架 0 旁（iso 限距 3.2 内）
  assert.equal(beginHold(gs, session, 'restock', 0, ctx), true);
  for (let i = 0; i < 41; i += 1) stepHold(gs, session, 0.1, true, ctx);
  assert.equal(gs.skus.boba_tea.onShelf, before, '货架 0 满 → 不上架不外溢');
  assert.equal(session.carry.qty, 4, '货还在手上');
});

test('v3 手持链路：开箱 → 取货入双手（不入后仓）→ 上架 → 空手', () => {
  const { gs, session, box } = setupWithBox();
  session.carry = null;
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  const ctx = { x: anchor.x - 1.0, z: anchor.z, viewMode: 'fp', yaw: 0 };
  const before = totalStockOf(gs);
  // 开箱 1.5s
  beginHold(gs, session, 'unbox', box.id, ctx);
  for (let i = 0; i < 16; i += 1) stepHold(gs, session, 0.1, true, ctx);
  assert.equal(box.state, 'OPEN');
  // 取货 0.6s → 入双手
  beginHold(gs, session, 'pick', box.id, ctx);
  for (let i = 0; i < 7; i += 1) stepHold(gs, session, 0.1, true, ctx);
  assert.ok(session.carry && session.carry.qty === 4, '取货后手上应有 4 件');
  assert.equal(gs.skus.dice_keychain.backroom, 3, '★入双手不入后仓（初始 3 件不变）');
  // 手上占着不能再取别的箱
  assert.equal(beginHold(gs, session, 'pick', box.id, ctx), false, '手上有货不能再取');
  // 上架到货架 0（iso 限距：店长须走到货架旁）
  const isoCtx = { x: -3.5, z: -2.2, viewMode: 'iso' };
  beginHold(gs, session, 'restock', 0, isoCtx);
  for (let i = 0; i < 41; i += 1) stepHold(gs, session, 0.1, true, isoCtx);
  assert.equal(session.carry, null, '上架后空手');
  assert.equal(gs.skus.dice_keychain.onShelf, 4, '4 件全部上架');
  assert.equal(totalStockOf(gs), before, '全链路库存守恒');
});

/** 全店四态合计（守恒断言用）。 */
function totalStockOf(gs) {
  return CONFIG.skuOrder.reduce((n, id) => {
    const st = gs.skus[id];
    return n + st.inTransit + st.inBox + st.backroom + st.onShelf;
  }, 0);
}

test('holdProgress：HUD 环形进度条数据源（v3 即时交互：完成后恒 inactive）', () => {
  const { gs, session, box } = setupWithBox();
  assert.equal(holdProgress(session).active, false);
  const anchor = { x: box.x, z: box.z }; // 2026-09 dropZone：锚点用箱物理坐标
  const ctx = { x: anchor.x - 1.0, z: anchor.z, viewMode: 'fp', yaw: 0 };
  beginHold(gs, session, 'unbox', box.id, ctx);
  const prog = holdProgress(session);
  assert.equal(prog.active, false, '即时交互无进度条（instantHold）');
  assert.equal(box.state, 'OPEN');
});

// ---------- 2026-09 交互重构：抱箱/放箱/纸板手持/手动门 ----------

test('抱整箱进库房：右键抱起 SEALED 箱 → 手上 → 左键库房放下 → 开箱取货', () => {  const { gs, session, box } = setupWithBox();
  session.carry = null;
  const boxCtx = { x: box.x - 1.0, z: box.z, viewMode: 'iso' }; // 走到门口箱旁（iso 限距 3.2）
  const stockCtx = { x: -8.6, z: -1, viewMode: 'iso' };          // 走到库房
  // 抱起整箱（空手 + SEALED）
  assert.equal(beginHold(gs, session, 'carryBox', box.id, boxCtx), true);
  assert.ok(session.carry && session.carry.type === 'box', '整箱入双手');
  assert.equal(gs.logistics.boxes.length, 0, '箱子从世界摘下');
  // 放下到库房（钳制进库房范围）
  assert.equal(beginHold(gs, session, 'placeBox', 0, stockCtx), true);
  assert.equal(session.carry, null, '放下后空手');
  assert.equal(gs.logistics.boxes.length, 1, '箱子回世界');
  const placed = gs.logistics.boxes[0];
  assert.ok(placed.x <= -7.3 && placed.x >= -10 && placed.z >= -4 && placed.z <= 2,
    `箱子落在库房内 (${placed.x},${placed.z})`);
  assert.ok(placed.settled && placed.y === 0, '落定');
  // 库房内照常开箱 → 取货入双手
  assert.equal(beginHold(gs, session, 'unbox', placed.id, stockCtx), true);
  assert.equal(placed.state, 'OPEN');
  assert.equal(beginHold(gs, session, 'pick', placed.id, stockCtx), true);
  assert.ok(session.carry && session.carry.type === 'item', '取货入双手');
  assert.ok(stockInvariantOk(gs));
});

test('放箱不限库房（2026-09 反馈）：店内任何位置可放下，店外钳回店内', () => {
  const { gs, session, box } = setupWithBox();
  session.carry = null;
  const boxCtx = { x: box.x - 1.0, z: box.z, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'carryBox', box.id, boxCtx), true);
  // 店内中段（货架区 (0, 0)）原地放下：不再钳到库房
  const midCtx = { x: 0, z: 0, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'placeBox', 0, midCtx), true);
  const placed = gs.logistics.boxes[0];
  const H = CONFIG.logistics.boxHalf;
  assert.ok(Math.abs(placed.x - 0) < 1e-9 && Math.abs(placed.z - 0) < 1e-9,
    `店内原地放下 (${placed.x},${placed.z})`);
  // 抱起再走到店外街道（z=10）：放下应钳回店内
  assert.equal(beginHold(gs, session, 'carryBox', placed.id, midCtx), true);
  const streetCtx = { x: 0, z: 10, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'placeBox', 0, streetCtx), true);
  assert.ok(placed.z <= 4.4 - H + 1e-9, `店外放下钳回店内（z=${placed.z}）`);
  assert.ok(placed.settled, '落定');
  void H;
});

test('折叠空箱：纸壳入双手 → 抱到库房入库 → 纸板堆 +1', () => {
  const { gs, session, box } = setupWithBox();
  session.carry = null;
  box.state = 'EMPTY';
  const boxCtx = { x: box.x - 1.0, z: box.z, viewMode: 'iso' }; // 走到箱旁折叠（iso 限距 3.2）
  const stockCtx = { x: -8.6, z: -1, viewMode: 'iso' };          // 走到库房入库
  assert.equal(beginHold(gs, session, 'flatten', box.id, boxCtx), true);
  assert.ok(session.carry && session.carry.type === 'cardboard', '纸壳入双手');
  assert.equal(gs.stockroom.cardboard, 0, '还没入库不算库存');
  assert.equal(beginHold(gs, session, 'stash', 0, stockCtx), true);
  assert.equal(gs.stockroom.cardboard, 1, '入库后纸板 +1');
  assert.equal(session.carry, null);
});

test('折叠纸壳一次最多拿 10 张：手上可叠加，叠满拒折，stash 一次入库 +10（2026-09 反馈）', () => {
  const { gs, rng } = setup();
  gs.phase = 'EVENING'; // 晚单次日早到
  restock(gs, { dice_keychain: 44 }); // 11 箱
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const session = startPrepSession(gs, rng);
  session.carry = null;
  assert.equal(gs.logistics.boxes.length, 11);
  for (const b of gs.logistics.boxes) b.state = 'EMPTY';
  // 连续折 10 张（手上纸壳累积，无需先入库）
  const boxes = [...gs.logistics.boxes];
  for (let i = 0; i < 10; i += 1) {
    const b = boxes[i];
    const ctx = { x: b.x - 1.0, z: b.z, viewMode: 'iso' };
    assert.equal(beginHold(gs, session, 'flatten', b.id, ctx), true, `第 ${i + 1} 张可折`);
    assert.equal(session.carry.n, i + 1, `手上纸壳 ${i + 1} 张`);
  }
  // 第 11 张：手上已满 → 拒折、箱留原地
  const b11 = boxes[10];
  const ctx11 = { x: b11.x - 1.0, z: b11.z, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'flatten', b11.id, ctx11), false, '满 10 张拒折');
  assert.equal(gs.logistics.boxes.length, 1, '第 11 箱留在原地');
  // stash 一次入库 +10
  const stockCtx = { x: -8.6, z: -1, viewMode: 'iso' };
  assert.equal(beginHold(gs, session, 'stash', 0, stockCtx), true);
  assert.equal(gs.stockroom.cardboard, 10, '纸板堆一次 +10');
  assert.equal(session.carry, null);
  // 手上是商品时仍不能折（其它约束不变）
  const session2 = { interaction: null, queue: [], needs: [], carry: { type: 'item', skuId: 'boba_tea', qty: 1 } };
  assert.equal(beginHold(gs, session2, 'flatten', b11.id, ctx11), false, '手上拿商品不可折');
});

test('库房门手动开关：doorToggle 翻转 gs.staffDoorOpen', () => {
  const { gs } = setup();
  const session = { interaction: null, queue: [], needs: [], carry: null };
  const ctx = { x: -6.5, z: -1, viewMode: 'iso' };
  assert.equal(gs.staffDoorOpen ?? false, false, '默认关门');
  beginHold(gs, session, 'doorToggle', 0, ctx);
  assert.equal(gs.staffDoorOpen, true, '开门');
  beginHold(gs, session, 'doorToggle', 0, ctx);
  assert.equal(gs.staffDoorOpen, false, '关门');
});

test('关门碰撞：staffDoorOpen=false 时门洞有障碍板，开则通', () => {
  const closed = buildObstacles(FP, { tableCount: 1, decorLevel: 1, staffDoorOpen: false });
  const open = buildObstacles(FP, { tableCount: 1, decorLevel: 1, staffDoorOpen: true });
  assert.equal(closed.length, open.length + 1, '关门多一块门板障碍');
  const gap = { x: -6.9, z: -1 };
  const blockedBy = closed.filter((o) => gap.x > o.minX && gap.x < o.maxX && gap.z > o.minZ && gap.z < o.maxZ);
  assert.ok(blockedBy.length >= 1, '关门时门洞被覆盖');
});
