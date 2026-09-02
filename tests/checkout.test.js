/**
 * checkout.test.js — v3 需求 4/5：找零小游戏数据 + 桌游租用 单元测试。
 *
 * 运行：node --test tests/checkout.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { newGame } from '../src/sim/gameState.js';
import { createRng } from '../src/rng.js';
import {
  checkoutBillFor, checkoutChange, rentFeeOf, buyExpansion, experienceSlots,
} from '../src/sim/economy.js';
import { effectiveBounds, buildObstacles } from '../src/scene/firstPerson.js';

const FP = CONFIG.firstPerson;
import { getCheckoutOrder } from '../src/sim/day.js';
import { spawnCustomer, stepCustomer, completePurchase } from '../src/sim/customers.js';
import { grantStock, stockInvariantOk } from '../src/sim/logistics.js';

function setup() {
  return { gs: newGame(42), rng: createRng(42) };
}

// ---------- 找零数学 ----------

test('checkoutBillFor：最小整钞面额', () => {
  assert.equal(checkoutBillFor(1), 50);
  assert.equal(checkoutBillFor(50), 50);
  assert.equal(checkoutBillFor(51), 100);
  assert.equal(checkoutBillFor(210), 500);
  assert.equal(checkoutBillFor(500), 500);
  assert.equal(checkoutBillFor(501), 600);
  assert.equal(checkoutBillFor(888), 900);
});

test('checkoutChange：找零 = 实收 - 应收', () => {
  assert.equal(checkoutChange(68, 100), 32);
  assert.equal(checkoutChange(50, 50), 0);
});

// ---------- 订单数据源 ----------

test('getCheckoutOrder：队首待结订单（清单/总额/面额/找零）', () => {
  const { gs } = setup();
  const session = { queue: [7], customers: [], paySlots: [] };
  session.customers.push({
    id: 7, state: 'QUEUED', targetSku: 'cat_cafe',
  });
  const order = getCheckoutOrder(gs, session);
  assert.ok(order);
  assert.equal(order.customerId, 7);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].skuId, 'cat_cafe');
  assert.equal(order.total, gs.skuPrices.cat_cafe);
  assert.ok(order.bill >= order.total);
  assert.equal(order.change, order.bill - order.total);
});

test('getCheckoutOrder：无队首/无目标 SKU → null', () => {
  const { gs } = setup();
  assert.equal(getCheckoutOrder(gs, { queue: [], customers: [] }), null);
  assert.equal(getCheckoutOrder(gs, {
    queue: [3], customers: [{ id: 3, state: 'QUEUED', targetSku: null }],
  }), null);
});

test('找零答错（changeWrong）：成交满意度封顶 0（不奖不罚）', () => {
  const { gs } = setup();
  grantStock(gs, 'boba_tea', 'onShelf', 4);
  const c = spawnCustomer(gs, createRng(1), 'student');
  c.targetSku = 'boba_tea';
  c.changeWrong = true;
  const session = { queue: [], customers: [], needs: [], needQueue: [] };
  const sat0 = gs.today.satisfactionSum;
  completePurchase(c, session, gs);
  assert.equal(c.satisfaction, 0, '答错后满意度 0');
  void sat0;
  assert.ok(gs.today.revenue > 0, '收入照常');
});

// ---------- 桌游租用 ----------

test('租用全路径：入座收租金 → 玩完归还上架 → 不占用售出', () => {
  const { gs, rng } = setup();
  for (const id of CONFIG.skuOrder) gs.skus[id].onShelf = 0;
  gs.shelfSlots.forEach((s) => { s.sku = null; s.qty = 0; });
  grantStock(gs, 'cat_cafe', 'onShelf', 4);
  const session = {
    queue: [], customers: [], needs: [], needQueue: [], expSlots: [null],
  };
  const c = spawnCustomer(gs, rng, 'student');
  c.rentSku = 'cat_cafe';
  c.state = 'TO_EXPERIENCE';
  c.timer = 0;
  const onShelfBefore = gs.skus.cat_cafe.onShelf;
  const rentFee = rentFeeOf(gs, 'cat_cafe');
  assert.ok(rentFee >= CONFIG.rental.minFee);
  const cash0 = gs.cash;
  // 入座：收租金
  stepCustomer(c, session, gs, rng, 0.1);
  assert.equal(c.state, 'EXPERIENCING');
  assert.equal(gs.today.rentalIncome, rentFee, '租金入 rentalIncome');
  assert.equal(gs.cash, cash0 + rentFee);
  // 玩完：归还上架
  c.timer = 0;
  stepCustomer(c, session, gs, rng, 0.1);
  assert.equal(c.rentSku, null, '归还后 rentSku 清空');
  assert.equal(c.state, 'LEAVING');
  assert.equal(gs.skus.cat_cafe.onShelf, onShelfBefore + 1, '归还后回填上架');
  assert.equal(gs.skus.cat_cafe.soldTotal, 0, '租出不计售出');
  assert.ok(stockInvariantOk(gs));
});

test('租用分流：boardgame 顾客概率走租用（种子内统计稳定）', () => {
  const { gs, rng } = setup();
  grantStock(gs, 'cat_cafe', 'onShelf', 36);
  const session = {
    queue: [], customers: [], needs: [], needQueue: [], expSlots: [null, null, null, null],
  };
  let rented = 0;
  let checkout = 0;
  for (let i = 0; i < 120; i += 1) {
    const c = spawnCustomer(gs, rng, 'student');
    c.target = 'boardgame_low';
    c.budget = 9999; // 必买得起
    c.state = 'BROWSING';
    c.timer = 0;
    stepCustomer(c, session, gs, rng, 0.1);
    if (c.rentSku) {
      rented += 1;
      // 立刻归还，避免占库存
      c.rentSku = null;
      grantStock(gs, 'cat_cafe', 'onShelf', 1);
    } else if (c.state === 'TO_CHECKOUT') {
      checkout += 1;
      grantStock(gs, 'cat_cafe', 'onShelf', 1); // 补回被取走的
    }
    // 非租用非购买（概率未中）：走到 maybeExperienceOrLeave，不干预
  }
  assert.ok(rented > 0, `学生党应出现租用（120 人中 ${rented} 租）`);
  assert.ok(checkout > 0, '同时保留购买通道');
  assert.ok(rented < 120, '不应全部租用');
});

// ---------- 2026-09 店铺扩张 ----------

test('buyExpansion：购买扣款生效、重复购买拒绝、现金不足拒绝', () => {
  const { gs } = setup();
  gs.cash = 3000;
  assert.equal(buyExpansion(gs, 'wing_right'), false, '现金不足拒绝');
  gs.cash = 20000;
  assert.equal(buyExpansion(gs, 'wing_right'), true);
  assert.equal(gs.cash, 14000);
  assert.equal(buyExpansion(gs, 'wing_right'), false, '不可重复购买');
  assert.equal(buyExpansion(gs, 'stockroom_plus'), true);
  assert.equal(buyExpansion(gs, 'loft'), true);
  assert.equal(gs.reputation, 10, 'loft 声望 +10');
});

test('收购右邻铺：体验位 +2、行走域覆盖翼房、翼房障碍生效', () => {
  const { gs } = setup();
  gs.cash = 20000;
  const base = experienceSlots(gs);
  buyExpansion(gs, 'wing_right');
  assert.equal(experienceSlots(gs), base + 2, '翼房 +2 体验位');
  assert.equal(effectiveBounds().maxX, 12.0, '2026-09 全街 maxX=12（覆盖翼房 x 至 11.45）');
  assert.equal(effectiveBounds(gs).maxX, 12.0, '收购后行走域保持 12（翼房形状由障碍约束）');
  const obs = buildObstacles(FP, { tableCount: 6, decorLevel: 1, wingRight: true });
  // 翼房东墙存在
  assert.ok(obs.some((o) => o.minX >= 11.4), '翼房东墙障碍存在');
  // 右墙门洞（z=-1）无遮挡
  const gap = { x: 6.9, z: -1 };
  assert.ok(!obs.some((o) => gap.x > o.minX && gap.x < o.maxX && gap.z > o.minZ && gap.z < o.maxZ),
    '翼房门洞应常通');
});

test('库房扩容：纸板上限 ×2（stockroom_plus）', () => {
  const { gs } = setup();
  gs.cash = 20000;
  const capBefore = ((gs.expansion && gs.expansion.stockroom_plus) ? 2 : 1) * CONFIG.stockroom.cardboardCap;
  assert.equal(capBefore, 50);
  buyExpansion(gs, 'stockroom_plus');
  const capAfter = ((gs.expansion && gs.expansion.stockroom_plus) ? 2 : 1) * CONFIG.stockroom.cardboardCap;
  assert.equal(capAfter, 100, '扩容后纸板上限 ×2');
});
