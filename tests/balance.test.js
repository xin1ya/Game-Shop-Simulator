/**
 * balance.test.js — 平衡验证与通关天数观测（T11 / 裁决 9）。
 *
 * 基线画像（PM 定稿 + 主理人裁决）：
 *  - 「有玩家搬货」= autoStock 开（虚拟搬运工，与玩家相同耗时）
 *  - 「有玩家结账」= 队列非空且收银位空闲时模拟按 F
 *  - 「不雇员工」= 全程不 hire（基线）
 *  - 按需补货（四态合计 < 上限 80% 时下单）+ 现金富余时升级
 *
 * 裁决 9 口径：
 *  - 目标 18–25 天 / 可接受带 18–28 天 / >28 或 <18 判不合格
 *  - 唯一调参旋钮 footfall.base（区间 7–10），其余数值冻结
 *  - reputationGoal 100 锁死
 *
 * 本测试断言「可通关且不超时/不异常」，并打印实测天数供归因。
 * 若实测落在带外，应按 §3.1.5.1 先出归因报告，再动 footfall.base。
 *
 * 运行：node --test tests/balance.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import { settleDay, buyUpgrade } from '../src/sim/economy.js';
import {
  rollDailyEvent, startPrepSession, stepSession, nextDay,
  applyMorningActions, closeOutDay,
} from '../src/sim/day.js';
import { startDeliveries, stepDeliveries } from '../src/sim/logistics.js';

/** 基线 bot：按需补货 + 富余升级 + 自动搬货 + 玩家结账，不雇员工。 */
function playBaseline(seed, maxDays = 40) {
  const gs = newGame(seed);
  const rng = createRng(seed);
  for (let day = 1; day <= maxDays; day += 1) {
    const orders = {};
    let budget = Math.max(0, gs.cash - 500); // 2026-09 上限取消：bot 按现金预算下单（留 500 缓冲）
    for (const skuId of CONFIG.skuOrder) {
      if (gs.reputation < CONFIG.skus[skuId].unlockRep) continue;
      const st = gs.skus[skuId];
      const total = st.inTransit + st.inBox + st.backroom + st.onShelf;
      const cap = 10 + 5 * (gs.upgrades.shelf - 1);
      const want = Math.floor(cap * 0.8) - total;
      const cost = CONFIG.skus[skuId].cost;
      if (want >= CONFIG.logistics.boxCapacity && budget >= cost * CONFIG.logistics.boxCapacity) {
        const qty = Math.min(
          Math.floor(want / CONFIG.logistics.boxCapacity) * CONFIG.logistics.boxCapacity,
          Math.floor(budget / cost / CONFIG.logistics.boxCapacity) * CONFIG.logistics.boxCapacity,
        );
        if (qty > 0) {
          orders[skuId] = qty;
          budget -= qty * cost;
        }
      }
    }
    applyMorningActions(gs, { orders }, rng);
    if (gs.cash > 3000) {
      for (const line of ['experience', 'shelf', 'decor']) {
        if (buyUpgrade(gs, line)) break;
      }
    }
    rollDailyEvent(gs, rng);
    const session = startPrepSession(gs, rng);
    session.autoStock = true;
    let guard = 0;
    while ((gs.phase === 'PREP' || gs.phase === 'OPEN') && guard < 50000) {
      if (session.queue.length > 0 && session.paySlots.some((s) => s.customerId === null)) {
        session.playerPayDone = 1;
      }
      stepSession(session, gs, rng, CONFIG.tick);
      guard += 1;
    }
    // 打烊整理（EVENING）：早上下单的货当晚到——发车 + 推进到店，
    // closeOutDay 的 closeOutBoxes 会把未搬箱转后仓（次日 autoStock 上架）
    startDeliveries(gs, 'EVENING');
    for (let i = 0; i < 300; i += 1) stepDeliveries(gs, 0.1);
    closeOutDay(gs);
    const report = settleDay(gs);
    if (report.gameover) return { seed, result: 'gameover', day };
    if (report.victory) return { seed, result: 'victory', day };
    nextDay(gs, rng);
  }
  return { seed, result: 'timeout', rep: gs.reputation };
}

const SEEDS = [1, 7, 42, 99, 2026];

test('平衡验证：5 种子基线（不雇员工+自动搬货+玩家结账）均可通关且不异常', () => {
  const results = SEEDS.map((s) => playBaseline(s));
  const days = results.map((r) => r.day);
  console.log(`[balance] footfall.base=${CONFIG.footfall.base} 通关天数:`,
    results.map((r) => `${r.seed}:${r.result}@${r.day ?? '-'}`).join('  '));
  // 硬守卫：全部可通关（不破产、不超时卡死）
  for (const r of results) {
    assert.equal(r.result, 'victory', `种子 ${r.seed} 应通关，实际 ${r.result}（day=${r.day}）`);
  }
  // 软观测：通关天数应落在可接受带附近（超带宽仅告警不 fail，由归因流程处理）
  const min = Math.min(...days);
  const max = Math.max(...days);
  if (min < 18 || max > 28) {
    console.warn(`[balance] ⚠️ 通关天数 ${min}-${max} 超出可接受带 18-28，需归因后调 footfall.base（当前 ${CONFIG.footfall.base}）`);
  }
});

test('压力路径：从不补货 → 不通关（躺赢不存在）', () => {
  const gs = newGame(7);
  const rng = createRng(7);
  let result = 'running';
  for (let day = 1; day <= 40 && result === 'running'; day += 1) {
    rollDailyEvent(gs, rng); // 不补货
    const session = startPrepSession(gs, rng);
    session.autoStock = true;
    let guard = 0;
    while ((gs.phase === 'PREP' || gs.phase === 'OPEN') && guard < 50000) {
      if (session.queue.length > 0 && session.paySlots.some((s) => s.customerId === null)) {
        session.playerPayDone = 1;
      }
      stepSession(session, gs, rng, CONFIG.tick);
      guard += 1;
    }
    // 打烊整理（EVENING）：早上下单的货当晚到——发车 + 推进到店，
    // closeOutDay 的 closeOutBoxes 会把未搬箱转后仓（次日 autoStock 上架）
    startDeliveries(gs, 'EVENING');
    for (let i = 0; i < 300; i += 1) stepDeliveries(gs, 0.1);
    closeOutDay(gs);
    const report = settleDay(gs);
    if (report.gameover) result = 'gameover';
    else if (report.victory) result = 'victory';
    else nextDay(gs, rng);
  }
  assert.notEqual(result, 'victory', '从不补货不应通关（库存耗尽 → 流失 → 声望衰减）');
});

test('负向路径：+50% 宰客定价 → 不通关（定价博弈有效）', () => {
  const gs = newGame(99);
  const rng = createRng(99);
  let result = 'running';
  for (let day = 1; day <= 40 && result === 'running'; day += 1) {
    const orders = {};
    for (const skuId of CONFIG.skuOrder) {
      if (gs.reputation < CONFIG.skus[skuId].unlockRep) continue;
      const st = gs.skus[skuId];
      const total = st.inTransit + st.inBox + st.backroom + st.onShelf;
      const cap = 10 + 5 * (gs.upgrades.shelf - 1);
      const want = Math.floor(cap * 0.8) - total;
      if (want >= CONFIG.logistics.boxCapacity) {
        orders[skuId] = Math.floor(want / CONFIG.logistics.boxCapacity) * CONFIG.logistics.boxCapacity;
      }
    }
    // 宰客：所有 SKU 定价 +50%（clamp 上限）
    const skuPrices = {};
    for (const skuId of CONFIG.skuOrder) {
      skuPrices[skuId] = Math.round(CONFIG.skus[skuId].guidePrice * 1.5);
    }
    applyMorningActions(gs, { orders, skuPrices }, rng);
    rollDailyEvent(gs, rng);
    const session = startPrepSession(gs, rng);
    session.autoStock = true;
    let guard = 0;
    while ((gs.phase === 'PREP' || gs.phase === 'OPEN') && guard < 50000) {
      if (session.queue.length > 0 && session.paySlots.some((s) => s.customerId === null)) {
        session.playerPayDone = 1;
      }
      stepSession(session, gs, rng, CONFIG.tick);
      guard += 1;
    }
    // 打烊整理（EVENING）：早上下单的货当晚到——发车 + 推进到店，
    // closeOutDay 的 closeOutBoxes 会把未搬箱转后仓（次日 autoStock 上架）
    startDeliveries(gs, 'EVENING');
    for (let i = 0; i < 300; i += 1) stepDeliveries(gs, 0.1);
    closeOutDay(gs);
    const report = settleDay(gs);
    if (report.gameover) result = 'gameover';
    else if (report.victory) result = 'victory';
    else nextDay(gs, rng);
  }
  assert.notEqual(result, 'victory', '宰客定价不应通关（购买概率被压 → 声望停滞）');
});
