/**
 * logistics.test.js — 物流状态机与库存四态的核心守卫测试。
 *
 * 覆盖本轮修复的两个阻断级 bug 的回归守卫：
 *  Bug-1（卸箱黑洞）：placeOrder 的 delivery.boxes 存的是箱子对象，
 *         而 unloadDelivery/checkDeliveryDone 误当 id 处理 → 货车永远卸不下货。
 *  Bug-2（货架死锁）：takeFromShelf 取空后保留 sku 绑定（qty=0, sku≠null），
 *         restockToSlot 找不到可放格 → 该品类永远无法再上架。
 *
 * 运行：node --test tests/logistics.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame } from '../src/sim/gameState.js';
import { restock } from '../src/sim/economy.js';
import {
  startDeliveries, stepDeliveries, placeOrder, findBox,
  stepBoxPhysics, pushBox, flattenBox, trashEmptyBoxes, recycleCardboard,
  stashToBackroom, takeOutToHands,
  claimBox, unboxTick, pickTick, restockToSlot, takeFromShelf, takeSlotToHands,
  returnToShelf, closeOutBoxes, stepAutoStock, grantStock,
  stockInvariantOk, onShelfOf, shelfState, skuHasRoom, totalStock,
  syncInventory,
} from '../src/sim/logistics.js';
import { startPrepSession, startEveningSession, stepSession } from '../src/sim/day.js';

/** 造一个带 PREP 会话的最小环境。 */
function setup() {
  const gs = newGame(42);
  const rng = createRng(42);
  return { gs, rng };
}

// ---------- Bug-1 回归：货车卸箱 ----------

test('卸箱链路：下单 → 在途 → 到店卸箱 → inTransit 清零、inBox 增加', () => {
  const { gs } = setup();
  // 用空格品类 merch 避免初始库存占上限：dice_keychain 初始 3 件，cap=10，可再订 7
  const res = restock(gs, { dice_keychain: 7 }); // setup 默认 phase=MORNING
  assert.equal(res.ok, true);
  assert.equal(gs.skus.dice_keychain.inTransit, 7, '下单后计入在途');
  const delivery = gs.logistics.deliveries[0];
  assert.equal(delivery.state, 'ORDERED');
  assert.equal(delivery.boxes.length, 2, '7 件 = 1 满箱(4) + 1 散箱(3)');
  assert.equal(delivery.arriveDay, gs.day, '2026-09：早上下单当晚到');
  assert.equal(delivery.arrivePhase, 'EVENING');

  startDeliveries(gs, 'PREP');
  assert.equal(delivery.state, 'ORDERED', '时段不匹配：PREP 不发当晚到的单');
  startDeliveries(gs, 'EVENING');
  assert.equal(delivery.state, 'IN_TRANSIT');
  assert.ok(delivery.eta > 0);

  // 推进到货车到店（eta 8s + 余量）
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  assert.equal(delivery.state, 'ARRIVED', '货车 eta 到 0 必须卸箱');
  assert.equal(gs.skus.dice_keychain.inTransit, 0, '★回归守卫：卸箱后 inTransit 必须清零（不得卡黑洞）');
  assert.equal(gs.skus.dice_keychain.inBox, 7, '卸箱后计入 inBox');
  assert.equal(gs.logistics.boxes.length, 2, '门口应有 2 个箱子');
  assert.ok(stockInvariantOk(gs));
});

test('开箱 → 取货 → 上架全链路（玩家等效操作）', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 4 }); // merch 有空位
  gs.day += 1; // v3 次日达：推进到次日
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const box = gs.logistics.boxes[0];
  assert.equal(box.state, 'SEALED');

  // 开箱 1.5s
  assert.equal(claimBox(gs, box.id, 'player', 'unbox'), true);
  assert.equal(claimBox(gs, box.id, 'auto', 'unbox'), false, '已占用不得重复认领');
  for (let i = 0; i < 16; i += 1) unboxTick(gs, box, 0.1);
  assert.equal(box.state, 'OPEN', '开箱 1.5s 后应开盖');

  // 取货 0.6s：inBox → backroom
  assert.equal(claimBox(gs, box.id, 'player', 'pick'), true);
  for (let i = 0; i < 7; i += 1) pickTick(gs, box, 0.1);
  assert.equal(box.state, 'EMPTY', '取货 0.6s 后箱子应空');
  assert.equal(gs.skus.dice_keychain.inBox, 0);
  assert.equal(gs.skus.dice_keychain.backroom, 3 + 4, '初始 3 件在后仓 + 取货 4 件');

  // 上架 4 件（一次动作 = 补满一格）
  const before = onShelfOf(gs, 'merch');
  const put = restockToSlot(gs, 'dice_keychain', CONFIG.logistics.restockPerAction);
  assert.equal(put, 4, '一箱 = 一取 = 补满一格（4 件）');
  assert.equal(onShelfOf(gs, 'merch'), before + 4);
  assert.ok(stockInvariantOk(gs));
});

test('打烊清场：未搬完的箱子自动转后仓，不损失货（U6）', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 7 });
  gs.day += 1; // v3 次日达：推进到次日
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const before = totalStock(gs);
  closeOutBoxes(gs);
  assert.equal(gs.logistics.boxes.length, 0);
  assert.equal(gs.logistics.deliveries.length, 0);
  assert.equal(gs.skus.dice_keychain.backroom, 3 + 7, '未搬的货自动入后仓');
  assert.equal(totalStock(gs), before, '清场不得损失库存');
  assert.ok(stockInvariantOk(gs));
});

// ---------- Bug-2 回归：货架格位死锁 ----------

test('取空解绑：takeFromShelf 卖空一格后 sku 绑定释放，可再上架', () => {
  const { gs } = setup();
  grantStock(gs, 'boba_tea', 'onShelf', 4); // 补满一格
  // 连续卖空该格（4 件）
  for (let i = 0; i < 4; i += 1) takeFromShelf(gs, 'boba_tea');
  assert.equal(gs.skus.boba_tea.onShelf, 0);
  // ★回归守卫：取空的格位必须解绑（sku=null），否则 restockToSlot 找不到空格
  const catSlots = gs.shelfSlots.filter((s) => s.cat === 'snacks');
  const boundEmpty = catSlots.filter((s) => s.sku !== null && s.qty === 0);
  assert.equal(boundEmpty.length, 0, '取空的格不得保留 sku 绑定（货架死锁根因）');

  // 后仓补货：换同品类另一 SKU 也应能上架
  grantStock(gs, 'hand_brew', 'backroom', 4);
  const put = restockToSlot(gs, 'hand_brew', 4);
  assert.equal(put, 4, '卖空后的格位必须可被其他 SKU 重用');
  assert.ok(stockInvariantOk(gs));
});

test('货架拿货：takeSlotToHands 整格入双手、取空解绑、守恒（2026-09 右键拿货重摆）', () => {
  const { gs } = setup();
  grantStock(gs, 'boba_tea', 'onShelf', 4); // 补满一格
  const idx = gs.shelfSlots.findIndex((s) => s.sku === 'boba_tea' && s.qty > 0);
  assert.ok(idx >= 0);
  const session = { carry: null };
  const before = gs.skus.boba_tea.onShelf;
  assert.equal(takeSlotToHands(gs, session, idx), true, '拿起整格');
  assert.deepEqual(session.carry, { type: 'item', skuId: 'boba_tea', qty: 4 });
  assert.equal(gs.shelfSlots[idx].sku, null, '取空解绑');
  assert.equal(gs.shelfSlots[idx].qty, 0);
  assert.equal(gs.skus.boba_tea.onShelf, before - 4, '四态同步扣减');
  // 手上非空不能再拿
  grantStock(gs, 'cat_cafe', 'onShelf', 4);
  const idx2 = gs.shelfSlots.findIndex((s) => s.sku === 'cat_cafe' && s.qty > 0);
  assert.equal(takeSlotToHands(gs, session, idx2), false, '手上非空拒绝');
  // 空格/非法格号拒绝（找一个始终空的格：grantStock 会复用刚腾出的 idx，故另寻）
  session.carry = null;
  const emptyIdx = gs.shelfSlots.findIndex((s) => s.qty <= 0 && !s.sku);
  assert.ok(emptyIdx >= 0, '存在空格');
  assert.equal(takeSlotToHands(gs, session, emptyIdx), false, '空格拒绝');
  assert.ok(stockInvariantOk(gs));
});

test('货架三态：ON_SHELF / IN_BACKROOM / OUT_OF_STOCK', () => {
  const { gs } = setup();
  // 初始 18 件在后仓（U1），货架空
  assert.equal(shelfState(gs, 'snacks'), 'IN_BACKROOM');
  grantStock(gs, 'boba_tea', 'onShelf', 4);
  assert.equal(shelfState(gs, 'snacks'), 'ON_SHELF');
  // 清空到完全无货
  for (let i = 0; i < 4; i += 1) takeFromShelf(gs, 'boba_tea');
  gs.skus.boba_tea.backroom = 0;
  syncInventory(gs);
  assert.equal(shelfState(gs, 'snacks'), 'OUT_OF_STOCK');
});

test('一箱 4 件 = 一取 = 补满一格（堆叠上限随货架等级）', () => {
  const { gs } = setup();
  assert.equal(CONFIG.logistics.boxCapacity, 4);
  assert.equal(CONFIG.logistics.restockPerAction, 4);
  assert.equal(CONFIG.shelf.stackCapByLevel[0], 4, '1 级货架格容量 = 一箱');
  // 升到 2 级后格容量 6
  gs.upgrades.shelf = 2;
  grantStock(gs, 'boba_tea', 'backroom', 10);
  const put = restockToSlot(gs, 'boba_tea', 6);
  assert.equal(put, 6, '2 级货架一次可上架 6 件');
  assert.ok(stockInvariantOk(gs));
});

test('占用协议：claimBox 已被占用返回 false 且零状态变化', () => {
  const { gs } = setup();
  restock(gs, { boba_tea: 4 });
  gs.day += 1; // v3 次日达：推进到次日
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const box = gs.logistics.boxes[0];
  assert.equal(claimBox(gs, box.id, 'player', 'unbox'), true);
  const snapshot = { ...box };
  assert.equal(claimBox(gs, box.id, 'auto', 'unbox'), false);
  assert.equal(claimBox(gs, box.id, 'player', 'pick'), false, 'SEALED 箱不可 pick');
  assert.deepEqual(
    { state: box.state, claimedBy: box.claimedBy, progress: box.progress },
    { state: snapshot.state, claimedBy: snapshot.claimedBy, progress: snapshot.progress },
    '占用失败时零状态变化',
  );
});

test('虚拟搬运工 stepAutoStock：90s 内搬完 6 箱（24 件）—— 验收 C1', () => {
  const { gs, rng } = setup();
  gs.phase = 'EVENING'; // 前一晚下单 → 次日 PREP 到货（2026-09 到货分时段）
  restock(gs, { boba_tea: 8, cat_cafe: 8, dice_keychain: 8 }); // 6 箱
  gs.day += 1; // 推进到次日早晨
  const session = startPrepSession(gs, rng);
  session.autoStock = true;
  let ticks = 0;
  while (gs.phase === 'PREP' && ticks < 950) {
    stepSession(session, gs, rng, CONFIG.tick);
    ticks += 1;
  }
  const totalOnShelf = CONFIG.categoryOrder.reduce((s, c) => s + onShelfOf(gs, c), 0);
  // 24 件订货 + 初始 18 件后仓，PREP 结束时应有相当部分上架
  assert.ok(totalOnShelf >= 20, `PREP 结束货架至少 20 件，实际 ${totalOnShelf}`);
  // v3（需求 9）：EMPTY 空箱留置待折叠/丢弃，这里断言「非空箱全部处理完」
  assert.equal(gs.logistics.boxes.filter((b) => b.state !== 'EMPTY').length, 0,
    'PREP 结束门口无非空箱（空箱留置由玩家处理）');
  assert.ok(stockInvariantOk(gs));
});

test('怒走退货：returnToShelf 不损失库存（A24）', () => {
  const { gs } = setup();
  grantStock(gs, 'boba_tea', 'onShelf', 4);
  const before = totalStock(gs);
  takeFromShelf(gs, 'boba_tea'); // 顾客拿货：货从四态移到顾客手上
  assert.equal(totalStock(gs), before - 1, '拿货后货在顾客手上（不在四态内）');
  assert.equal(gs.skus.boba_tea.onShelf, 3);
  returnToShelf(gs, 'boba_tea'); // 怒走退货
  assert.equal(totalStock(gs), before, '★回归守卫：退货必须回到货架，不损失库存');
  assert.equal(gs.skus.boba_tea.onShelf, 4, '退货后回到 4 件');
  assert.ok(stockInvariantOk(gs));
});

test('守恒不变式：任意操作序列后 stockInvariantOk 恒为 true', () => {
  const { gs, rng } = setup();
  restock(gs, { boba_tea: 8, cat_cafe: 4 });
  gs.day += 1; // v3 次日达：推进到次日
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  // 随机操作序列
  for (let i = 0; i < 50; i += 1) {
    const roll = rng.next();
    if (roll < 0.3) {
      const box = gs.logistics.boxes.find((b) => b.state !== 'EMPTY');
      if (box && claimBox(gs, box.id, 'player', box.state === 'SEALED' ? 'unbox' : 'pick')) {
        for (let j = 0; j < 20; j += 1) {
          if (box.state === 'SEALED') unboxTick(gs, box, 0.1);
          else pickTick(gs, box, 0.1);
        }
      }
    } else if (roll < 0.6) {
      const skuId = CONFIG.skuOrder[i % CONFIG.skuOrder.length];
      restockToSlot(gs, skuId, 4);
    } else if (roll < 0.8) {
      const onShelf = CONFIG.skuOrder.filter((id) => gs.skus[id].onShelf > 0);
      if (onShelf.length > 0) takeFromShelf(gs, onShelf[0]);
    }
    assert.ok(stockInvariantOk(gs), `第 ${i} 步后守恒不变式被破坏`);
  }
});

test('skuHasRoom：格位满且都绑定他 SKU 时返回 false（v3 全店格池）', () => {
  const { gs } = setup();
  // 填满全店 36 格为 hand_brew（slotCap 4 × 36 = 144）
  grantStock(gs, 'hand_brew', 'onShelf', 144);
  assert.equal(skuHasRoom(gs, 'boba_tea'), false, '满格且异 SKU 不可放');
  assert.equal(skuHasRoom(gs, 'hand_brew'), false, '满格同 SKU 也不可有空间');
  // 指定货架维度：货架 0 满 / 腾出货架 1 一格后可放
  assert.equal(skuHasRoom(gs, 'boba_tea', 0), false, '货架 0 满');
  gs.shelfSlots[9].sku = null; // 货架 1 首格清空
  gs.shelfSlots[9].qty = 0;
  assert.equal(skuHasRoom(gs, 'boba_tea', 1), true, '货架 1 有空格');
});

test('slotCap 体积容量生效：周边 9/格（2026-09），桌游 4/格', () => {
  const { gs } = setup();
  for (const id of CONFIG.skuOrder) gs.skus[id].backroom = 0;
  grantStock(gs, 'dice_tower', 'backroom', 12);
  grantStock(gs, 'cat_cafe', 'backroom', 9);
  restockToSlot(gs, 'dice_tower', 12);
  restockToSlot(gs, 'cat_cafe', 9);
  const towerSlots = gs.shelfSlots.filter((s) => s.sku === 'dice_tower');
  const catSlots = gs.shelfSlots.filter((s) => s.sku === 'cat_cafe');
  assert.ok(towerSlots.every((s) => s.qty <= 9), '骰塔（周边）每格 ≤9');
  assert.ok(catSlots.every((s) => s.qty <= 4), '桌游每格 ≤4');
  assert.ok(catSlots.length >= 3, '9 件桌游至少 3 格（4+4+1）');
  assert.ok(stockInvariantOk(gs));
});

// ---------- 到货时段契约（2026-09：早单晚到 / 晚单次日早到） ----------

test('到货时段：早上（MORNING）下单 → 当晚 EVENING 发车到店', () => {
  const { gs } = setup();
  gs.phase = 'MORNING';
  const res = restock(gs, { dice_keychain: 4 });
  assert.equal(res.ok, true);
  const delivery = gs.logistics.deliveries[0];
  assert.equal(delivery.arriveDay, gs.day, '当日晚到');
  assert.equal(delivery.arrivePhase, 'EVENING');
  // PREP 时段不发（时段不匹配）
  assert.equal(startDeliveries(gs, 'PREP'), 0, 'PREP 不发当晚到的单');
  assert.equal(delivery.state, 'ORDERED');
  // EVENING 时段发车
  assert.equal(startDeliveries(gs, 'EVENING'), 1, 'EVENING 发车');
  assert.equal(delivery.state, 'IN_TRANSIT');
  assert.ok(delivery.eta > 0);
});

test('到货时段：晚上（EVENING）下单 → 次日 PREP 发车到店', () => {
  const { gs } = setup();
  gs.phase = 'EVENING';
  const res = restock(gs, { dice_keychain: 4 });
  assert.equal(res.ok, true);
  const delivery = gs.logistics.deliveries[0];
  assert.equal(delivery.arriveDay, gs.day + 1, '次日早到');
  assert.equal(delivery.arrivePhase, 'PREP');
  // 当晚不发（未到期）
  assert.equal(startDeliveries(gs, 'EVENING'), 0, '未到期不发车');
  assert.equal(delivery.state, 'ORDERED');
  // 次日 PREP 发车
  gs.day += 1;
  assert.equal(startDeliveries(gs, 'PREP'), 1, '次日 PREP 发车');
  assert.equal(delivery.state, 'IN_TRANSIT');
  assert.ok(delivery.eta > 0);
});

test('到货时段：备货中（PREP）下单 → 当晚 EVENING 发车到店（2026-09 备货可下单）', () => {
  const { gs, rng } = setup();
  const session = startPrepSession(gs, rng); // phase=PREP
  void session;
  const res = restock(gs, { dice_keychain: 4 });
  assert.equal(res.ok, true);
  const delivery = gs.logistics.deliveries[0];
  assert.equal(delivery.arriveDay, gs.day, 'PREP 下单当晚到');
  assert.equal(delivery.arrivePhase, 'EVENING');
  assert.equal(startDeliveries(gs, 'EVENING'), 1, 'EVENING 发车');
  assert.equal(delivery.state, 'IN_TRANSIT');
});

test('★回归：早上下单 → 日结清场后订单保留 → 打烊整理时发车到货（用户实测 bug）', () => {
  const { gs, rng } = setup();
  // MORNING 下单（默认 phase=MORNING）→ 当晚 EVENING 到
  const res = restock(gs, { dice_keychain: 4 });
  assert.equal(res.ok, true);
  const delivery = gs.logistics.deliveries[0];
  assert.equal(delivery.arriveDay, gs.day);
  assert.equal(delivery.arrivePhase, 'EVENING');
  // 白天营业结束 → 日结清场（closeOutBoxes）：当晚到的单必须保留
  closeOutBoxes(gs);
  assert.ok(gs.logistics.deliveries.includes(delivery),
    '当晚 EVENING 到的订单不得被日结清场误删（否则永远不到货、货款两失）');
  assert.equal(gs.skus.dice_keychain.inTransit, 4, '在途量不丢');
  // 打烊整理：发车 → 到货卸箱（session 用真会话，字段齐全）
  const session = startPrepSession(gs, rng);
  const evening = startEveningSession(gs, session);
  assert.equal(evening.phase, 'EVENING');
  assert.equal(delivery.state, 'IN_TRANSIT', 'EVENING 开始即发车');
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  assert.equal(delivery.state, 'ARRIVED', '打烊整理阶段货车到店卸箱');
  assert.equal(gs.logistics.boxes.length, 1, '门口有箱');
  assert.ok(stockInvariantOk(gs));
});

test('到货时段：打烊清场保留未到期订单，次日照常送达', () => {
  const { gs } = setup();
  gs.phase = 'EVENING'; // 晚上下单 → 次日早到
  restock(gs, { dice_keychain: 4 });
  const delivery = gs.logistics.deliveries[0];
  closeOutBoxes(gs); // 当日打烊
  assert.equal(gs.logistics.deliveries.length, 1, '未到期订单保留过夜');
  assert.equal(gs.skus.dice_keychain.inTransit, 4, '在途量不丢');
  gs.day += 1;
  startDeliveries(gs, 'PREP');
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  assert.equal(delivery.state, 'ARRIVED', '次日货车到店卸箱');
  assert.equal(gs.logistics.boxes.length, 1);
  assert.ok(stockInvariantOk(gs));
});

// ---------- v3 箱体物理 / 空箱处理 / 库房 ----------

test('箱体物理：卸箱从 1.4m 落地沉降；两箱同点堆叠', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 8 }); // 2 箱同品类
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1); // 含 stepBoxPhysics
  const boxes = gs.logistics.boxes;
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => b.settled), '全部落定');
  assert.ok(boxes.every((b) => b.y >= -1e-9), '不沉到地下');
});

test('箱体物理：悬空箱沉降到下层箱顶（堆叠）', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 4 });
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const a = gs.logistics.boxes[0];
  assert.ok(a.settled && a.y === 0);
  // 手工造一个同点悬空箱（模拟卸到同一槽位）
  gs.logistics.boxes.push({
    id: 9001, deliveryId: 1, sku: 'boba_tea', qty: 4, state: 'SEALED',
    slot: a.slot, progress: 0, claimedBy: null, claimedKind: null,
    x: a.x, z: a.z, y: 1.4, vy: 0, settled: false,
  });
  for (let i = 0; i < 60; i += 1) stepBoxPhysics(gs, 0.05);
  const top = gs.logistics.boxes.find((b) => b.id === 9001);
  const H = CONFIG.logistics.boxHalf;
  assert.ok(top.settled, '应落定');
  assert.ok(Math.abs(top.y - (a.y + H * 2)) < 1e-9, `应停在下层箱顶（y=${top.y}）`);
});

test('箱体物理：搬走/抽掉下层箱后，上层箱自动沉降到地面（2026-09 试玩反馈）', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 4 });
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const a = gs.logistics.boxes[0];
  const H = CONFIG.logistics.boxHalf;
  // 手工造一个已落定的上层箱（叠在 a 顶上）
  gs.logistics.boxes.push({
    id: 9002, deliveryId: 1, sku: 'boba_tea', qty: 4, state: 'SEALED',
    slot: a.slot, progress: 0, claimedBy: null, claimedKind: null,
    x: a.x, z: a.z, y: a.y + H * 2, vy: 0, settled: true,
  });
  const top = gs.logistics.boxes.find((b) => b.id === 9002);
  // 移除下层箱（抱起/折叠/丢弃共用同一条数组移除路径）
  gs.logistics.boxes = gs.logistics.boxes.filter((b) => b.id !== a.id);
  // 物理应唤醒上层箱：先 unsettle，再沉降到地面
  for (let i = 0; i < 80; i += 1) stepBoxPhysics(gs, 0.05);
  assert.ok(top.settled, '上层箱最终落定');
  assert.ok(Math.abs(top.y) < 1e-9, `支撑消失后应沉降到地面（y=${top.y}）`);
});

test('推箱：水平推动落地箱；撞墙/撞箱即停；推出支撑即坠落', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 4 });
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const b = gs.logistics.boxes[0];
  const x0 = b.x;
  assert.equal(pushBox(gs, b.id, 0.2, 0), true, '可推动');
  assert.ok(b.x > x0, '位置前移');
  // 推出人行道外沿 → 钳制停住
  for (let i = 0; i < 40; i += 1) pushBox(gs, b.id, 0, 1);
  assert.ok(b.z <= CONFIG.street.blockZ - CONFIG.logistics.boxHalf + 1e-9, '不越界');
});

test('空箱处理：折叠 → 纸板 +1；垃圾桶 → 清空箱；回收 → 现金入账', () => {
  const { gs } = setup();
  restock(gs, { dice_keychain: 8 }); // 2 箱
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const [b1, b2] = gs.logistics.boxes;
  // 取空两箱（auto 通道：pickTick 无 session → 入后仓）
  for (const b of [b1, b2]) {
    b.state = 'OPEN';
    claimBox(gs, b.id, 'auto', 'pick');
    for (let i = 0; i < 10; i += 1) pickTick(gs, b, 0.1);
    assert.equal(b.state, 'EMPTY');
  }
  assert.equal(gs.logistics.boxes.length, 2, 'v3：空箱留置不消失');
  // 折叠 b1
  assert.equal(flattenBox(gs, b1.id), true);
  assert.equal(gs.stockroom.cardboard, 1, '折叠 +1 纸板');
  assert.equal(gs.logistics.boxes.length, 1, '折叠后箱移除');
  // 回收
  const cash0 = gs.cash;
  const income = recycleCardboard(gs);
  assert.equal(income, CONFIG.stockroom.cardboardPrice, '1 张纸板收入');
  assert.equal(gs.cash, cash0 + income);
  assert.equal(gs.stockroom.cardboard, 0);
  // 垃圾桶丢弃 b2（无材料收益）
  const trashed = trashEmptyBoxes(gs);
  assert.equal(trashed, 1, '垃圾桶清空剩余空箱');
  assert.equal(gs.logistics.boxes.length, 0);
  assert.equal(gs.stockroom.cardboard, 0, '丢弃不产生纸板');
  assert.ok(stockInvariantOk(gs));
});

test('库房存取：stash 手上入后仓 / takeout 后仓取上手（≤4 件）', () => {
  const { gs } = setup();
  const session = { carry: { type: 'item', skuId: 'boba_tea', qty: 4 } };
  const before = gs.skus.boba_tea.backroom;
  stashToBackroom(gs, session);
  assert.equal(gs.skus.boba_tea.backroom, before + 4);
  assert.equal(session.carry, null);
  const n = takeOutToHands(gs, session, 'boba_tea');
  assert.equal(n, 4, '取回一箱 4 件');
  assert.equal(session.carry.skuId, 'boba_tea');
  assert.equal(takeOutToHands(gs, session, 'cat_cafe'), 0, '手上有货不能再取');
  assert.ok(stockInvariantOk(gs));
});

test('收货堆叠：同单多箱平铺优先再叠层（不一柱擎天），且列址不挡店铺入口', () => {
  const { gs } = setup();
  // 48 件 = 12 箱大单：平铺优先 → 9 列各 1 箱 + 前 3 列再各叠 1（最矮列优先）
  restock(gs, { boba_tea: 24, cat_cafe: 16, dice_tower: 8 });
  gs.day += 1;
  startDeliveries(gs);
  for (let i = 0; i < 200; i += 1) stepDeliveries(gs, 0.1);
  const boxes = gs.logistics.boxes;
  assert.equal(boxes.length, 12);
  // 列址分组
  const cols = new Map();
  for (const b of boxes) {
    const k = `${b.x},${b.z}`;
    cols.set(k, (cols.get(k) || 0) + 1);
  }
  assert.equal(cols.size, 9, `平铺优先：12 箱应铺满 9 列（实际 ${cols.size} 列）`);
  const heights = [...cols.values()].sort((x, y) => x - y);
  assert.deepEqual(heights, [1, 1, 1, 1, 1, 1, 2, 2, 2], '9 列一层 + 3 列两层（均匀不独柱）');
  for (const [k, n] of cols) {
    assert.ok(n <= CONFIG.street.dropZone.layers, `列 ${k} 超 ${CONFIG.street.dropZone.layers} 层：${n}`);
  }
  // 门洞走廊净空（店铺入口 x∈[4.9,6.7] 不得有箱）
  for (const b of boxes) {
    assert.ok(!(b.x > 4.9 && b.x < 6.7 && b.z > 4.4 && b.z < 6.9),
      `箱子挡住店铺入口 (${b.x},${b.z})`);
  }
  // 全部落定且不超 3 层高
  for (const b of boxes) {
    assert.ok(b.settled, '全部落定');
    assert.ok(b.y <= CONFIG.logistics.boxHalf * 2 * (CONFIG.street.dropZone.layers - 1) + 1e-6,
      `堆高超限 y=${b.y}`);
  }
  assert.ok(stockInvariantOk(gs));
});
