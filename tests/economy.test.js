/**
 * economy.test.js — 经济公式单测：购买概率边界、租金、破产/胜利、季节修正。
 * 运行：node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import {
  purchaseProbability, dailyFootfall, restock, setPrice, buyUpgrade,
  settleDay, inventoryCap, rentFor, priceRatio, seasonHeatMult,
} from '../src/sim/economy.js';

/** 构造一个确定性顾客。 */
function makeCustomer(overrides = {}) {
  return {
    id: 1, type: 'core', budget: 300, patience: 60,
    pref: { ...CONFIG.customerTypes.core.pref },
    state: 'BROWSING', target: null, slotId: null, timer: 5,
    bought: [], satisfaction: 0, regularId: null, expTried: false,
    ...overrides,
  };
}

test('购买概率：低价高于高价，且被 clamp 在 [pMin, pMax]', () => {
  const gs = newGame(42);
  const c = makeCustomer();
  const product = CONFIG.products.boardgame_low;
  setPrice(gs, 'boardgame_low', Math.round(product.guidePrice * 0.5));
  const pCheap = purchaseProbability(c, product, gs);
  setPrice(gs, 'boardgame_low', product.guidePrice);
  const pGuide = purchaseProbability(c, product, gs);
  setPrice(gs, 'boardgame_low', Math.round(product.guidePrice * 1.5));
  const pExpensive = purchaseProbability(c, product, gs);
  assert.ok(pCheap > pGuide, `低价概率 ${pCheap} 应高于指导价 ${pGuide}`);
  assert.ok(pGuide > pExpensive, `指导价概率 ${pGuide} 应高于高价 ${pExpensive}`);
  assert.ok(pCheap <= CONFIG.economy.pMax && pExpensive >= CONFIG.economy.pMin);
  // 高于指导价每 10% 概率约 -8%：r=1.5 时 priceFactor = 1 - 0.8×0.5 = 0.6
  const ratio = pExpensive / pGuide;
  const heat = seasonHeatMult(gs, 'boardgame_low');
  assert.ok(Math.abs(ratio - 0.6) < 1e-9 || heat !== 1, 'r=1.5 时 priceFactor 应为 0.6');
});

test('购买概率：预算硬约束 ×budgetPenalty', () => {
  const gs = newGame(42);
  const product = CONFIG.products.boardgame_high;
  const rich = makeCustomer({ budget: 500 });
  const poor = makeCustomer({ budget: 10 });
  const pRich = purchaseProbability(rich, product, gs);
  const pPoor = purchaseProbability(poor, product, gs);
  assert.ok(Math.abs(pPoor - pRich * CONFIG.economy.budgetPenalty) < 1e-9,
    '超预算应按 budgetPenalty 折减');
});

test('购买概率：体验区二次判定 ×1.2，装修等级有加成', () => {
  const gs = newGame(42);
  const c = makeCustomer();
  const product = CONFIG.products.snacks;
  const pBase = purchaseProbability(c, product, gs);
  const pExp = purchaseProbability(c, product, gs, true);
  assert.ok(pExp > pBase, '体验后判定应更高');
  gs.upgrades.decor = 3;
  const pDecor = purchaseProbability(c, product, gs);
  assert.ok(pDecor > pBase, '装修 3 级应有加成');
});

test('季节修正：换季改变 seasonHeatMult 与购买概率', () => {
  const gs = newGame(42);
  gs.season = 'spring';
  const pSpring = purchaseProbability(makeCustomer(), CONFIG.products.boardgame_low, gs);
  gs.season = 'winter';
  const pWinter = purchaseProbability(makeCustomer(), CONFIG.products.boardgame_low, gs);
  assert.ok(pSpring > pWinter, '春季平价桌游热度 +0.3，冬季 -0.3');
});

test('setPrice clamp 到指导价 ±50%', () => {
  const gs = newGame(42);
  const guide = CONFIG.products.snacks.guidePrice; // 18
  assert.equal(setPrice(gs, 'snacks', 1), Math.round(guide * 0.5));
  assert.equal(setPrice(gs, 'snacks', 9999), Math.round(guide * 1.5));
  assert.equal(setPrice(gs, 'snacks', 20), 20);
  assert.equal(priceRatio(gs, 'snacks'), 20 / guide);
});

test('restock：扣现金、加库存、遵守上限与现金校验', () => {
  const gs = newGame(42);
  const rng = createRng(7);
  const cashBefore = gs.cash;
  // 2026-09 上限取消：999 件不再截断 → 整单价格超现金 → 整单拒绝；改小单正常
  const resBig = restock(gs, { snacks: 1, merch: 999 }, rng);
  assert.equal(resBig.ok, false, '999 件整单价格超现金 → 拒绝');
  assert.equal(gs.cash, cashBefore, '拒绝不扣款');
  const res = restock(gs, { snacks: 1, merch: 20 }, rng);
  assert.ok(res.ok);
  assert.equal(gs.inventory.snacks, CONFIG.initialInventory.snacks + 1);
  // v2：fulfilled 按 SKU 键返回（品类键 → 该品类默认 SKU）
  const merchSku = CONFIG.categoryDefaultSku.merch;
  assert.equal(res.fulfilled[merchSku], 20, '上限取消：fulfilled 全额');
  assert.equal(gs.cash, cashBefore - res.spent);
  assert.ok(Number.isInteger(gs.cash), '金额必须为整数');
  // 现金不足整单拒绝（截断到上限后仍付不起）
  gs.cash = 10;
  const res2 = restock(gs, { boardgame_high: 5 }, rng);
  assert.equal(res2.ok, false);
  assert.equal(gs.cash, 10, '拒绝时不应扣款');
});

test('restock：merch 进货可触发收藏掉落（固定种子可复现）', () => {
  const gs = newGame(42);
  gs.cash = 100000;
  const rng = createRng(123);
  restock(gs, { merch: 1 }, rng); // 消耗少量随机数
  const res = restock(gs, { merch: 200 }, rng);
  assert.ok(res.drops.length > 0, '200 件 merch 应至少掉落一件收藏');
  const owned = gs.collectibles.filter((c) => c.owned).length;
  assert.equal(owned, res.drops.length);
});

test('buyUpgrade：扣款、升级、上限与现金校验', () => {
  const gs = newGame(42);
  gs.cash = 5000;
  assert.equal(buyUpgrade(gs, 'experience'), true);
  assert.equal(gs.upgrades.experience, 2);
  assert.equal(gs.cash, 5000 - CONFIG.upgrades.costs[2]);
  gs.cash = 100;
  assert.equal(buyUpgrade(gs, 'shelf'), false, '现金不足应失败');
  gs.cash = 99999;
  buyUpgrade(gs, 'shelf');
  buyUpgrade(gs, 'shelf');
  assert.equal(buyUpgrade(gs, 'shelf'), false, '满级后不可再升');
});

test('dailyFootfall：声望/事件/活动周/传说周边加成', () => {
  const f = CONFIG.footfall;
  const influencerMult = CONFIG.events.find((e) => e.id === 'influencer').footfallMult;
  const gs = newGame(42);
  gs.activityDaysLeft = 0;
  const baseVal = f.base + gs.reputation / f.repDivisor;
  assert.equal(dailyFootfall(gs), Math.round(baseVal));
  gs.reputation = 50;
  const repVal = f.base + 50 / f.repDivisor;
  assert.ok(dailyFootfall(gs) > Math.round(baseVal), '声望提升应增加客流');
  assert.equal(dailyFootfall(gs), Math.round(repVal));
  gs.eventToday = 'influencer';
  assert.equal(dailyFootfall(gs), Math.round(repVal * influencerMult));
  gs.eventToday = null;
  gs.activityDaysLeft = 3;
  assert.equal(dailyFootfall(gs), Math.round(repVal * f.activityMult));
  gs.collectibles.find((c) => c.rarity === 'legendary').owned = true;
  assert.equal(dailyFootfall(gs), Math.round(repVal * f.activityMult * f.legendMult));
});

test('settleDay：租金按最高升级线、账单日扣款、声望结算', () => {
  const gs = newGame(42);
  assert.equal(rentFor(gs), 400);
  gs.upgrades.decor = 3;
  assert.equal(rentFor(gs), 800);
  gs.day = 7; // 账单日
  gs.today.revenue = 1000;
  gs.today.satisfactionSum = 6;
  const cashBefore = gs.cash;
  const report = settleDay(gs);
  assert.equal(report.rent, 800);
  assert.equal(gs.cash, cashBefore - 800);
  assert.equal(gs.reputation, 6);
  assert.equal(report.net, 1000);
  assert.equal(report.gameover, false);
});

test('settleDay：账单日现金为负 → GAMEOVER；声望 ≥100 → VICTORY', () => {
  const gs = newGame(42);
  gs.day = 7;
  gs.cash = 10; // 租金 400 → 现金转负
  const report = settleDay(gs);
  assert.equal(report.gameover, true);
  assert.equal(gs.phase, 'GAMEOVER');

  const gs2 = newGame(42);
  gs2.reputation = 96;
  gs2.today.satisfactionSum = 10;
  const report2 = settleDay(gs2);
  assert.equal(report2.victory, true);
  assert.equal(gs2.phase, 'VICTORY');
  assert.equal(gs2.reputation, 100);

  // 自由经营中不重复触发胜利
  const gs3 = newGame(42);
  gs3.freePlay = true;
  gs3.reputation = 100;
  gs3.phase = 'CLOSING';
  const report3 = settleDay(gs3);
  assert.equal(report3.victory, false);
  assert.equal(gs3.phase, 'CLOSING');
});
