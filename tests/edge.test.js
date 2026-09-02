/**
 * edge.test.js — QA 补充的边界与负向测试（工程师 happy-path 套件之外）。
 *
 * 覆盖：
 *  - 定价 clamp 精确边界 / 购买概率全参数扫描不越界
 *  - 库存为 0 品类的购买行为 / 资金恰好够/差 1 金币的进货边界 / 满仓与零单
 *  - 账单日资金恰好 = 租金 / = 租金-1 的破产判定边界 / 非账单日负现金不判定
 *  - 体验区满员排队 → 耐心耗尽怒流失 / 释放后排队者入座 / 收银台排队
 *  - 种子确定性：完整 serialize 串比对 + 存档反序列化后 rng 续跑一致
 *  - 活动周仅季首 3 天生效 / 换季热度切换
 *  - 声望 100 胜利 → 自由经营可继续且不重复触发
 *  - 非法输入负向（非有限数值不得破坏 GameState）
 *  - 30 天独立冒烟（种子 7 / 99，与工程师自测种子不同）
 *
 * 运行：node --test tests/edge.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, serialize, deserialize } from '../src/sim/gameState.js';
import {
  purchaseProbability, dailyFootfall, restock, setPrice, buyUpgrade,
  settleDay, inventoryCap, rentFor, seasonHeatMult, experienceFee,
} from '../src/sim/economy.js';
import {
  applyMorningActions, rollDailyEvent, startOpenSession, stepSession, nextDay,
} from '../src/sim/day.js';
import { spawnCustomer, stepCustomer } from '../src/sim/customers.js';
import { grantStock, syncInventory, takeFromShelf as takeFromShelfForTest } from '../src/sim/logistics.js';

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

/** 完整跑一天（晨间进货 → 事件 → 营业 → 日结 → 跨天）。 */
function playDay(gs, rng, orders) {
  applyMorningActions(gs, { orders }, rng);
  rollDailyEvent(gs, rng);
  const session = startOpenSession(gs, rng);
  let guard = 0;
  while (gs.phase === 'OPEN' && guard < 500000) {
    stepSession(session, gs, rng, CONFIG.tick);
    guard += 1;
  }
  assert.equal(gs.phase, 'CLOSING', '营业必须能正常打烊');
  const report = settleDay(gs);
  if (report.victory) gs.freePlay = true; // 模拟玩家选择自由经营
  if (!report.gameover) nextDay(gs);
  return report;
}

// ---------- 定价 clamp 精确边界 ----------

test('setPrice：±50% 边界值本身生效，之外被钳制', () => {
  const gs = newGame(42);
  const guide = CONFIG.products.boardgame_low.guidePrice; // 75
  const min = Math.round(guide * CONFIG.economy.priceClampMin); // 38
  const max = Math.round(guide * CONFIG.economy.priceClampMax); // 113
  assert.equal(setPrice(gs, 'boardgame_low', min), min, '下限边界应生效');
  assert.equal(setPrice(gs, 'boardgame_low', max), max, '上限边界应生效');
  assert.equal(setPrice(gs, 'boardgame_low', min - 1), min, '低于下限 1 金币应被钳制');
  assert.equal(setPrice(gs, 'boardgame_low', -100), min, '负价格应被钳制到下限');
  assert.equal(setPrice(gs, 'boardgame_low', max + 500), max, '远超上限应被钳制');
  assert.equal(setPrice(gs, 'boardgame_low', guide), guide, '指导价原样生效');
  // 钳制后购买概率公式中的 r 也必须在 [0.5, 1.5]
  setPrice(gs, 'boardgame_low', 1);
  const c = { pref: CONFIG.customerTypes.core.pref, budget: 9999 };
  const p = purchaseProbability(c, CONFIG.products.boardgame_low, gs);
  assert.ok(p >= CONFIG.economy.pMin && p <= CONFIG.economy.pMax);
});

// ---------- 购买概率全参数扫描 ----------

test('购买概率全参数扫描：四季×装修×品类×价格×类型×预算×体验，始终落在 [pMin,pMax] ⊂ [0,1]', () => {
  const gs = newGame(42);
  let checked = 0;
  for (const season of CONFIG.seasons.order) {
    gs.season = season;
    for (const decor of [1, 2, 3]) {
      gs.upgrades.decor = decor;
      for (const cat of CONFIG.categoryOrder) {
        const product = CONFIG.products[cat];
        for (const mult of [0.5, 0.75, 1, 1.25, 1.5]) {
          setPrice(gs, cat, Math.round(product.guidePrice * mult));
          for (const type of CONFIG.customerTypeOrder) {
            const def = CONFIG.customerTypes[type];
            for (const budget of [def.budget[0], def.budget[1]]) {
              const c = { pref: def.pref, budget };
              for (const afterExp of [false, true]) {
                const p = purchaseProbability(c, product, gs, afterExp);
                assert.ok(
                  p >= CONFIG.economy.pMin && p <= CONFIG.economy.pMax,
                  `p=${p} 越界 @ ${season}/${cat}/${type}/mult=${mult}/budget=${budget}/exp=${afterExp}`,
                );
                assert.ok(p >= 0 && p <= 1);
                checked += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 3000, `扫描组合数 ${checked} 应 > 3000`);
});

test('购买概率极端组合：最便宜+最高偏好+体验+装修3级 → 顶到 pMax；最贵+低偏好+超预算 → 接近 pMin', () => {
  const gs = newGame(42);
  gs.season = 'spring'; // merch 热度 +0.3
  gs.upgrades.decor = 3;
  setPrice(gs, 'merch', Math.round(CONFIG.products.merch.guidePrice * 0.5));
  const collector = { pref: CONFIG.customerTypes.collector.pref, budget: 500 };
  const pHigh = purchaseProbability(collector, CONFIG.products.merch, gs, true);
  assert.equal(pHigh, CONFIG.economy.pMax, '极端有利组合应被 clamp 到 pMax=0.97');

  const gs2 = newGame(42);
  gs2.season = 'winter'; // boardgame_low 热度 -0.3
  setPrice(gs2, 'boardgame_low', Math.round(CONFIG.products.boardgame_low.guidePrice * 1.5));
  const poorLowPref = { pref: CONFIG.customerTypes.collector.pref, budget: 1 }; // pref 0.05，超预算
  const pLow = purchaseProbability(poorLowPref, CONFIG.products.boardgame_low, gs2);
  assert.ok(pLow >= CONFIG.economy.pMin && pLow < 0.05, `极端不利组合 ${pLow} 应贴近 pMin`);
});

// ---------- 库存 / 资金边界 ----------

test('库存为 0 的品类整日不会售出，任何 tick 库存不为负', () => {
  const gs = newGame(42);
  gs.inventory = { boardgame_low: 0, boardgame_high: 0, snacks: 50, merch: 0 };
  const rng = createRng(23);
  rollDailyEvent(gs, rng);
  const session = startOpenSession(gs, rng);
  let guard = 0;
  while (gs.phase === 'OPEN' && guard < 500000) {
    stepSession(session, gs, rng, CONFIG.tick);
    for (const cat of CONFIG.categoryOrder) {
      assert.ok(gs.inventory[cat] >= 0, `${cat} 库存出现负值 ${gs.inventory[cat]}`);
    }
    guard += 1;
  }
  assert.equal(gs.inventory.boardgame_low, 0, '无货品类不得被售出');
  assert.equal(gs.inventory.merch, 0, '无货品类不得被售出');
  assert.equal(
    gs.today.revenue % gs.prices.snacks, 0,
    '当日销售收入只能由 snacks 单价整除（其它品类无货）',
  );
});

test('restock：现金恰好等于总价 → 成交且现金归零；差 1 金币 → 整单拒绝且状态不变', () => {
  const gs = newGame(42);
  // v2：品类键下单展开为默认 SKU，成本按 SKU 计
  const skuCost = CONFIG.skus[CONFIG.categoryDefaultSku.snacks].cost;
  gs.cash = skuCost * 2;
  const before = { ...gs.inventory };
  const ok = restock(gs, { snacks: 2 });
  assert.equal(ok.ok, true);
  assert.equal(gs.cash, 0, '恰好付清后现金应为 0（不破产，破产仅账单日判定）');
  assert.equal(gs.inventory.snacks, before.snacks + 2);

  const gs2 = newGame(42);
  gs2.cash = skuCost * 2 - 1;
  const no = restock(gs2, { snacks: 2 });
  assert.equal(no.ok, false, '差 1 金币应整单拒绝');
  assert.equal(gs2.cash, skuCost * 2 - 1, '拒绝时现金不变');
  assert.equal(gs2.inventory.snacks, CONFIG.initialInventory.snacks, '拒绝时库存不变');
  assert.equal(gs2.today.restockCost, 0, '拒绝时不计进货成本');
});

test('restock：零单与满仓边界 — ok 但不产生任何变化', () => {
  const gs = newGame(42);
  const r0 = restock(gs, { snacks: 0, merch: 0 });
  assert.equal(r0.ok, true);
  assert.equal(r0.spent, 0);
  assert.equal(gs.cash, CONFIG.initialCash);

  // 2026-09 在库上限已取消：用大额存量构造「高库存」场景（语义等价于旧满仓）
  const sku = CONFIG.categoryDefaultSku.snacks;
  const st = gs.skus[sku];
  st.backroom = 999;
  syncInventory(gs);
  const r1 = restock(gs, { snacks: 5 });
  assert.equal(r1.ok, true);
  assert.equal(r1.fulfilled[sku], 5, '2026-09 上限取消：高库存仍可全额下单');
  assert.equal(r1.spent, 5 * CONFIG.skus[sku].cost);
  assert.equal(gs.inventory.snacks, 999 + 5, '库存无上限累加');
});

// ---------- 破产/胜利判定边界 ----------

test('settleDay：账单日现金恰好=租金 → 结余 0 不破产；=租金-1 → 破产', () => {
  const gs = newGame(42);
  gs.day = 7;
  gs.cash = rentFor(gs); // 恰好够付
  const r1 = settleDay(gs);
  assert.equal(gs.cash, 0);
  assert.equal(r1.gameover, false, 'cash===0 不破产（判定为 cash<0）');
  assert.notEqual(gs.phase, 'GAMEOVER');

  const gs2 = newGame(42);
  gs2.day = 7;
  gs2.cash = rentFor(gs2) - 1;
  const r2 = settleDay(gs2);
  assert.equal(gs2.cash, -1);
  assert.equal(r2.gameover, true, '账单日结余 -1 必须破产');
  assert.equal(gs2.phase, 'GAMEOVER');
});

test('settleDay：非账单日现金已为负不判定破产（设计：仅账单日结算时判定）', () => {
  const gs = newGame(42);
  gs.day = 6; // 非账单日
  gs.cash = -50;
  const r = settleDay(gs);
  assert.equal(r.rentDue, false);
  assert.equal(r.gameover, false);
  assert.notEqual(gs.phase, 'GAMEOVER');
});

test('settleDay：声望 99 +1 → 恰好 100 触发胜利；声望不为负', () => {
  const gs = newGame(42);
  gs.reputation = 99;
  gs.today.satisfactionSum = 1;
  const r = settleDay(gs);
  assert.equal(gs.reputation, 100);
  assert.equal(r.victory, true);

  const gs2 = newGame(42);
  gs2.reputation = 1;
  gs2.today.satisfactionSum = -50;
  settleDay(gs2);
  assert.equal(gs2.reputation, 0, '声望应 clamp 到 0，不得为负');
});

test('胜利 → 自由经营：可继续营业且不重复触发胜利', () => {
  const gs = newGame(42);
  gs.reputation = 99;
  gs.today.satisfactionSum = 5;
  const r1 = settleDay(gs);
  assert.equal(r1.victory, true);
  assert.equal(gs.phase, 'VICTORY');

  // 模拟 main.js 中玩家点击"继续自由经营"
  gs.freePlay = true;
  nextDay(gs);
  assert.equal(gs.phase, 'MORNING');
  assert.equal(gs.day, 2);

  // 再完整跑一天
  const rng = createRng(64);
  const r2 = playDay(gs, rng, { snacks: 3 });
  assert.equal(r2.victory, false, '自由经营中不得重复触发胜利横幅');
  assert.equal(r2.gameover, false);
  assert.equal(gs.phase, 'MORNING', '自由经营应正常进入次日');
  assert.ok(gs.reputation <= 100);
});

// ---------- 顾客 AI：排队与耐心 ----------

test('体验区满员排队：耐心耗尽 → 怒流失，且不抢他人体验位', () => {
  const gs = newGame(42);
  const rng = createRng(3);
  const session = makeSession(gs);
  session.expSlots = [999, 998]; // 两个体验位均被他人占用
  const c = spawnCustomer(gs, rng, 'core');
  c.id = 1;
  c.state = 'TO_EXPERIENCE';
  c.timer = 1.0;
  c.patience = 0.2; // 排队中立即耗尽
  session.customers.push(c);
  stepUntilGone(c, session, gs, rng);
  assert.equal(c.satisfaction, -1);
  assert.equal(gs.today.lost, 1);
  assert.equal(gs.today.satisfactionSum, -1);
  assert.deepEqual(session.expSlots, [999, 998], '怒流失不得释放/抢占他人体验位');
});

test('体验区满员排队：空位释放后排队顾客入座并付体验费', () => {
  const gs = newGame(42);
  gs.inventory = { boardgame_low: 50, boardgame_high: 50, snacks: 50, merch: 50 };
  const rng = createRng(17);
  const session = makeSession(gs);
  const c1 = spawnCustomer(gs, rng, 'core');
  c1.id = 1;
  c1.state = 'EXPERIENCING';
  c1.slotId = 0;
  c1.timer = 2; // 2 秒后体验结束
  c1.patience = 9999;
  session.expSlots[0] = 1;
  session.expSlots[1] = 999; // 另一位被占
  const c2 = spawnCustomer(gs, rng, 'student');
  c2.id = 2;
  c2.state = 'TO_EXPERIENCE';
  c2.timer = 0.5;
  c2.patience = 9999;
  session.customers.push(c1, c2);

  const feeBefore = gs.today.experienceIncome;
  let sawQueued = false;
  let sawSeated = false;
  let guard = 0;
  while (c2.state !== 'GONE' && guard < 20000) {
    stepCustomer(c1, session, gs, rng, CONFIG.tick);
    stepCustomer(c2, session, gs, rng, CONFIG.tick);
    if (c2.state === 'TO_EXPERIENCE') sawQueued = true;
    if (c2.state === 'EXPERIENCING') sawSeated = true;
    guard += 1;
  }
  assert.ok(sawQueued, '满员时顾客应在 TO_EXPERIENCE 排队等待');
  assert.ok(sawSeated, '空位释放后排队顾客应入座');
  assert.equal(
    gs.today.experienceIncome, feeBefore + experienceFee(gs),
    '入座时应收取一次体验费（c1 为直接放置未经过收费路径）',
  );
});

test('收银台排队：两位顾客先后结账，收入与库存正确累计（v2：A33 自助兜底驱动）', () => {
  const gs = newGame(42);
  // v2：库存必须真实铺到货架（四态），顾客从货架取货后排队
  const sku = CONFIG.categoryDefaultSku.snacks;
  grantStock(gs, sku, 'onShelf', 10);
  const rng = createRng(31);
  const session = makeSession(gs);
  const mk = (id) => {
    const c = spawnCustomer(gs, rng, 'casual');
    c.id = id;
    c.state = 'TO_CHECKOUT';
    c.target = 'snacks';
    c.targetSku = sku;           // v2：已取货（手上拿着 SKU）
    takeFromShelfForTest(gs, sku);
    c.timer = 0.2;
    c.patience = 9999;
    session.customers.push(c);
    return c;
  };
  const c1 = mk(1);
  const c2 = mk(2);
  const cashBefore = gs.cash;
  const price = gs.skuPrices[sku];
  let guard = 0;
  // v2：结账由 stepSession 的 stepCheckout 驱动。此处模拟玩家按 F：
  // 队列非空且有收银位空闲时置 playerPayDone（等价于玩家完成一次按住 F）
  while ((c1.state !== 'GONE' || c2.state !== 'GONE') && guard < 20000) {
    if (session.queue.length > 0
      && session.paySlots.some((s) => s.customerId === null)) {
      session.playerPayDone = 1;
    }
    stepSession(session, gs, rng, CONFIG.tick);
    guard += 1;
  }
  assert.equal(gs.today.bought, 2, '两人都应完成购买');
  assert.equal(gs.cash, cashBefore + 2 * price);
  assert.equal(gs.skus[sku].onShelf, 8, '售出 2 件后货架库存 -2');
  assert.equal(session.queue.length, 0, '队列最终应清空');
  assert.ok(session.paySlots.every((s) => s.customerId === null), '收银位最终应释放');
});

test('收银台排队中耐心耗尽：怒流失且不影响正在结账的顾客', () => {
  const gs = newGame(42);
  const sku = CONFIG.categoryDefaultSku.snacks;
  grantStock(gs, sku, 'onShelf', 10);
  const rng = createRng(47);
  const session = makeSession(gs);
  const c1 = spawnCustomer(gs, rng, 'core');
  c1.id = 1;
  c1.state = 'TO_CHECKOUT';
  c1.target = 'snacks';
  c1.targetSku = sku;
  takeFromShelfForTest(gs, sku);
  c1.timer = 0.2;
  c1.patience = 9999;
  const c2 = spawnCustomer(gs, rng, 'student');
  c2.id = 2;
  c2.state = 'TO_CHECKOUT';
  c2.target = 'snacks';
  c2.targetSku = sku;
  takeFromShelfForTest(gs, sku);
  c2.timer = 0.2;
  c2.patience = 0.3; // 自身耐心立即耗尽
  session.customers.push(c1, c2);
  // v2：c1 由 stepCheckout（stepSession 内）完成结账；c2 在 QUEUED 时自身耐心耗尽怒流失
  // 注意：c2 入队后需把队列耐心压到极小，确保在 A33 自助兜底（14s）之前触发
  let guard = 0;
  let c2Queued = false;
  while ((c1.state !== 'GONE' || c2.state !== 'GONE') && guard < 20000) {
    stepSession(session, gs, rng, CONFIG.tick);
    if (!c2Queued && c2.state === 'QUEUED') {
      c2.queuePatience = 0.05; // 入队即濒临超时（A33 兜底需要 14s+5s，远慢于此）
      c2Queued = true;
    }
    guard += 1;
  }
  assert.equal(c1.bought.length, 1, '正在结账的顾客不受影响');
  assert.equal(c2.satisfaction, CONFIG.satisfaction.angry, '排队超时的顾客怒流失');
  assert.equal(c2.bought.length, 0);
  assert.equal(gs.today.bought, 1);
  assert.equal(gs.today.lost, 1);
  assert.equal(session.queue.length, 0, '队列最终应清空');
  assert.ok(session.paySlots.every((s) => s.customerId === null), '收银位最终应释放');
});

// ---------- 种子确定性 ----------

test('确定性：同种子 10 天完整 serialize 串完全一致', () => {
  function run(seed, days) {
    const gs = newGame(seed);
    const rng = createRng(seed);
    for (let d = 0; d < days; d += 1) {
      playDay(gs, rng, { boardgame_low: 4, snacks: 8, merch: 2 });
    }
    gs.rngState = rng.state;
    return serialize(gs);
  }
  assert.equal(run(888, 10), run(888, 10), '同种子两次 10 天存档串应逐字节一致');
});

test('确定性：中途存档反序列化后 rng 续跑，与连续运行结果一致', () => {
  const seed = 555;
  const orders = { boardgame_low: 4, snacks: 8, merch: 2 };
  // A：连续跑 10 天
  const gsA = newGame(seed);
  const rngA = createRng(seed);
  for (let d = 0; d < 5; d += 1) playDay(gsA, rngA, orders);
  gsA.rngState = rngA.state;
  const saveJson = serialize(gsA); // 第 5 天结束存档
  for (let d = 0; d < 5; d += 1) playDay(gsA, rngA, orders);
  gsA.rngState = rngA.state;

  // B：从第 5 天存档恢复，再跑 5 天
  const gsB = deserialize(saveJson);
  assert.ok(gsB !== null);
  const rngB = createRng(gsB.rngState);
  for (let d = 0; d < 5; d += 1) playDay(gsB, rngB, orders);
  gsB.rngState = rngB.state;

  assert.equal(serialize(gsB), serialize(gsA), '读档续跑应与连续运行逐字节一致');
});

// ---------- 季节 / 活动周 ----------

test('活动周仅在季首 3 天生效，换季日热度系数切换', () => {
  const gs = newGame(42);
  const timeline = [];
  for (let d = 1; d <= 15; d += 1) {
    timeline.push({
      day: gs.day, season: gs.season,
      act: gs.activityDaysLeft,
      foot: dailyFootfall(gs), // 无事件/无传说周边，便于精确断言
      snacksHeat: seasonHeatMult(gs, 'snacks'),
    });
    nextDay(gs);
  }
  const at = (day) => timeline[day - 1];
  const activeFoot = Math.round(CONFIG.footfall.base * CONFIG.footfall.activityMult); // 13
  assert.equal(at(1).act, CONFIG.seasons.activityDays);
  assert.equal(at(1).foot, activeFoot, '季首第 1 天有活动加成');
  assert.equal(at(3).foot, activeFoot, '季首第 3 天仍有活动加成');
  assert.equal(at(4).foot, CONFIG.footfall.base, '第 4 天活动周结束，加成消失');
  assert.equal(at(10).season, 'spring');
  assert.equal(at(10).snacksHeat, 1, '春季 snacks 热度修正 0');
  assert.equal(at(11).season, 'summer', '第 11 天换季');
  assert.equal(at(11).act, CONFIG.seasons.activityDays, '换季首日重置活动周');
  assert.equal(at(11).foot, activeFoot);
  assert.equal(at(11).snacksHeat, 1.3, '夏季 snacks 热度 +0.3');
  assert.equal(at(13).foot, activeFoot);
  assert.equal(at(14).foot, CONFIG.footfall.base, '新季第 4 天加成消失');
});

// ---------- 同屏上限 ----------

test('同屏顾客不超过 12；打烊后时刻表清空不再进客', () => {
  const gs = newGame(42);
  gs.reputation = 100;
  gs.freePlay = true;
  gs.eventToday = 'influencer'; // 客流 ×influencerMult，配合活动周
  const rng = createRng(9);
  const session = startOpenSession(gs, rng);
  const planned = session.spawnSchedule.length;
  // v2：计划客流按 CONFIG 动态计算（不硬编码，随 footfall.base 调参合法演进）
  const f = CONFIG.footfall;
  const evMult = CONFIG.events.find((e) => e.id === 'influencer').footfallMult;
  const expectedPlanned = Math.round((f.base + 100 / f.repDivisor) * evMult * f.activityMult);
  assert.equal(planned, expectedPlanned, `高压客流计划应为 ${expectedPlanned} 人（实测 ${planned}）`);
  assert.ok(planned >= 30, '高压场景客流应显著高于日常');
  let maxConcurrent = 0;
  let guard = 0;
  while (gs.phase === 'OPEN' && guard < 500000) {
    stepSession(session, gs, rng, CONFIG.tick);
    maxConcurrent = Math.max(maxConcurrent, session.customers.length);
    guard += 1;
  }
  assert.ok(maxConcurrent <= CONFIG.maxOnScreen, `同屏峰值 ${maxConcurrent} 超过上限`);
  assert.equal(gs.phase, 'CLOSING');
  assert.equal(session.spawnSchedule.length, 0, '打烊后时刻表应清空');
  assert.ok(gs.today.footfall <= planned, '实际进店不超过计划客流');
  for (const cat of CONFIG.categoryOrder) {
    assert.ok(gs.inventory[cat] >= 0);
  }
});

// ---------- 非法输入负向 ----------

test('负向：deserialize 拒绝各种非法输入', () => {
  assert.equal(deserialize('{broken json'), null);
  assert.equal(deserialize('{}'), null, '缺 day 字段');
  assert.equal(deserialize('null'), null);
  assert.equal(deserialize('"just a string"'), null);
  assert.equal(deserialize('[1,2,3]'), null, '数组不是合法 GameState');
  assert.equal(deserialize('{"day":"1"}'), null, 'day 必须是 number');
});

test('负向：restock 对非有限/非法数量不得破坏现金与库存', () => {
  const gs = newGame(42);
  const cashBefore = gs.cash;
  const invBefore = { ...gs.inventory };
  const r = restock(gs, { snacks: 'abc', merch: NaN, boardgame_low: 2.9, boardgame_high: -3 });
  assert.ok(Number.isFinite(gs.cash), `现金被非有限输入污染为 ${gs.cash}`);
  assert.ok(Number.isInteger(gs.cash), '现金必须保持整数');
  for (const cat of CONFIG.categoryOrder) {
    assert.ok(Number.isInteger(gs.inventory[cat]), `${cat} 库存必须保持整数`);
    assert.ok(gs.inventory[cat] >= invBefore[cat], `${cat} 库存不得因非法输入减少`);
  }
  // 期望行为：非法数量按 0 处理；2.9 向下取整为 2（唯一生效项）
  // v2：fulfilled 按 SKU 键返回（品类键 → 该品类默认 SKU）
  assert.equal(r.fulfilled[CONFIG.categoryDefaultSku.snacks] || 0, 0);
  assert.equal(r.fulfilled[CONFIG.categoryDefaultSku.merch] || 0, 0);
  assert.equal(r.fulfilled[CONFIG.categoryDefaultSku.boardgame_low], 2, '小数数量应向下取整');
  assert.equal(gs.cash, cashBefore - 2 * CONFIG.skus[CONFIG.categoryDefaultSku.boardgame_low].cost);
});

test('负向：setPrice 对非有限数值不得写入非法价格', () => {
  const gs = newGame(42);
  const before = gs.prices.snacks;
  setPrice(gs, 'snacks', NaN);
  assert.ok(
    Number.isFinite(gs.prices.snacks),
    `NaN 定价被写入：${gs.prices.snacks}（期望忽略或钳制到合法区间）`,
  );
  setPrice(gs, 'snacks', undefined);
  assert.ok(Number.isFinite(gs.prices.snacks));
  setPrice(gs, 'snacks', '50');
  assert.ok(Number.isFinite(gs.prices.snacks), `字符串定价应被转换或拒绝：${gs.prices.snacks}`);
  void before;
});

// ---------- 独立 30 天冒烟（种子 7 / 99） ----------

for (const seed of [7, 99]) {
  test(`独立冒烟：种子 ${seed} 跑 30 天无异常、数值轨迹合理`, () => {
    const gs = newGame(seed);
    const rng = createRng(seed);
    const trajectory = [];
    let gameoverDay = null;
    let victoryDay = null;
    for (let d = 0; d < 30 && gs.phase !== 'GAMEOVER'; d += 1) {
      // 晨间策略：富余时升级，按预算补货（逐品类控制总价 ≤ 现金）
      if (gs.cash > 3000) buyUpgrade(gs, 'experience');
      if (gs.cash > 3000) buyUpgrade(gs, 'decor');
      if (gs.cash > 6000) buyUpgrade(gs, 'shelf');
      const cap = inventoryCap(gs);
      let budget = Math.max(0, gs.cash - rentFor(gs)); // 预留租金
      const orders = {};
      for (const cat of CONFIG.categoryOrder) {
        const cost = CONFIG.products[cat].cost;
        const qty = Math.max(0, Math.min(cap - gs.inventory[cat], Math.floor(budget / cost), 5));
        orders[cat] = qty;
        budget -= qty * cost;
      }
      const report = playDay(gs, rng, orders);
      if (report.victory && victoryDay === null) victoryDay = report.day;
      trajectory.push({ day: report.day, cash: report.cash, rep: report.reputation });
      assert.ok(Number.isFinite(gs.cash), `第 ${report.day} 天现金非有限值`);
      assert.ok(Number.isInteger(gs.cash), `第 ${report.day} 天现金非整数`);
      assert.ok(gs.reputation >= 0 && gs.reputation <= 100);
      assert.ok(
        ['MORNING', 'GAMEOVER', 'VICTORY'].includes(gs.phase) || gs.phase === 'CLOSING',
        `第 ${report.day} 天后阶段异常：${gs.phase}`,
      );
    }
    if (gs.phase === 'GAMEOVER') gameoverDay = gs.day;
    const last = trajectory[trajectory.length - 1];
    // 合理性：合理经营策略下不应在第 1 个账单日前破产
    assert.ok(
      gameoverDay === null || gameoverDay > CONFIG.rent.intervalDays,
      `种子 ${seed} 第 ${gameoverDay} 天过早破产，数值轨迹异常`,
    );
    console.log(
      `  [seed ${seed}] 30天轨迹: 末日 cash=${last.cash} rep=${last.rep}`
      + ` victoryDay=${victoryDay} gameoverDay=${gameoverDay}`,
    );
  });
}
