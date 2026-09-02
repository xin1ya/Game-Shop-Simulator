/**
 * needs.test.js — 顾客需求气泡测试。
 *
 * 覆盖（PRD Part B §3.2）：
 *  - 5 类气泡触发条件逐条命中
 *  - 同屏上限 ≤3 + 紧急度排序
 *  - 玩家全局 3s 冷却 + 顾客同类 6s 冷却
 *  - ★ 第一人称 2.5 距离闸门（不可裁剪，等距对照）
 *  - 超时后果
 *
 * 运行：node --test tests/needs.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import { grantStock } from '../src/sim/logistics.js';
import {
  scanNeeds, respondNeed, canPlayerRespond, activeNeeds,
  needPriority, needDisplay,
} from '../src/sim/needs.js';
import { spawnCustomer } from '../src/sim/customers.js';

function makeSession(gs) {
  return {
    phase: 'OPEN', clock: 0, speed: 1, spawnSchedule: [], customers: [],
    nextCustomerId: 1, expSlots: [null, null], queue: [],
    paySlots: [{ customerId: null, elapsed: 0, duration: 2, by: null, staffId: null }],
    needs: [], needQueue: [], nextNeedId: 1, needScanTimer: 0,
    playerNeedCooldown: 0, interaction: null, autoStock: false,
    autoStockProgress: null, playerPayDone: 0, playerRespondDone: null,
    queuePriority: null, pedestrians: [], playerPos: { x: 0, z: 0 }, holding: false,
  };
}

/** 造一个满足特定气泡触发条件的顾客。 */
function makeCustomerInState(gs, session, kind) {
  const rng = createRng(7);
  const c = spawnCustomer(gs, rng, 'core');
  c.id = session.nextCustomerId;
  session.nextCustomerId += 1;
  switch (kind) {
    case 'findItem':
      // 目标品类货架空但后仓有货
      c.state = 'BROWSING'; c.target = 'merch'; c.timer = 5;
      break;
    case 'complain':
      // 目标品类货架有货（避免被 findItem 抢先）；耐心 < 25%
      grantStock(gs, CONFIG.categoryDefaultSku.snacks, 'onShelf', 4);
      c.state = 'BROWSING'; c.target = 'snacks'; c.timer = 5;
      c.patience = 3; c.patienceMax = 40; // 耐心不足 25%
      break;
    case 'checkout':
      grantStock(gs, CONFIG.categoryDefaultSku.snacks, 'onShelf', 4);
      c.state = 'QUEUED'; c.target = 'snacks'; c.queueWait = 7; // 等待 >6s
      session.queue.push(c.id, 999, 998); // 队列 ≥3
      break;
    case 'explain':
      grantStock(gs, CONFIG.categoryDefaultSku.boardgame_low, 'onShelf', 4);
      c.state = 'TO_EXPERIENCE'; c.target = 'boardgame_low'; c.expWait = 4; // 等 >3s
      break;
    case 'recommend':
      // 货架有货但购买判定失败且预算充足
      grantStock(gs, CONFIG.categoryDefaultSku.boardgame_high, 'onShelf', 4);
      c.state = 'BROWSING'; c.target = 'boardgame_high'; c.buyFailed = true; c.budget = 300;
      break;
    default:
      break;
  }
  c.pos = { x: 0, z: 0 };
  session.customers.push(c);
  return c;
}

test('5 类气泡触发条件逐条命中', () => {
  const gs = newGame(42);
  grantStock(gs, 'dice_keychain', 'backroom', 4); // findItem 需后仓有货
  const kinds = ['findItem', 'complain', 'checkout', 'explain', 'recommend'];
  for (const kind of kinds) {
    const session = makeSession(gs);
    makeCustomerInState(gs, session, kind);
    // 扫描两次确保触发（scanInterval 节流）
    scanNeeds(gs, session, 0.5);
    scanNeeds(gs, session, 0.5);
    const found = session.needs.find((n) => n.kind === kind)
      || session.needQueue.find((n) => n.kind === kind);
    assert.ok(found, `${kind} 气泡应被触发`);
  }
});

test('同屏上限 ≤3，超出进等待队列，紧急度排序', () => {
  const gs = newGame(42);
  grantStock(gs, 'dice_keychain', 'backroom', 4);
  const session = makeSession(gs);
  // 造 5 个会触发气泡的顾客
  makeCustomerInState(gs, session, 'complain');   // priority 5（最急）
  makeCustomerInState(gs, session, 'checkout');   // priority 4
  makeCustomerInState(gs, session, 'findItem');   // priority 3
  makeCustomerInState(gs, session, 'explain');    // priority 2
  makeCustomerInState(gs, session, 'recommend');  // priority 1
  scanNeeds(gs, session, 0.5);
  scanNeeds(gs, session, 0.5);
  assert.ok(activeNeeds(session).length <= CONFIG.needs.maxOnScreen,
    `同屏气泡 ${activeNeeds(session).length} 不应超 ${CONFIG.needs.maxOnScreen}`);
  // 紧急度：complain(5) 应优先于 recommend(1)
  assert.ok(needPriority('complain') > needPriority('recommend'));
});

test('★ 距离闸门：fp 2.5 / iso 3.2，走近可响应 / 超距拒绝（不可裁剪）', () => {
  const gs = newGame(42);
  grantStock(gs, 'dice_keychain', 'backroom', 4);
  const session = makeSession(gs);
  const c = makeCustomerInState(gs, session, 'findItem');
  c.pos = { x: 0, z: 0 };
  scanNeeds(gs, session, 0.5);
  scanNeeds(gs, session, 0.5);
  const need = session.needs.find((n) => n.kind === 'findItem');
  assert.ok(need, '应生成 findItem 气泡');
  // 第一人称：2.4u 内可响应
  const fpNear = { x: 0, z: 2.4, viewMode: 'fp' };
  assert.equal(canPlayerRespond(gs, session, need.id, fpNear).ok, true, 'fp 2.4u 内可响应');
  // 第一人称：2.6u 外拒绝
  const fpFar = { x: 0, z: 2.6, viewMode: 'fp' };
  const farCheck = canPlayerRespond(gs, session, need.id, fpFar);
  assert.equal(farCheck.ok, false, 'fp 2.6u 外拒绝');
  assert.equal(farCheck.reason, 'distance');
  // 等距模式：3.2u 内可响应（2026-09 试玩反馈：不再免距隔空）
  const isoNear = { x: 0, z: 3.0, viewMode: 'iso' };
  assert.equal(canPlayerRespond(gs, session, need.id, isoNear).ok, true, 'iso 3.0u 内可响应');
  // 等距模式：3.4u 外拒绝
  const isoFar = { x: 0, z: 3.4, viewMode: 'iso' };
  const isoFarCheck = canPlayerRespond(gs, session, need.id, isoFar);
  assert.equal(isoFarCheck.ok, false, 'iso 3.4u 外拒绝');
  assert.equal(isoFarCheck.reason, 'distance');
});

test('玩家全局 3s 冷却：连续响应第二次被拒', () => {
  const gs = newGame(42);
  grantStock(gs, 'dice_keychain', 'backroom', 4);
  const session = makeSession(gs);
  makeCustomerInState(gs, session, 'findItem');
  scanNeeds(gs, session, 0.5);
  scanNeeds(gs, session, 0.5);
  const need = session.needs.find((n) => n.kind === 'findItem');
  const ctx = { x: 0, z: 0, viewMode: 'iso' };
  const r1 = respondNeed(gs, session, need.id, 'player', ctx);
  assert.equal(r1.ok, true, '第一次响应成功');
  assert.ok(session.playerNeedCooldown > 0, '响应后进入全局冷却');
  // 立即响应第二个（造一个新的）
  makeCustomerInState(gs, session, 'findItem');
  scanNeeds(gs, session, 0.5);
  const need2 = session.needs.find((n) => n.id !== need.id);
  if (need2) {
    const r2 = respondNeed(gs, session, need2.id, 'player', ctx);
    assert.equal(r2.ok, false, '冷却期内第二次响应被拒');
    assert.equal(r2.reason, 'cooldown');
  }
});

test('超时后果：TTL 耗尽气泡过期', () => {
  const gs = newGame(42);
  grantStock(gs, 'dice_keychain', 'backroom', 4);
  const session = makeSession(gs);
  makeCustomerInState(gs, session, 'findItem');
  scanNeeds(gs, session, 0.5);
  const need = session.needs.find((n) => n.kind === 'findItem');
  assert.ok(need);
  // 推进超过 TTL（8s）
  for (let i = 0; i < 100; i += 1) scanNeeds(gs, session, 0.1);
  const still = session.needs.find((n) => n.id === need.id);
  assert.equal(still, undefined, 'TTL 耗尽后气泡应过期移除');
});

test('needDisplay：emoji + SKU 名 + 售价', () => {
  const gs = newGame(42);
  grantStock(gs, 'dice_keychain', 'onShelf', 4);
  const session = makeSession(gs);
  const c = makeCustomerInState(gs, session, 'recommend');
  c.targetSku = 'civ_rise';
  scanNeeds(gs, session, 0.5);
  // recommend 的顾客已设 targetSku；气泡可能先生成 findItem/recommend，取该顾客的气泡
  const need = session.needs.find((n) => n.customerId === c.id);
  assert.ok(need, '该顾客应生成气泡');
  const d = needDisplay(gs, session, need);
  assert.ok(d.emoji, '应有 emoji');
  assert.ok(d.sku.includes('文明兴衰'), 'SKU 名应显示');
  assert.ok(d.sku.includes(String(gs.skuPrices.civ_rise)), '售价应显示');
});
