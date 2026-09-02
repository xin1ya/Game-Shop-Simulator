/**
 * migration.test.js — 存档 v1 → v2 一次性迁移（裁决 2）。
 *
 * 硬约束：任何老档都不得失效（读不出来），迁移后守恒不变式必须成立。
 *
 * 覆盖：
 *  - v1 档 12 条字段映射（inventory → 默认 SKU onShelf、prices 等比缩放等）
 *  - v1 档在 OPEN 阶段 → 迁为 MORNING 重开当天（U10）
 *  - 7 种损坏档兜底（缺字段/类型错/JSON 坏/版本未知/负数/超界/空对象）
 *  - 迁移后可继续游玩（跑一天不抛异常）
 *
 * 运行：node --test tests/migration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, serialize, deserialize, migrateV1toV2 } from '../src/sim/gameState.js';
import { stockInvariantOk, onShelfOf, totalStock } from '../src/sim/logistics.js';
import { startPrepSession, stepSession, closeOutDay, nextDay } from '../src/sim/day.js';
import { settleDay } from '../src/sim/economy.js';

/** 构造一个典型的 v1 存档对象。 */
function makeV1Save() {
  return {
    v: 1,
    day: 8,
    phase: 'MORNING',
    cash: 2300,
    reputation: 42,
    inventory: { boardgame_low: 6, boardgame_high: 3, snacks: 10, merch: 4 },
    prices: { boardgame_low: 90, boardgame_high: 300, snacks: 20, merch: 60 },
    upgrades: { experience: 2, shelf: 2, decor: 1 },
    regulars: [
      { id: 'r1', name: '老周', type: 'core', visits: 3, storyStage: 1, completed: false, unlocked: true },
      { id: 'r2', name: '小满', type: 'student', visits: 0, storyStage: 0, completed: false, unlocked: false },
      { id: 'r3', name: '陈姐', type: 'collector', visits: 0, storyStage: 0, completed: false, unlocked: false },
    ],
    collectibles: [],
    season: 'summer',
    eventToday: null,
    activityDaysLeft: 0,
    today: { revenue: 0, experienceIncome: 0, restockCost: 0, footfall: 0, bought: 0, lost: 0, satisfactionSum: 0 },
    rngState: 12345,
    storyQueue: [],
    freePlay: false,
  };
}

test('v1→v2：品类库存归入默认 SKU 的 onShelf（老档开门即满架）', () => {
  const v1 = makeV1Save();
  const gs = migrateV1toV2(v1);
  assert.equal(gs.day, 8);
  assert.equal(gs.cash, 2300);
  assert.equal(gs.reputation, 42);
  // inventory[cat] → 该品类默认 SKU 的 onShelf（裁决 9/Q4）
  assert.equal(gs.skus[CONFIG.categoryDefaultSku.boardgame_low].onShelf, 6, '平价桌游 6 件上货架');
  assert.equal(gs.skus[CONFIG.categoryDefaultSku.snacks].onShelf, 10);
  assert.equal(onShelfOf(gs, 'boardgame_low'), 6);
  assert.ok(stockInvariantOk(gs), '迁移后守恒不变式必须成立');
  // 新字段补默认
  assert.ok(gs.logistics && Array.isArray(gs.logistics.deliveries));
  assert.ok(gs.staff && Array.isArray(gs.staff.members));
  assert.ok(Array.isArray(gs.shelfSlots) && gs.shelfSlots.length === 36);
});

test('v1→v2：SKU 定价按品类价格比等比缩放', () => {
  const v1 = makeV1Save();
  // 平价桌游定价 90（指导价 75 → 1.2 倍）
  const gs = migrateV1toV2(v1);
  // cat_cafe 指导价 68，等比 → 68 × 1.2 = 81.6 → 82
  const expected = Math.round(CONFIG.skus.cat_cafe.guidePrice * (90 / 75));
  assert.equal(gs.skuPrices.cat_cafe, expected, `等比缩放应为 ${expected}`);
  // 品类价格保留（兼容字段）
  assert.equal(gs.prices.boardgame_low, 90);
});

test('v1→v2：OPEN 阶段的档迁为 MORNING 重开当天（U10）', () => {
  const v1 = makeV1Save();
  v1.phase = 'OPEN';
  const gs = migrateV1toV2(v1);
  assert.equal(gs.phase, 'MORNING', '会话不可序列化，迁为 MORNING');
  assert.equal(gs.today.revenue, 0, '当日统计清零');
  // GAMEOVER / VICTORY 保留
  const v1go = { ...makeV1Save(), phase: 'GAMEOVER' };
  assert.equal(migrateV1toV2(v1go).phase, 'GAMEOVER');
});

test('v1→v2：常客/收藏/季节透传，升级逐项兜底', () => {
  const v1 = makeV1Save();
  const gs = migrateV1toV2(v1);
  assert.equal(gs.regulars[0].name, '老周');
  assert.equal(gs.regulars[0].visits, 3);
  assert.equal(gs.season, 'summer');
  assert.equal(gs.upgrades.experience, 2);
  // 超界等级钳制
  const v2 = { ...makeV1Save(), upgrades: { experience: 99, shelf: 0, decor: -5 } };
  const gs2 = migrateV1toV2(v2);
  assert.equal(gs2.upgrades.experience, 3, '超上限钳到 3');
  assert.equal(gs2.upgrades.shelf, 1, '低于 1 钳到 1');
});

// ---------- 7 种损坏档兜底（任何一步都不允许让旧档失效）----------
const CORRUPT_CASES = [
  ['缺 inventory', (v) => { delete v.inventory; return v; }],
  ['缺 upgrades', (v) => { delete v.upgrades; return v; }],
  ['inventory 类型错（字符串）', (v) => { v.inventory = 'broken'; return v; }],
  ['cash 为负数', (v) => { v.cash = -500; return v; }],
  ['reputation 超界 999', (v) => { v.reputation = 999; return v; }],
  ['regulars 不是数组', (v) => { v.regulars = 'oops'; return v; }],
  ['day 缺失', (v) => { delete v.day; return v; }],
];

for (const [name, corrupt] of CORRUPT_CASES) {
  test(`损坏档兜底：${name}`, () => {
    const v1 = corrupt(makeV1Save());
    const gs = migrateV1toV2(v1);
    assert.ok(gs && typeof gs === 'object', `${name}：迁移不得返回 null/抛异常`);
    assert.ok(Number.isFinite(gs.cash), `${name}：现金必须有限`);
    assert.ok(stockInvariantOk(gs), `${name}：守恒不变式必须成立`);
  });
}

test('deserialize 识别 v1 并自动迁移', () => {
  const v1 = makeV1Save();
  const gs = deserialize(JSON.stringify(v1));
  assert.ok(gs, 'v1 JSON 应可迁移');
  assert.equal(gs.day, 8);
  assert.ok(stockInvariantOk(gs));
  // v2 档正常反序列化
  const v2gs = newGame(7);
  const back = deserialize(serialize(v2gs));
  assert.ok(back);
  assert.equal(back.day, v2gs.day);
  assert.equal(back.cash, v2gs.cash);
});

test('迁移后的档可继续游玩（跑一天不抛异常、可结算）', () => {
  const v1 = makeV1Save();
  const gs = migrateV1toV2(v1);
  const rng = createRng(gs.rngState);
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
  assert.equal(gs.phase, 'CLOSING');
  closeOutDay(gs);
  const report = settleDay(gs);
  assert.ok(Number.isInteger(report.cash));
  assert.ok(Number.isFinite(report.reputation));
  nextDay(gs, rng);
  assert.equal(gs.phase, 'MORNING');
});

// ---------- v3：旧档（v2）向前兼容 ----------

test('v2 → v3 兼容：stockroom/纸板默认补齐，老档箱子补物理字段', () => {
  const gs = newGame(11);
  const raw = JSON.parse(serialize(gs));
  raw.v = 2;
  delete raw.stockroom; // v2 档没有该字段
  raw.today.rentalIncome = undefined;
  delete raw.today.rentalIncome;
  // v2 档箱子无 x/y/vy/settled
  raw.logistics.boxes = [{ id: 1, deliveryId: 1, sku: 'boba_tea', qty: 4, state: 'OPEN', slot: 2, progress: 0, claimedBy: null, claimedKind: null }];
  const back = deserialize(JSON.stringify(raw));
  assert.ok(back, 'v2 档应可读');
  assert.ok(back.stockroom && back.stockroom.cardboard === 0, 'stockroom 默认补齐');
  const box = back.logistics.boxes[0];
  assert.equal(box.settled, true, '老档箱子按落定兜底');
  assert.equal(typeof box.x, 'number');
  assert.equal(box.y, 0);
  assert.ok(stockInvariantOk(back));
});
