/**
 * analyze-balance.mjs — 数值体系评估（2026-09 需求：重新评估游戏数值）。
 * 跑基线 bot（与 tests/balance.test.js 同逻辑），逐日采集：
 *   客流 / 成交数 / 转化率 / 营业额 / 进货成本 / 毛利 / 毛利率 / 现金 / 声望 / 租金刚性
 * 输出逐日表 + 汇总归因（声望增速拆解、通关天数、盈亏平衡点）。
 *
 * 运行：node tools/analyze-balance.mjs
 */

import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import { settleDay, buyUpgrade } from '../src/sim/economy.js';
import {
  rollDailyEvent, startPrepSession, stepSession, nextDay,
  applyMorningActions, closeOutDay,
} from '../src/sim/day.js';
import { startDeliveries, stepDeliveries } from '../src/sim/logistics.js';

function playWithStats(seed, maxDays = 40) {
  const gs = newGame(seed);
  const rng = createRng(seed);
  const days = [];
  for (let day = 1; day <= maxDays; day += 1) {
    const orders = {};
    let budget = Math.max(0, gs.cash - 500);
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
        if (qty > 0) { orders[skuId] = qty; budget -= qty * cost; }
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
    startDeliveries(gs, 'EVENING');
    for (let i = 0; i < 300; i += 1) stepDeliveries(gs, 0.1);
    closeOutDay(gs);
    const t = gs.today;
    const margin = t.revenue - t.restockCost;
    days.push({
      day: gs.day, footfall: t.footfall, bought: t.bought, lost: t.lost,
      conv: t.footfall > 0 ? t.bought / t.footfall : 0,
      revenue: t.revenue, restockCost: t.restockCost, margin,
      cash: gs.cash, rep: gs.reputation,
      satSum: t.satisfactionSum, rental: t.rentalIncome ?? 0,
    });
    const report = settleDay(gs);
    if (report.gameover) return { seed, result: 'gameover', days };
    if (report.victory) return { seed, result: 'victory', days };
    nextDay(gs, rng);
  }
  return { seed, result: 'timeout', days };
}

const SEEDS = [1, 7, 42, 99, 2026];
const runs = SEEDS.map((s) => playWithStats(s));

// ---- 逐日明细（最长 run 为参照） ----
const ref = runs.reduce((a, b) => (a.days.length > b.days.length ? a : b));
console.log(`\n== 逐日明细（种子 ${ref.seed}，${ref.result}）==`);
console.log('day  客流 成交 流失 转化%  营业额 进货  毛利  租金收入  现金   声望(当日±)');
for (const d of ref.days) {
  console.log(
    `${String(d.day).padStart(3)} ${String(d.footfall).padStart(4)} ${String(d.bought).padStart(4)} ${String(d.lost).padStart(4)}`
    + ` ${(d.conv * 100).toFixed(0).padStart(5)} ${String(Math.round(d.revenue)).padStart(6)} ${String(Math.round(d.restockCost)).padStart(5)}`
    + ` ${String(Math.round(d.margin)).padStart(5)} ${String(Math.round(d.rental)).padStart(7)} ${String(Math.round(d.cash)).padStart(6)}`
    + ` ${String(d.rep).padStart(4)} (${d.satSum >= 0 ? '+' : ''}${d.satSum})`,
  );
}

// ---- 汇总归因 ----
console.log('\n== 汇总 ==');
for (const r of runs) {
  const last = r.days[r.days.length - 1];
  const totalRev = r.days.reduce((s, d) => s + d.revenue, 0);
  const totalMargin = r.days.reduce((s, d) => s + d.margin, 0);
  const avgConv = r.days.reduce((s, d) => s + d.conv, 0) / r.days.length;
  const avgTicket = r.days.reduce((s, d) => s + (d.bought > 0 ? d.revenue / d.bought : 0), 0) / r.days.length;
  const repPerDay = last ? last.rep / r.days.length : 0;
  const repFromBuy = r.days.reduce((s, d) => s + d.satSum, 0);
  console.log(
    `种子 ${String(r.seed).padStart(4)}: ${r.result}@${r.days.length}天`
    + ` 总营收 ${Math.round(totalRev)} 总毛利 ${Math.round(totalMargin)}`
    + ` 均转化 ${(avgConv * 100).toFixed(0)}% 客单 ${avgTicket.toFixed(1)}`
    + ` 声望增速 ${repPerDay.toFixed(1)}/天（购买满意度累计 ${repFromBuy}）`,
  );
}
const victoryDays = runs.filter((r) => r.result === 'victory').map((r) => r.days.length);
console.log(`\n通关天数：${victoryDays.join('/')}（目标带 18-28，footfall.base=${CONFIG.footfall.base}）`);
// 归因提示
const repPerDayAvg = victoryDays.length > 0
  ? runs.filter((r) => r.result === 'victory')
    .reduce((s, r) => s + r.days[r.days.length - 1].rep / r.days.length, 0) / victoryDays.length
  : 0;
console.log(`归因：平均声望增速 ${repPerDayAvg.toFixed(1)}/天 → 100 声望需 ${(100 / repPerDayAvg).toFixed(1)} 天（纯线性近似）`);
