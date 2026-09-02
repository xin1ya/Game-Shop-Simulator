/**
 * firstPersonWorld.test.js — 第一人称「世界层」双轨边界测试（v2 改造，裁决 3）。
 *
 * collision.test.js 验证单步滑动的局部正确性；本文件验证全局性质：
 *  A. 室内（数值写死在测试常量里，与 v1 基线完全一致，不随 CONFIG 漂移）
 *  B. 室外（新增：门口 → 人行道，maxZ 4.55 → 8.0）
 *  C. 整体连通性（室内 + 室外 BFS：可达格 == 自由格，无密封口袋）
 *  D. 门口往返不卡死（真实 slideMove 正反向 BFS + 最窄处穿越 + 无累积漂移）
 *  E. 布局守卫（障碍表与 shop.js 布局常量交叉比对，防场景改动忘改障碍表）
 *  F. v2 交互几何（distance2D / withinRange / aimScore / doorSlowFactor）
 *
 * 运行：node --test tests/firstPersonWorld.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import {
  slideMove, buildObstacles, distance2D, withinRange, aimScore,
  doorSlowFactor, effectiveBounds,
} from '../src/scene/firstPerson.js';

const FP = CONFIG.firstPerson;
const R = FP.playerRadius;

// ---- 双轨区域常量（室内 = v1 基线；v3 新增库房与全图） ----
/** 室内主厅：与 v1 CONFIG.firstPerson.bounds 一致（不含 v3 库房，库房障碍均在 x<-7）。 */
const INDOOR = { minX: -6.35, maxX: 6.55, minZ: -4.0, maxZ: 4.55 }; // 主厅（店内 x 界；街道 x 已扩到 12）
/** 室外：门口 → 全街（2026-09 全街步行 z→16.7，人行道收窄后）。 */
const OUTDOOR = { minX: -6.35, maxX: 12.0, minZ: 4.55, maxZ: 16.7 };
/** v3 库房（需求 10）：左墙门洞后的房间（x -9.95~-7.05，z -4.0~2.2）。 */
const STOCKROOM = { minX: -9.95, maxX: -7.05, minZ: -4.0, maxZ: 2.2 };
/** 整体：主厅 + 室外全街 + 库房。 */
const FULL = { minX: -9.95, maxX: 12.0, minZ: -4.0, maxZ: 16.7 };
/** 人行道上的门口点（往返断言用）。 */
const DOOR = { x: 5.8, z: 6.0 };
/** 库房锚点（连通性断言用，config.layout.stockroom 真值）。 */
const STOCK_ANCHOR = { x: -8.6, z: -1 };

/** 点是否严格位于某膨胀 AABB 内（slideMove 的阻挡判定语义）。 */
function insideExpanded(o, x, z) {
  return x > o.minX - R && x < o.maxX + R && z > o.minZ - R && z < o.maxZ + R;
}

/** 全升级组合：tableCount × decorLevel。 */
const COMBOS = [];
for (let t = 1; t <= 4; t += 1) {
  for (let d = 1; d <= 3; d += 1) COMBOS.push({ tableCount: t, decorLevel: d });
}

// ================================================================
// A. 室内（原 v1 断言原样保留，区域换 INDOOR 常量）
// ================================================================

test('A1 室内出生点：所有升级组合下均在 INDOOR 内且不嵌入任何障碍', () => {
  for (const combo of COMBOS) {
    const obstacles = buildObstacles(FP, combo);
    const { x, z } = FP.spawn;
    assert.ok(
      x >= INDOOR.minX && x <= INDOOR.maxX && z >= INDOOR.minZ && z <= INDOOR.maxZ,
      `组合 ${JSON.stringify(combo)}：出生点 (${x},${z}) 越出 INDOOR`,
    );
    for (const o of obstacles) {
      assert.ok(
        !insideExpanded(o, x, z),
        `组合 ${JSON.stringify(combo)}：出生点 (${x},${z}) 嵌入障碍 ${JSON.stringify(o)}`,
      );
    }
  }
});

test('A2 障碍 AABB 均在店铺+库房+街道范围内（v3 世界范围）', () => {
  for (const combo of COMBOS) {
    for (const o of buildObstacles(FP, combo)) {
      assert.ok(o.minX >= -24 && o.maxX <= 24, `障碍 x 越界: ${JSON.stringify(o)}`);
      assert.ok(o.minZ >= -5.3 && o.maxZ <= 18, `障碍 z 越界: ${JSON.stringify(o)}`);
    }
  }
});

test('A3 室内连通性：INDOOR 上 BFS 可达格 == 自由格总数（无密封口袋）', () => {
  bfsConnectivity(INDOOR);
});

test('A4 室内四角不死锁：置于 INDOOR 四角时至少两个方向能走开', () => {
  cornerEscape(INDOOR);
});

// ================================================================
// B. 室外（新增）
// ================================================================

test('B1 生效 bounds：maxZ 放宽到 16.7（全街步行），minX 放宽到库房（v3）', () => {
  const eb = effectiveBounds();
  assert.equal(eb.maxZ, 16.7, 'effectiveBounds().maxZ 应为 16.7（2026-09 全街步行）');
  assert.equal(eb.minZ, FP.bounds.minZ); // -4.0 未变
  assert.equal(eb.minX, FP.bounds.minX); // v3：-9.95（库房西墙内侧）
  assert.equal(eb.minX, -9.95, 'v3 库房开放：minX = -9.95');
  assert.equal(eb.maxX, 12.0, '2026-09 全街：maxX = 12（人行道全宽）');
  // 配置守卫：street.blockZ（若模拟层已落地）必须与放宽后上界一致
  if (CONFIG.street && typeof CONFIG.street.blockZ === 'number') {
    assert.equal(CONFIG.street.blockZ, 16.7, 'CONFIG.street.blockZ 应为 16.7');
  }
});

test('B2 室外连通性：OUTDOOR 内 BFS 可达 == 自由格（无障碍 → 矩形全连通）', () => {
  bfsConnectivity(OUTDOOR, { fromDoor: true });
});

test('B3 室外四角不死锁（跳过嵌入边界墙的近墙角落，仅验开阔角落）', () => {
  // v2 临街墙壁（z=4.9）是合法的室内外边界障碍；紧贴它的角落必然嵌入墙内，
  // 这不构成"卡死"。用默认行为跳过嵌入障碍的角落，只验证开阔角落可逃脱。
  cornerEscape(OUTDOOR);
});

test('B4 室外无障碍白名单（2026-09：z>5 只允许 streetObstacles 设施 + 远侧立面墙）', () => {
  for (const combo of COMBOS) {
    const outdoor = buildObstacles(FP, combo).filter((o) => o.maxZ > 5);
    // 白名单：streetObstacles（左角立面/树干/红绿灯杆）+ farWallObstacle
    const allowed = FP.streetObstacles.length + 1;
    assert.equal(outdoor.length, allowed,
      `z>5 障碍必须全部来自白名单（${allowed}），实际 ${outdoor.length}: ${JSON.stringify(outdoor)}`);
    // 远墙必须在对面人行道外沿附近（minZ ≥ 16.5；墙 z=17.05 hz=0.15 → 内侧 16.9）
    assert.ok(outdoor.some((o) => o.minZ >= 16.5), '远侧立面墙缺失');
  }
});

// ================================================================
// C. 整体连通性（室内 + 室外）
// ================================================================

test('C1 整体连通性：FULL 上 BFS 可达格 == 自由格总数（扩展后无密封口袋）', () => {
  bfsConnectivity(FULL);
});

test('C2 整体四角不死锁', () => {
  cornerEscape(FULL);
});

// ================================================================
// D. 门口往返不卡死（裁决 3 新增）
// ================================================================

test('D1 出生点 → 门口（DOOR 5.8,6.0）可达（真实 slideMove BFS）', () => {
  assert.ok(bfsReachable(FULL, { x: FP.spawn.x, z: FP.spawn.z }, DOOR),
    '出生点无法走到门口');
});

test('D2 门口 → 出生点反向可达（往返不单通）', () => {
  assert.ok(bfsReachable(FULL, DOOR, { x: FP.spawn.x, z: FP.spawn.z }),
    '门口无法走回出生点');
});

test('D3 门口通道最窄处（x≈5.8, z=4.55）四方向连续 5 步可穿越（|Δz|>0.3）', () => {
  const obstacles = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  let crossed = 0;
  for (const [dx, dz] of [[0, 0.1], [0, -0.1], [0.1, 0], [-0.1, 0]]) {
    let pos = { x: 5.8, z: 4.55 };
    for (let k = 0; k < 5; k += 1) {
      pos = slideMove(pos, { dx, dz }, R, obstacles, effectiveBounds());
    }
    if (Math.abs(pos.z - 4.55) > 0.3) crossed += 1;
  }
  assert.ok(crossed >= 1, `门口最窄处 ±z 方向全部被卡（crossed=${crossed}）`);
});

test('D4 反复穿越门口 3 次后位置合法且无累积漂移', () => {
  const obstacles = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  const eb = effectiveBounds();
  let pos = { x: 5.8, z: 4.0 };
  const step = 0.35;
  for (let round = 0; round < 3; round += 1) {
    // 向街道走 6 步
    for (let k = 0; k < 6; k += 1) {
      pos = slideMove(pos, { dx: 0, dz: step }, R, obstacles, eb);
    }
    assert.ok(pos.z > 4.55 - 1e-9, `第 ${round + 1} 轮未越过门口（z=${pos.z}）`);
    // 走回店内 6 步
    for (let k = 0; k < 6; k += 1) {
      pos = slideMove(pos, { dx: 0, dz: -step }, R, obstacles, eb);
    }
    assert.ok(pos.z < 4.55 + 1e-9, `第 ${round + 1} 轮未走回室内（z=${pos.z}）`);
    assert.ok(
      pos.x >= eb.minX && pos.x <= eb.maxX && pos.z >= eb.minZ && pos.z <= eb.maxZ,
      `位置越界: ${JSON.stringify(pos)}`,
    );
    assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.z), 'NaN 回归');
  }
});

// ================================================================
// D'. v3 库房连通（需求 10：左墙门洞真实通行）
// ================================================================

test("D5 出生点 → 库房锚点可达（穿员工门洞，真实 slideMove BFS）", () => {
  assert.ok(bfsReachable(FULL, { x: FP.spawn.x, z: FP.spawn.z }, STOCK_ANCHOR),
    '出生点无法走到库房');
});

test("D6 员工门洞（x≈-6.9, z=-1）可穿行且库房四角不死锁", () => {
  const obstacles = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  // 门洞正中沿 x 穿越（店内 → 库房）
  let pos = { x: -6.3, z: -1.0 };
  for (let k = 0; k < 8; k += 1) {
    pos = slideMove(pos, { dx: -0.14, dz: 0 }, R, obstacles, effectiveBounds());
  }
  assert.ok(pos.x < -7.05, `门洞未穿通（x=${pos.x}）`);
  // 反向穿回
  for (let k = 0; k < 8; k += 1) {
    pos = slideMove(pos, { dx: 0.14, dz: 0 }, R, obstacles, effectiveBounds());
  }
  assert.ok(pos.x > -6.35, `门洞反向未穿通（x=${pos.x}）`);
  // 库房区域四角落死锁检查（货架/垃圾桶旁嵌入障碍的角落自动跳过）
  cornerEscape(STOCKROOM);
});

// ================================================================
// E. 布局守卫（v1 原样保留）
// ================================================================

test('E1 布局守卫：障碍表数值与 shop.js 场景布局常量一致', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/scene/shop.js', import.meta.url)), 'utf8',
  );
  const numArray = (name) => {
    const m = src.match(new RegExp(`${name} = \\[([\\d.,\\s\\[\\]-]+)\\]`));
    assert.ok(m, `shop.js 中未找到 ${name}`);
    return m[1];
  };
  // 货架 x 列表与 z
  const shelfX = JSON.parse(`[${numArray('SHELF_X')}]`);
  const shelfZ = Number(src.match(/SHELF_Z = ([-\d.]+)/)[1]);
  assert.deepEqual(FP.shelfObstacles.map((o) => o.x), shelfX, '货架 x 与 shop.js SHELF_X 漂移');
  for (const o of FP.shelfObstacles) assert.equal(o.z, shelfZ, '货架 z 与 SHELF_Z 漂移');
  // 体验桌坐标池（嵌套数组，整体匹配到分号）
  const expMatch = src.match(/EXP_SLOT_POS = (\[[\s\S]*?\]);/);
  assert.ok(expMatch, 'shop.js 中未找到 EXP_SLOT_POS');
  const expPos = JSON.parse(expMatch[1].replace(/,(\s*[\]])/g, '$1')); // 去尾逗号
  assert.deepEqual(FP.tableObstacles.map((o) => [o.x, o.z]), expPos, '体验桌与 EXP_SLOT_POS 漂移');
  // 收银台
  const checkout = JSON.parse(`[${numArray('CHECKOUT_POS')}]`);
  assert.equal(FP.checkoutObstacle.x, checkout[0]);
  assert.equal(FP.checkoutObstacle.z, checkout[1]);
});

test('E2 建筑红线守卫：临街建筑立面与 facadeLine/roadFarLine 对齐、不占人行道', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/scene/street.js', import.meta.url)), 'utf8',
  );
  // 解析 NEIGHBOR_SHOPS 常量表（{ x, z, w } 数值段）
  const m = src.match(/NEIGHBOR_SHOPS = \[([\s\S]*?)\];/);
  assert.ok(m, 'street.js 中未找到 NEIGHBOR_SHOPS');
  const rows = [...m[1].matchAll(/\{\s*x:\s*([-\d.]+),\s*z:\s*([-\d.]+),\s*w:\s*([-\d.]+)/g)]
    .map((r) => ({ x: Number(r[1]), z: Number(r[2]), w: Number(r[3]) }));
  assert.ok(rows.length >= 3, '至少 3 栋邻铺/排屋');
  const FL = CONFIG.street.facadeLine;   // 5.05（本店前墙外侧）
  const RL = CONFIG.street.roadFarLine;  // 14.0（道路边线）
  const DEPTH = 2.8; // street.js 邻铺主体 BoxGeometry 深度
  for (const s of rows) {
    if (s.z < 8) {
      // 本侧：立面 = z + 1.4 贴红线；主体退红线后（不占人行道 z∈[5.05,8]）
      const front = s.z + DEPTH / 2;
      assert.ok(Math.abs(front - FL) < 0.01,
        `邻铺 x=${s.x} 立面 ${front} 未贴合建筑红线 ${FL}`);
      assert.ok(s.z + DEPTH / 2 <= FL + 0.01, `邻铺 x=${s.x} 主体挤占人行道`);
    } else {
      // 对面：立面 = z - 1.4 贴对面人行道外沿（roadFarLine + 人行道宽）
      const front = s.z - DEPTH / 2;
      const FL2 = RL + (CONFIG.street.farSidewalkW ?? 1.0);
      assert.ok(Math.abs(front - FL2) < 0.01,
        `对面建筑 x=${s.x} 立面 ${front} 未贴合对面人行道外沿 ${FL2}`);
    }
  }
  // 本店前墙外侧 = 红线（shop.js 前墙 z=4.9 半厚 0.15 → 5.05）
  assert.ok(Math.abs(FL - 5.05) < 1e-9, 'facadeLine 应为本店前墙外侧 5.05');
});

test('E3 slideMove 零位移 / 无 NaN 回归', () => {
  const obstacles = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  const p = slideMove({ x: 0, z: 0.6 }, { dx: 0, dz: 0 }, R, obstacles, effectiveBounds());
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  assert.deepEqual(p, { x: 0, z: 0.6 });
});

// ================================================================
// F. v2 交互几何纯函数
// ================================================================

test('F1 distance2D：水平距离与勾股一致', () => {
  assert.equal(distance2D({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
  assert.equal(distance2D({ x: 1, z: 1 }, { x: 1, z: 1 }), 0);
});

test('F2 withinRange：三态对照（2.4 可达 / 2.6 拒绝 / 无上限时恒真）', () => {
  const near = { x: 0, z: 0 };
  const a = { x: 2.4, z: 0 };
  const b = { x: 2.6, z: 0 };
  if (FP.interactRange !== undefined) {
    // config 已带 interactRange：断言单一真值生效
    assert.equal(FP.interactRange, 2.5, 'interactRange 唯一真值应为 2.5');
    assert.equal(withinRange(near, a), true, '2.4u 应在 2.5 范围内');
    assert.equal(withinRange(near, b), false, '2.6u 应超出 2.5 范围');
  } else {
    // config 未落地（模拟层 v2 前的过渡态）：显式传参验证纯函数语义
    assert.equal(withinRange(near, a, 2.5), true);
    assert.equal(withinRange(near, b, 2.5), false);
    assert.equal(withinRange(near, b), true, '无配置时不应误伤（兜底不限距）');
  }
});

test('F3 aimScore：正对为 1、反向为 -1、重合视为 1', () => {
  assert.ok(Math.abs(aimScore({ x: 0, z: -1 }, { x: 0, z: -2 }) - 1) < 1e-9);
  assert.ok(Math.abs(aimScore({ x: 0, z: -1 }, { x: 0, z: 2 }) + 1) < 1e-9);
  assert.ok(Math.abs(aimScore({ x: 1, z: 0 }, { x: 5, z: 0 }) - 1) < 1e-9);
  assert.equal(aimScore({ x: 0, z: -1 }, { x: 0, z: 0 }), 1);
});

test('F4 doorSlowFactor：门口箱 >8 且玩家在门口区 → ×0.7，其余恒 1（软惩罚不阻断）', () => {
  const cfg = { boxSlowThreshold: 8, doorSlowMult: 0.7, doorX: 5.8, doorZoneHalfW: 1.6, doorZoneMinZ: 4.0 };
  assert.equal(doorSlowFactor(5.8, 6.0, 9, cfg), 0.7, '箱 9 > 8 且在门口 → 0.7');
  assert.equal(doorSlowFactor(5.8, 6.0, 8, cfg), 1, '箱 8 未超上限 → 1');
  assert.equal(doorSlowFactor(0, 6.0, 20, cfg), 1, '箱多但不在门口 → 1');
  assert.equal(doorSlowFactor(5.8, 2.0, 20, cfg), 1, '箱多但 z<4 不在门口区 → 1');
  assert.equal(doorSlowFactor(5.8, 6.0, 9, cfg) > 0, true, '软惩罚恒 >0（不阻断）');
});

// ================================================================
// 共享 BFS / 角落工具
// ================================================================

/** 在区域 B 上做「可达格 == 自由格」断言（用真实 slideMove 逐步走）。 */
function bfsConnectivity(area, opts = {}) {
  const STEP = 0.14; // 半径的一半，足够分辨最窄通道（0.55~0.64 宽）
  const nx = Math.floor((area.maxX - area.minX) / STEP) + 1;
  const nz = Math.floor((area.maxZ - area.minZ) / STEP) + 1;
  const cx = (i) => area.minX + i * STEP;
  const cz = (j) => area.minZ + j * STEP;

  for (const combo of COMBOS) {
    const obstacles = buildObstacles(FP, combo);
    const free = (i, j) => !obstacles.some((o) => insideExpanded(o, cx(i), cz(j)));

    let freeCount = 0;
    for (let i = 0; i < nx; i += 1) {
      for (let j = 0; j < nz; j += 1) if (free(i, j)) freeCount += 1;
    }

    // 起点：默认出生点；fromDoor 时用门口点（室外 / 整体连通性验证）
    const start = opts.fromDoor
      ? { x: DOOR.x, z: DOOR.z }
      : { x: FP.spawn.x, z: FP.spawn.z };
    const si = Math.round((start.x - area.minX) / STEP);
    const sj = Math.round((start.z - area.minZ) / STEP);
    assert.ok(
      si >= 0 && si < nx && sj >= 0 && sj < nz,
      `起点 ${JSON.stringify(start)} 不在区域 ${JSON.stringify(area)} 网格内`,
    );

    const seen = new Set([si * nz + sj]);
    const queue = [[si, sj]];
    while (queue.length > 0) {
      const [i, j] = queue.pop();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p = slideMove(
          { x: cx(i), z: cz(j) },
          { dx: di * STEP, dz: dj * STEP },
          R, obstacles, area,
        );
        const ni = Math.round((p.x - area.minX) / STEP);
        const nj = Math.round((p.z - area.minZ) / STEP);
        const key = ni * nz + nj;
        if (!seen.has(key) && ni >= 0 && ni < nx && nj >= 0 && nj < nz && free(ni, nj)) {
          seen.add(key);
          queue.push([ni, nj]);
        }
      }
    }
    assert.equal(
      seen.size, freeCount,
      `区域 ${JSON.stringify(area)} 组合 ${JSON.stringify(combo)}：可达 ${seen.size} / 自由 ${freeCount}，存在密封口袋`,
    );
  }
}

/** 区域四角连续 5 步尝试四方向，断言至少 2 个方向能离开。 */
function cornerEscape(area, opts = {}) {
  const corners = [
    [area.minX, area.minZ], [area.maxX, area.minZ],
    [area.minX, area.maxZ], [area.maxX, area.maxZ],
  ];
  for (const combo of COMBOS) {
    const obstacles = buildObstacles(FP, combo);
    for (const [x0, z0] of corners) {
      if (!opts.skipObstacleCheck
        && obstacles.some((o) => insideExpanded(o, x0, z0))) continue;
      let escapes = 0;
      for (const [dx, dz] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]]) {
        let pos = { x: x0, z: z0 };
        for (let k = 0; k < 5; k += 1) {
          pos = slideMove(pos, { dx, dz }, R, obstacles, area);
        }
        if (Math.hypot(pos.x - x0, pos.z - z0) > 0.3) escapes += 1;
      }
      assert.ok(
        escapes >= 2,
        `区域 ${JSON.stringify(area)} 组合 ${JSON.stringify(combo)} 角落 (${x0},${z0}) 仅 ${escapes} 个方向可逃脱，疑似卡死`,
      );
    }
  }
}

/** 从 from 出发 BFS，判定 to 所在网格是否可达（真实 slideMove 步进）。 */
function bfsReachable(area, from, to) {
  const STEP = 0.14;
  const obstacles = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  const nx = Math.floor((area.maxX - area.minX) / STEP) + 1;
  const nz = Math.floor((area.maxZ - area.minZ) / STEP) + 1;
  const key = (i, j) => i * nz + j;
  const toI = Math.round((to.x - area.minX) / STEP);
  const toJ = Math.round((to.z - area.minZ) / STEP);
  const si = Math.round((from.x - area.minX) / STEP);
  const sj = Math.round((from.z - area.minZ) / STEP);
  const seen = new Set([key(si, sj)]);
  const queue = [[si, sj]];
  while (queue.length > 0) {
    const [i, j] = queue.pop();
    if (i === toI && j === toJ) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = slideMove(
        { x: area.minX + i * STEP, z: area.minZ + j * STEP },
        { dx: di * STEP, dz: dj * STEP },
        R, obstacles, area,
      );
      const ni = Math.round((p.x - area.minX) / STEP);
      const nj = Math.round((p.z - area.minZ) / STEP);
      if (ni < 0 || ni >= nx || nj < 0 || nj >= nz) continue;
      if (seen.has(key(ni, nj))) continue;
      if (obstacles.some((o) => insideExpanded(o, area.minX + ni * STEP, area.minZ + nj * STEP))) continue;
      seen.add(key(ni, nj));
      queue.push([ni, nj]);
    }
  }
  return false;
}
