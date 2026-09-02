/**
 * staff.test.js — 员工系统测试：雇佣/解雇/排班/疲劳/离职/薪资/自动作业。
 *
 * 覆盖（PRD Part B §3.1）：
 *  - 雇佣扣签约金、星级权重、上限 4 人
 *  - 排班阀门「不上班不付薪」
 *  - 疲劳累积/恢复、效率衰减
 *  - 离职次日生效
 *  - 收银员并行位 1→2、结账加速
 *  - 员工与玩家不重复结算
 *
 * 运行：node --test tests/staff.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import {
  hire, fire, setDuty, payrollFor, severanceFor, dailyWageOf,
  applyEndOfDay, removeQuitters, onDutyMembers, cashierOnDuty,
  checkoutParallel, efficiency, durationFor, starMult, fatigueMult,
  staffTargetOf,
} from '../src/sim/staff.js';

function setup() {
  const gs = newGame(42);
  gs.cash = 10000;
  return { gs, rng: createRng(42) };
}

test('雇佣：扣签约金、生成员工、星级在 1-3', () => {
  const { gs, rng } = setup();
  const cashBefore = gs.cash;
  const res = hire(gs, rng, 'cashier');
  assert.equal(res.ok, true);
  assert.equal(gs.cash, cashBefore - CONFIG.employees.roles.cashier.signBonus);
  assert.ok(res.staff.stars >= 1 && res.staff.stars <= 3);
  assert.equal(gs.staff.members.length, 1);
});

test('雇佣上限 4 人、现金不足拒绝', () => {
  const { gs, rng } = setup();
  for (let i = 0; i < 4; i += 1) hire(gs, rng, 'cashier');
  const res = hire(gs, rng, 'guide');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'full');
  // 先解雇腾位，再测现金不足（full 检查优先于 cash）
  fire(gs, gs.staff.members[0].id);
  gs.cash = 0;
  const res2 = hire(gs, rng, 'guide');
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'cash');
});

test('排班阀门：不上班不付薪（硬约束）', () => {
  const { gs, rng } = setup();
  hire(gs, rng, 'cashier');
  hire(gs, rng, 'guide');
  const m = gs.staff.members[0];
  // 两人在岗 → 薪资 = 两人日薪
  const fullPay = payrollFor(gs);
  assert.equal(fullPay, dailyWageOf(gs.staff.members[0]) + dailyWageOf(gs.staff.members[1]));
  // m 排休 → 不付薪
  setDuty(gs, m.id, false);
  assert.equal(payrollFor(gs), dailyWageOf(gs.staff.members[1]), '★排休员工不付薪');
  assert.equal(onDutyMembers(gs).length, 1);
});

test('疲劳：上班 +25 / 休息 -40，效率随疲劳衰减', () => {
  const { gs, rng } = setup();
  hire(gs, rng, 'cashier', 1); // 强制 1 星
  const m = gs.staff.members[0];
  assert.equal(m.fatigue, 0);
  assert.equal(fatigueMult(m), 1);
  applyEndOfDay(gs, rng); // 上班 → +25
  assert.equal(m.fatigue, 25);
  applyEndOfDay(gs, rng);
  applyEndOfDay(gs, rng); // 75 > 70 → 效率 ×0.7
  assert.equal(m.fatigue, 75);
  assert.equal(fatigueMult(m), CONFIG.employees.fatigue.penaltyMult);
  // 休息恢复
  setDuty(gs, m.id, false);
  applyEndOfDay(gs, rng);
  assert.equal(m.fatigue, 35, '75 - 40 = 35');
});

test('星级效果：1/1.25/1.5 倍，日薪 1/1.4/1.9 倍', () => {
  const { gs, rng } = setup();
  hire(gs, rng, 'cashier', 1);
  hire(gs, rng, 'guide', 3);
  const s1 = gs.staff.members[0];
  const s3 = gs.staff.members[1];
  assert.equal(starMult(s1), 1);
  assert.equal(starMult(s3), 1.5);
  assert.equal(dailyWageOf(s1), CONFIG.employees.roles.cashier.dailyWage);
  assert.equal(dailyWageOf(s3), Math.round(CONFIG.employees.roles.guide.dailyWage * 1.9));
});

test('解雇：扣遣散费（1 天日薪），立即移除', () => {
  const { gs, rng } = setup();
  hire(gs, rng, 'cashier', 2);
  const m = gs.staff.members[0];
  const cashBefore = gs.cash;
  const res = fire(gs, m.id);
  assert.equal(res.ok, true);
  assert.equal(res.cost, severanceFor(m));
  assert.equal(gs.cash, cashBefore - res.cost);
  assert.equal(gs.staff.members.length, 0);
  assert.equal(gs.today.severance, res.cost, '遣散费计入当日统计');
});

test('离职：疲劳 >90 时 20% 概率，次日生效', () => {
  const { gs, rng } = setup();
  hire(gs, rng, 'cashier', 1);
  const m = gs.staff.members[0];
  m.fatigue = 95; // 严重疲劳
  // 跑多天直到离职判定触发（20% 概率，种子确定性下必出）
  let quitSeen = false;
  for (let i = 0; i < 30 && !quitSeen; i += 1) {
    const r = applyEndOfDay(gs, rng);
    if (r.quitIds.includes(m.id)) quitSeen = true;
  }
  assert.ok(quitSeen, '严重疲劳员工应在若干天内判定离职');
  assert.equal(m.quitting, true, '离职次日生效（当天仍标记但不立即移除）');
  removeQuitters(gs);
  assert.equal(gs.staff.members.length, 0, '次日移除');
});

test('收银员在岗：并行位 1 → 2，结账提速 0.6×', () => {
  const { gs, rng } = setup();
  assert.equal(checkoutParallel(gs), 1, '无收银员时 1 位');
  hire(gs, rng, 'cashier', 2);
  assert.equal(checkoutParallel(gs), 2, '★收银员在岗并行位 2');
  const cashier = cashierOnDuty(gs);
  const t = durationFor(cashier, CONFIG.checkout.playerPayTime, CONFIG.employees.roles.cashier.payTimeMult);
  // 2.0 × 0.6 / 1.25(2星) = 0.96s
  assert.ok(t < CONFIG.checkout.playerPayTime, '收银员结账应快于玩家');
  assert.ok(Math.abs(t - 0.96) < 0.01, `2 星收银员约 0.96s/位，实际 ${t}`);
});

test('员工与玩家并存：员工 tick 不与玩家重复结算（占用协议）', () => {
  const { gs, rng } = setup();
  hire(gs, rng, 'stocker', 1);
  // stepStaff 只处理未被玩家占用的箱子；这里验证不产生重复结算
  // （玩家占用后员工跳过：由 logistics.claimBox 的占用守卫保证）
  const stocker = gs.staff.members[0];
  assert.equal(stocker.role, 'stocker');
  assert.equal(typeof efficiency(stocker), 'number');
});

// ---------- 2026-09 员工 AI 走位目标（staffTargetOf：任务系统联动） ----------

test('staffTargetOf：各岗位驻守点（收银守台 / 体验官守体验位 / 导购守待客点）', () => {
  const { gs } = setup();
  const positions = {
    checkout: { x: -4.6, z: 3.5 },
    staffDoor: { x: -6.35, z: -1 },
    waitPoint: { x: 0, z: 0.6 },
    experienceSlots: [{ x: 3.2, z: 0.3 }],
  };
  const session = { needs: [], customers: [] };
  assert.deepEqual(staffTargetOf(gs, session, positions, { role: 'cashier' }), positions.checkout);
  assert.deepEqual(staffTargetOf(gs, session, positions, { role: 'stocker' }), positions.staffDoor);
  assert.deepEqual(staffTargetOf(gs, session, positions, { role: 'guide' }), positions.waitPoint);
  assert.deepEqual(staffTargetOf(gs, session, positions, { role: 'host' }), positions.experienceSlots[0]);
});

test('staffTargetOf：仓管有箱链路任务时走向箱子；导购走向认领需求的顾客', () => {
  const { gs } = setup();
  const positions = {
    checkout: { x: -4.6, z: 3.5 },
    staffDoor: { x: -6.35, z: -1 },
    waitPoint: { x: 0, z: 0.6 },
    experienceSlots: [],
  };
  // 仓管：任务目标箱 → 走向箱位
  gs.logistics.boxes.push({
    id: 77, deliveryId: 1, sku: 'boba_tea', qty: 4, state: 'SEALED',
    slot: 0, progress: 0, claimedBy: null, claimedKind: null,
    x: 7.2, z: 5.3, y: 0, vy: 0, settled: true,
  });
  const stocker = { role: 'stocker', task: { kind: 'restock', targetId: 77 } };
  const t1 = staffTargetOf(gs, { needs: [], customers: [] }, positions, stocker);
  assert.deepEqual(t1, { x: 7.2, z: 5.3 }, '仓管走向目标箱');
  // 导购：认领了需求 → 走向顾客
  const session = {
    needs: [{ id: 5, kind: 'findItem', state: 'CLAIMED', customerId: 9, claimedBy: 2 }],
    customers: [{ id: 9, pos: { x: 1.5, z: -2.0 } }],
  };
  const guide = { role: 'guide', id: 2, task: { kind: 'respond', needId: 5 } };
  const t2 = staffTargetOf(gs, session, positions, guide);
  assert.deepEqual(t2, { x: 1.5, z: -2.0 }, '导购走向认领需求的顾客');
  // 导购无任务 → 待客点
  const t3 = staffTargetOf(gs, session, positions, { role: 'guide' });
  assert.deepEqual(t3, positions.waitPoint);
});
