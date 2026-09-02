/**
 * collision.test.js — 第一人称纯函数单元测试。
 *
 * 覆盖：
 *  - applyLook：偏航 / 俯仰方向与俯仰 ±80° 钳制
 *  - computeMoveDelta：yaw=0 时 W→-z、D→+x，斜向位移长度守恒
 *  - slideMove：AABB 分轴推挤滑动（撞墙滑动 / 不穿插 / bounds 钳制）
 *  - buildObstacles：按体验桌数量与装修等级生成障碍列表
 *
 * 运行：node --test tests/collision.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import {
  clamp, applyLook, computeMoveDelta, slideMove, expandObstacle, buildObstacles,
  distance2D, withinRange, aimScore, doorSlowFactor, effectiveBounds,
} from '../src/scene/firstPerson.js';

const FP = CONFIG.firstPerson;

test('clamp 边界', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test('applyLook：鼠标右移 → 向右转（yaw 减小），下移 → 低头（pitch 减小）', () => {
  const limit = (FP.pitchClampDeg * Math.PI) / 180;
  const r = applyLook(0, 0, 100, 50, FP.mouseSensitivity, limit);
  assert.ok(r.yaw < 0);
  assert.ok(r.pitch < 0);
});

test('applyLook：俯仰钳制在 ±pitchLimit', () => {
  const limit = (FP.pitchClampDeg * Math.PI) / 180;
  const up = applyLook(0, 0, 0, -1e6, FP.mouseSensitivity, limit);
  const down = applyLook(0, 0, 0, 1e6, FP.mouseSensitivity, limit);
  assert.equal(up.pitch, limit);
  assert.equal(down.pitch, -limit);
});

test('computeMoveDelta：yaw=0 时 W 朝 -z，D 朝 +x', () => {
  const w = computeMoveDelta(new Set(['KeyW']), 0, 1);
  assert.ok(Math.abs(w.dx) < 1e-9 && w.dz < 0, 'W 应向 -z');
  const d = computeMoveDelta(new Set(['KeyD']), 0, 1);
  assert.ok(d.dx > 0 && Math.abs(d.dz) < 1e-9, 'D 应向 +x');
  const none = computeMoveDelta(new Set(), 0, 1);
  assert.deepEqual(none, { dx: 0, dz: 0 });
});

test('computeMoveDelta：斜向输入归一化，位移长度 = distance', () => {
  const r = computeMoveDelta(new Set(['KeyW', 'KeyD']), 0, 2);
  assert.ok(Math.abs(Math.hypot(r.dx, r.dz) - 2) < 1e-9);
});

test('slideMove：无障碍时在 bounds 内自由移动', () => {
  const p = slideMove({ x: 0, z: 0 }, { dx: 1, dz: -0.5 }, FP.playerRadius, [], FP.bounds);
  assert.deepEqual(p, { x: 1, z: -0.5 });
});

test('slideMove：bounds 钳制，不能穿出店铺范围', () => {
  const p = slideMove({ x: 0, z: 0 }, { dx: 99, dz: -99 }, FP.playerRadius, [], FP.bounds);
  assert.equal(p.x, FP.bounds.maxX);
  assert.equal(p.z, FP.bounds.minZ);
});

test('slideMove：正面撞上货架被挡下（不穿入障碍）', () => {
  const shelf = expandObstacle(FP.shelfObstacles[2]); // x=1.6, z=-3.2
  // 从货架正前方（x=1.6）向 -z 走 1 步跨越货架
  const p = slideMove({ x: 1.6, z: -1.8 }, { dx: 0, dz: -1.0 }, FP.playerRadius, [shelf], FP.bounds);
  // 应停在货架前缘（maxZ + radius），不得进入货架内部
  assert.ok(Math.abs(p.z - (shelf.maxZ + FP.playerRadius)) < 1e-9);
  assert.equal(p.x, 1.6);
});

test('slideMove：斜着撞墙时沿墙滑动（x 被挡、z 照常移动）', () => {
  const wall = { minX: 1, maxX: 2, minZ: -5, maxZ: 5 };
  const p = slideMove({ x: 0.5, z: 0 }, { dx: 1, dz: 0.5 }, 0.3, [wall], { minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
  assert.ok(Math.abs(p.x - (1 - 0.3)) < 1e-9, 'x 应停在墙面外侧');
  assert.ok(Math.abs(p.z - 0.5) < 1e-9, 'z 应正常滑动');
});

test('buildObstacles：按体验位数量与装修等级生成（v3：+库房/左墙/街道固定障碍）', () => {
  // v3 常驻：临街墙 2 段 + 左墙 2 段（门洞通库房）+ 库房 6 + 街道 2
  // v3 常驻：临街墙 2 + 左墙 2 + 库房 + 街道 + 远墙 1 + 店内右墙 1
  const fixed = FP.frontWallObstacles.length + FP.leftWallObstacles.length
    + FP.stockroomObstacles.length + FP.streetObstacles.length + 2;
  const lvl1 = buildObstacles(FP, { tableCount: 1, decorLevel: 1 });
  // 4 货架 + 1 桌 + 1 收银台 + 1 盆栽 + 固定
  assert.equal(lvl1.length, 7 + fixed);
  const full = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  // 4 货架 + 4 桌 + 1 收银台 + 2 盆栽 + 固定
  assert.equal(full.length, 11 + fixed);
  // 超界 tableCount 钳制到主区 4 桌；翼房 2 桌由 wingRight 独立追加
  const over = buildObstacles(FP, { tableCount: 99, decorLevel: 3 });
  assert.equal(over.length, 4 + 4 + 1 + 2 + fixed, 'tableCount 钳制到 4（主区上限）');
  const wing = buildObstacles(FP, { tableCount: 4, decorLevel: 3, wingRight: true });
  // 翼房追加 2 桌；整右墙(-1)被右墙分段 + 翼房三面墙替代
  const wingExtra = 2 - 1 + FP.rightWallObstacles.length + FP.wingObstacles.length;
  assert.equal(wing.length, 4 + 4 + 1 + 2 + fixed + wingExtra, '翼房：+2 桌 + 右墙分段 + 翼房三墙');
});

test('buildObstacles：临街墙壁含门洞（中央可通行，左右阻挡）', () => {
  const full = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  const walls = full.filter((o) => Math.abs((o.minZ + o.maxZ) / 2 - 4.9) < 0.2);
  assert.ok(walls.length >= 2, '应有左右两段临街墙');
  // 门洞 x∈[4.9, 6.7] 不被任何墙覆盖（中央可通行）
  const doorX = 5.8;
  const blocked = walls.some((o) => doorX > o.minX && doorX < o.maxX);
  assert.equal(blocked, false, '门洞中央（x=5.8）不应被临街墙阻挡');
});

test('buildObstacles：收银台 / 货架 AABB 与配置一致', () => {
  const list = buildObstacles(FP, { tableCount: 0, decorLevel: 1 });
  const checkout = list.find((o) => o.minX === FP.checkoutObstacle.x - FP.checkoutObstacle.hx);
  assert.ok(checkout);
  assert.equal(checkout.maxZ, FP.checkoutObstacle.z + FP.checkoutObstacle.hz);
});

// ================================================================
// v2 增量补充（T09 / B22 / A06 / 裁决 8）—— 仅新增，上方 11 例原样保留
// ================================================================

test('v2 effectiveBounds：maxZ 放宽到 16.7（全街步行，对面人行道内），其余三界与配置一致', () => {
  const eb = effectiveBounds();
  assert.equal(eb.maxZ, 16.7);
  assert.equal(eb.minZ, FP.bounds.minZ); // -4.0 未变
  assert.equal(eb.minX, FP.bounds.minX); // -9.95 库房
  assert.equal(eb.maxX, FP.bounds.maxX); // 12.0 全街
});

test('v2 slideMove：室外人行道（z>4.55）自由行走，钳制在 8.0（放宽上界生效）', () => {
  const obstacles = buildObstacles(FP, { tableCount: 4, decorLevel: 3 });
  const eb = effectiveBounds();
  // 从门口出发向街道走
  const p = slideMove({ x: 5.8, z: 6.0 }, { dx: 0, dz: 99 }, FP.playerRadius, obstacles, eb);
  // 远侧立面墙（z=17.05 内侧面 16.9 - 半径 0.28 = 16.62）先于 bounds 16.7 拦截
  assert.ok(Math.abs(p.z - 16.62) < 1e-9, `应停在远墙内侧面（实际 ${p.z}）`);
  assert.equal(p.x, 5.8);
  // 2026-09 白名单：z>5 的障碍只允许 streetObstacles 设施 + 远侧立面墙
  const street = obstacles.filter((o) => o.maxZ > 5);
  assert.equal(street.length, FP.streetObstacles.length + 1,
    'z>5 障碍必须全部来自白名单（含远墙）');
});

test('v2 slideMove：室内原语义回归（v1 断言等价，bounds 传 v1 原值）', () => {
  const obstacles = buildObstacles(FP, { tableCount: 1, decorLevel: 1 });
  // 向 -z 走到后墙：仍被钳制在 v1 minZ
  const p = slideMove({ x: 0, z: -3.9 }, { dx: 0, dz: -1 }, FP.playerRadius, obstacles, FP.bounds);
  assert.equal(p.z, FP.bounds.minZ);
});

test('v2 distance2D / withinRange：单一真值 interactRange 三态对照（2.4/2.6/等距）', () => {
  assert.equal(distance2D({ x: 0, z: 0 }, { x: 6, z: 8 }), 10);
  if (FP.interactRange !== undefined) {
    assert.equal(FP.interactRange, 2.5, 'CONFIG.firstPerson.interactRange 唯一真值 2.5');
    assert.equal(withinRange({ x: 0, z: 0 }, { x: 2.4, z: 0 }), true, '2.4u 可响应');
    assert.equal(withinRange({ x: 0, z: 0 }, { x: 2.6, z: 0 }), false, '2.6u 拒绝');
  } else {
    assert.equal(withinRange({ x: 0, z: 0 }, { x: 2.4, z: 0 }, 2.5), true);
    assert.equal(withinRange({ x: 0, z: 0 }, { x: 2.6, z: 0 }, 2.5), false);
    assert.equal(withinRange({ x: 0, z: 0 }, { x: 99, z: 0 }), true, '无配置兜底不限距');
  }
});

test('v2 aimScore：朝向锥点积（正对 / 侧向 / 背向）', () => {
  const fwd = { x: 0, z: -1 };
  assert.ok(Math.abs(aimScore(fwd, { x: 0, z: -1 }) - 1) < 1e-9, '正对');
  assert.ok(Math.abs(aimScore(fwd, { x: 1, z: 0 })) < 1e-9, '侧向 90° 点积 0');
  assert.ok(aimScore(fwd, { x: 0, z: -1 }) > aimScore(fwd, { x: 0.5, z: -1 }), '正对得分更高');
});

test('v2 doorSlowFactor：门口堆积软惩罚矩阵（A06，不生成障碍）', () => {
  const cfg = {
    boxSlowThreshold: 8, doorSlowMult: 0.7,
    doorX: 5.8, doorZoneHalfW: 1.6, doorZoneMinZ: 4.0,
  };
  assert.equal(doorSlowFactor(5.8, 6.0, 9, cfg), 0.7);
  assert.equal(doorSlowFactor(5.8, 6.0, 8, cfg), 1);
  assert.equal(doorSlowFactor(8.0, 6.0, 99, cfg), 1, 'x 偏离门口区 → 不惩罚');
  assert.equal(doorSlowFactor(5.8, 3.9, 99, cfg), 1, 'z 在室内 → 不惩罚');
  // 无 cfg 注入时读 CONFIG 降级默认（不抛异常）
  const v = doorSlowFactor(5.8, 6.0, 9);
  assert.ok(v > 0 && v <= 1);
});
