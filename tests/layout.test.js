/**
 * layout.test.js — 店内布局自定义（2026-09：EVENING 布局模式）。
 *
 * 契约：gs.customLayout 稀疏覆盖 CONFIG.layout 默认位；moveLayoutPiece 钳制店内范围；
 * layoutOf 输出供 shop.js 视觉 / buildObstacles 碰撞 / interaction.js 锚点三端共用。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { newGame, serialize, deserialize } from '../src/sim/gameState.js';
import {
  layoutOf, moveLayoutPiece, resetLayout, shelfAnchorOf, rotOffset,
} from '../src/sim/layout.js';
import { buildObstacles } from '../src/scene/firstPerson.js';

const FP = CONFIG.firstPerson;

test('layoutOf：默认布局 = CONFIG.layout 推导（货架锚点 z-1.1 = 本体）', () => {
  const gs = newGame(42);
  const l = layoutOf(gs);
  assert.equal(l.shelves.length, 4);
  assert.equal(l.shelves[0].x, -4.8);
  assert.ok(Math.abs(l.shelves[0].z - (-3.2)) < 1e-9, '货架 0 本体 z=-3.2');
  assert.equal(l.tables.length, 6);
  assert.deepEqual(l.checkout, { x: -4.6, z: 2.6, rot: 0 });
});

test('moveLayoutPiece：写入稀疏覆盖 + layoutOf 生效 + 店内钳制', () => {
  const gs = newGame(42);
  // 正常移动
  const p = moveLayoutPiece(gs, 'shelf', 0, -2.0, -1.0);
  assert.deepEqual(p, { x: -2, z: -1 });
  assert.equal(layoutOf(gs).shelves[0].x, -2);
  assert.equal(layoutOf(gs).shelves[1].x, -1.6, '未移动的货架保持默认');
  // 越界钳制（店内 x∈[-6.3,6.5] z∈[-3.5,4.2]）
  const p2 = moveLayoutPiece(gs, 'table', 0, 99, -99);
  assert.ok(p2.x <= 6.5 && p2.z >= -3.5, `钳制店内 (${p2.x},${p2.z})`);
  assert.equal(layoutOf(gs).tables[0].x, p2.x);
  // 翼房收购后东界放宽
  gs.expansion.wing_right = true;
  const p3 = moveLayoutPiece(gs, 'table', 4, 10.8, -1.0);
  assert.ok(p3.x > 6.5, '翼房内可摆');
  // checkout
  moveLayoutPiece(gs, 'checkout', 0, -3, 2.0);
  assert.deepEqual(layoutOf(gs).checkout, { x: -3, z: 2, rot: 0 });
  // reset
  resetLayout(gs);
  assert.equal(gs.customLayout, null);
  assert.equal(layoutOf(gs).shelves[0].x, -4.8, '复位默认');
});

test('shelfAnchorOf：动态锚点随布局移动（本体 z+1.1）', () => {
  const gs = newGame(42);
  assert.ok(Math.abs(shelfAnchorOf(gs, 0).z - (-2.1)) < 1e-9, '默认锚点与 CONFIG 一致');
  moveLayoutPiece(gs, 'shelf', 0, 0, 0);
  assert.deepEqual(shelfAnchorOf(gs, 0), { x: 0, z: 1.1 });
});

test('buildObstacles：layout 覆盖后货架/桌子/收银台障碍跟随', () => {
  const gs = newGame(42);
  moveLayoutPiece(gs, 'shelf', 1, 2.0, 0.5);
  moveLayoutPiece(gs, 'table', 0, -2.0, 1.0);
  moveLayoutPiece(gs, 'checkout', 0, -3.0, 1.5);
  const obs = buildObstacles(FP, {
    tableCount: 1, decorLevel: 1, shelfLevel: 1, layout: layoutOf(gs),
  });
  // 货架 1 障碍中心应移到 (2.0, 0.5)
  const shelfOb = FP.shelfObstacles[1];
  assert.ok(obs.some((o) => Math.abs((o.minX + o.maxX) / 2 - 2.0) < 1e-9
    && Math.abs((o.minZ + o.maxZ) / 2 - 0.5) < 1e-9), '货架障碍跟随布局');
  // 桌子 0 障碍中心 (-2.0, 1.0)
  assert.ok(obs.some((o) => Math.abs((o.minX + o.maxX) / 2 - (-2.0)) < 1e-9
    && Math.abs((o.minZ + o.maxZ) / 2 - 1.0) < 1e-9), '桌子障碍跟随布局');
  // 收银台障碍中心 (-3.0, 1.5)
  assert.ok(obs.some((o) => Math.abs((o.minX + o.maxX) / 2 - (-3.0)) < 1e-9
    && Math.abs((o.minZ + o.maxZ) / 2 - 1.5) < 1e-9), '收银台障碍跟随布局');
  // 默认位置不再存在（货架 1 原 x=-1.6）
  assert.ok(!obs.some((o) => Math.abs((o.minX + o.maxX) / 2 - shelfOb.x) < 1e-9
    && Math.abs((o.minZ + o.maxZ) / 2 - shelfOb.z) < 1e-9), '原位置障碍已移除');
});

test('存档兼容：customLayout 随档保存/恢复，老档缺省为 null', () => {
  const gs = newGame(42);
  moveLayoutPiece(gs, 'shelf', 2, 1.0, -2.0);
  const json = serialize(gs);
  const gs2 = deserialize(json);
  assert.equal(layoutOf(gs2).shelves[2].x, 1.0, '布局随档恢复');
  // 老档（无 customLayout 字段）→ 默认
  const raw = JSON.parse(json);
  delete raw.customLayout;
  const gs3 = deserialize(JSON.stringify(raw));
  assert.equal(gs3.customLayout, null);
  assert.equal(layoutOf(gs3).shelves[2].x, 1.6, '老档回退默认布局');
});

test('构件旋转：moveLayoutPiece 存 rot（90° 步进取模），障碍换轴，锚点随朝向', () => {
  const gs = newGame(42);
  // 旋转货架 0 到 90°（横放）
  moveLayoutPiece(gs, 'shelf', 0, -4.8, -3.2, 90);
  assert.equal(layoutOf(gs).shelves[0].rot, 90);
  // 障碍：hx/hz 互换
  const obs = buildObstacles(FP, { tableCount: 1, decorLevel: 1, shelfLevel: 1, layout: layoutOf(gs) });
  const shelfOb = FP.shelfObstacles[0];
  const rotated = obs.find((o) => Math.abs((o.minX + o.maxX) / 2 - (-4.8)) < 1e-9
    && Math.abs((o.minZ + o.maxZ) / 2 - (-3.2)) < 1e-9);
  assert.ok(rotated, '货架障碍存在');
  assert.ok(Math.abs((rotated.maxX - rotated.minX) - shelfOb.hz * 2) < 1e-9, 'rot90 后 x 向半宽=原 hz');
  // 锚点：rot90 → 前向 +x（交互点在货架东侧）
  const a = shelfAnchorOf(gs, 0);
  assert.ok(Math.abs(a.x - (-4.8 + 1.1)) < 1e-9 && Math.abs(a.z - (-3.2)) < 1e-9,
    `rot90 锚点应在 +x 侧（实际 ${a.x},${a.z}）`);
  // 再转 270°（累计 360 ≡ 0）
  moveLayoutPiece(gs, 'shelf', 0, -4.8, -3.2, 360);
  assert.equal(layoutOf(gs).shelves[0].rot, 0, '360° 归 0');
  // 保留朝向：不传 rot 时沿用旧值
  moveLayoutPiece(gs, 'shelf', 1, 0, 0, 180);
  moveLayoutPiece(gs, 'shelf', 1, 1, 0); // 只移动
  assert.equal(layoutOf(gs).shelves[1].rot, 180, '移动不带 rot 时保留朝向');
  // rotOffset 基础向量
  const r0 = rotOffset(90, 0, 1.0);
  assert.ok(Math.abs(r0.x - 1.0) < 1e-9 && Math.abs(r0.z) < 1e-9, 'rot90 前向=+x');
});
