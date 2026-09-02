/**
 * simulation.test.js — 集成级单测：顾客状态机全路径、整日模拟冒烟、RNG 可复现性。
 * 运行：node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, serialize, deserialize, newDayStats } from '../src/sim/gameState.js';
import { restock, settleDay } from '../src/sim/economy.js';
import {
  applyMorningActions, rollDailyEvent, startOpenSession, stepSession, nextDay,
} from '../src/sim/day.js';
import { spawnCustomer, stepCustomer } from '../src/sim/customers.js';
import { injectStorage, saveGame, loadGame, hasSave } from '../src/sim/save.js';
import { onCustomerServed } from '../src/sim/story.js';
import { grantStock } from '../src/sim/logistics.js';

/** 空会话（供单顾客步进测试）。v2：含 queue / paySlots / needs 等 DaySession 字段。 */
function makeSession(gs) {
  return {
    phase: 'OPEN',
    prepClock: 0,
    clock: 0, speed: 1, spawnSchedule: [], customers: [],
    nextCustomerId: 1,
    expSlots: new Array(1 + gs.upgrades.experience).fill(null),
    queue: [],
    paySlots: [{ customerId: null, elapsed: 0, duration: CONFIG.checkout.playerPayTime, by: null, staffId: null }],
    needs: [],
    needQueue: [],
    nextNeedId: 1,
    needScanTimer: 0,
    playerNeedCooldown: 0,
    interaction: null,
    autoStock: false,
    autoStockProgress: null,
    playerPayDone: 0,
    playerRespondDone: null,
    queuePriority: null,
    pedestrians: [],
    playerPos: { x: 0, z: 0 },
    holding: false,
  };
}

/** 步进顾客直到 GONE（带安全上限）。 */
function stepUntilGone(c, session, gs, rng, maxTicks = 20000) {
  let ticks = 0;
  while (c.state !== 'GONE' && ticks < maxTicks) {
    stepCustomer(c, session, gs, rng, CONFIG.tick);
    ticks += 1;
  }
  return ticks;
}

test('顾客状态机：购买到离店全路径（库存充足 + 低价必买）', () => {
  const gs = newGame(42);
  // v2：库存必须真实铺到货架（gs.inventory 是派生聚合，直接赋值无效）
  for (const cat of CONFIG.categoryOrder) {
    grantStock(gs, CONFIG.categoryDefaultSku[cat], 'onShelf', 20);
  }
  // 全品类 SKU 打到最低价，购买概率拉满
  for (const skuId of CONFIG.skuOrder) {
    gs.skuPrices[skuId] = Math.round(CONFIG.skus[skuId].guidePrice * 0.5);
  }
  const rng = createRng(99);
  const session = makeSession(gs);
  const c = spawnCustomer(gs, rng, 'core');
  c.id = 1;
  c.patience = 9999; // 排除自身耐心干扰
  session.customers.push(c);
  const cashBefore = gs.cash;
  // v2：结账需 stepCheckout（stepSession 内），模拟玩家按 F 收队首
  let ticks = 0;
  while (c.state !== 'GONE' && ticks < 20000) {
    if (session.queue.length > 0
      && session.paySlots.some((s) => s.customerId === null)) {
      session.playerPayDone = 1;
    }
    stepSession(session, gs, rng, CONFIG.tick);
    ticks += 1;
  }
  assert.ok(ticks < 20000, '状态机必须能收敛到 GONE');
  assert.equal(c.bought.length, 1, '应完成一次购买');
  assert.ok(c.satisfaction >= 1, '低价购买应满意');
  assert.ok(gs.cash > cashBefore, '收款应到账');
  assert.equal(gs.today.bought, 1);
  assert.equal(gs.today.satisfactionSum, c.satisfaction);
});

test('顾客状态机：全店无货 → 流失判定路径', () => {
  const gs = newGame(42);
  gs.inventory = { boardgame_low: 0, boardgame_high: 0, snacks: 0, merch: 0 };
  gs.upgrades.experience = 1;
  const rng = createRng(5);
  const session = makeSession(gs);
  session.expSlots = [null]; // 仅 1 个体验位（会先占掉）
  session.expSlots[0] = 999; // 占住体验位，强制走流失分支
  const c = spawnCustomer(gs, rng, 'casual');
  c.id = 1;
  session.customers.push(c);
  stepUntilGone(c, session, gs, rng);
  assert.equal(c.bought.length, 0);
  assert.equal(gs.today.lost, 1, '未购买离店计入流失');
  assert.ok(c.satisfaction <= 0);
});

test('顾客状态机：耐心耗尽 → LEAVING_ANGRY（声望 -1 计入满意度）', () => {
  const gs = newGame(42);
  const rng = createRng(11);
  const session = makeSession(gs);
  const c = spawnCustomer(gs, rng, 'student');
  c.id = 1;
  c.patience = 0.5; // 立即耗尽
  session.customers.push(c);
  stepUntilGone(c, session, gs, rng);
  assert.equal(c.satisfaction, -1);
  assert.equal(gs.today.satisfactionSum, -1);
  assert.equal(gs.today.lost, 1);
});

test('整日模拟冒烟：MORNING → OPEN → CLOSING → settleDay 数值合理', () => {
  const gs = newGame(2026);
  const rng = createRng(2026);
  applyMorningActions(gs, { orders: { boardgame_low: 5, snacks: 10, merch: 3 } }, rng);
  rollDailyEvent(gs, rng);
  const session = startOpenSession(gs, rng);
  assert.equal(gs.phase, 'OPEN');
  let ticks = 0;
  while (gs.phase === 'OPEN' && ticks < 200000) {
    stepSession(session, gs, rng, CONFIG.tick);
    ticks += 1;
  }
  assert.equal(gs.phase, 'CLOSING', '营业应正常打烊');
  assert.ok(gs.today.footfall > 0, '应有顾客进店');
  assert.ok(gs.today.footfall <= 40, '客流应在合理区间');
  const report = settleDay(gs);
  assert.ok(Number.isInteger(report.cash));
  assert.ok(report.reputation >= 0 && report.reputation <= 100);
  nextDay(gs);
  assert.equal(gs.day, 2);
  assert.equal(gs.phase, 'MORNING');
});

test('RNG 可复现性：同种子两次 5 日模拟结果完全一致', () => {
  function runFiveDays(seed) {
    const gs = newGame(seed);
    const rng = createRng(seed);
    for (let d = 0; d < 5; d += 1) {
      applyMorningActions(gs, { orders: { boardgame_low: 4, snacks: 8, merch: 2 } }, rng);
      rollDailyEvent(gs, rng);
      const session = startOpenSession(gs, rng);
      let guard = 0;
      while (gs.phase === 'OPEN' && guard < 200000) {
        stepSession(session, gs, rng, CONFIG.tick);
        guard += 1;
      }
      settleDay(gs);
      nextDay(gs);
    }
    return { cash: gs.cash, rep: gs.reputation, rngState: rng.state };
  }
  const a = runFiveDays(777);
  const b = runFiveDays(777);
  assert.deepEqual(a, b, '相同种子应产出完全相同的结果');
});

test('序列化/反序列化 + save/load 往返一致', () => {
  const gs = newGame(314);
  gs.cash = 2345;
  gs.reputation = 37;
  gs.day = 9;
  const restored = deserialize(serialize(gs));
  assert.equal(restored.cash, 2345);
  assert.equal(restored.reputation, 37);
  assert.equal(restored.day, 9);
  assert.deepEqual(restored.inventory, gs.inventory);
  assert.equal(deserialize('{broken json'), null);

  // 注入内存存储模拟 localStorage
  const mem = new Map();
  injectStorage({
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  });
  assert.equal(saveGame(gs), true);
  assert.equal(hasSave(), true);
  const loaded = loadGame();
  assert.equal(loaded.cash, 2345);
  assert.equal(loaded.rngState, gs.rngState);
  injectStorage(null);
});

test('换季与活动周：第 10→11 天换季，季首日重置活动周', () => {
  const gs = newGame(42);
  assert.equal(gs.season, 'spring');
  assert.equal(gs.activityDaysLeft, CONFIG.seasons.activityDays, '第 1 天开启活动周');
  // 推进到第 11 天（夏季首日）
  for (let d = 1; d < 11; d += 1) {
    gs.today = newDayStats();
    nextDay(gs);
  }
  assert.equal(gs.day, 11);
  assert.equal(gs.season, 'summer');
  assert.equal(gs.activityDaysLeft, CONFIG.seasons.activityDays, '换季首日重置活动周');
  nextDay(gs);
  assert.equal(gs.activityDaysLeft, CONFIG.seasons.activityDays - 1);
});

test('常客解锁与剧情推进：到访满意 → storyStage 推进，完结发奖', () => {
  const gs = newGame(42);
  gs.reputation = 20; // ≥15 解锁小满
  const rng = createRng(8);
  startOpenSession(gs, rng); // 触发解锁
  const reg = gs.regulars.find((r) => r.id === 'xiaoman');
  assert.equal(reg.unlocked, true);
  assert.ok(gs.storyQueue.some((t) => t.includes('小满')));

  // 直接模拟常客满意购买
  const cashBefore = gs.cash;
  for (let i = 0; i < 3; i += 1) {
    onCustomerServed(gs, { regularId: 'xiaoman', satisfaction: 2 });
  }
  assert.equal(reg.storyStage, 3);
  assert.equal(reg.completed, true);
  assert.ok(gs.cash > cashBefore, '完结应发现金奖励');
});
