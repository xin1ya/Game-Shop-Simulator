/**
 * layout.js — 店内布局自定义（2026-09 需求：打烊后调整货架/吧台/桌子位置）。
 *
 * 数据模型：gs.customLayout = { shelves: {i:{x,z}}, tables: {i:{x,z}}, checkout: {x,z} } | null
 *   —— 稀疏覆盖，只存被玩家移动过的构件；null/缺项 = 默认（CONFIG.layout）。
 * 位置一律存「本体中心」（= 视觉位置 = 碰撞位置）；交互锚点由消费方按固定偏移推导
 *   （货架交互点 = 本体 z+1.1；体验位 = 本体 (x-0.4, z+0.9)；收银交互 = z+0.9）。
 * 阶段限制由 main.js 强制（仅 EVENING 可进入布局模式）；本模块只做数据与钳制。
 *
 * 纯 ES Module，禁止 import DOM / window / three。
 *
 * @module sim/layout
 */

import { CONFIG } from '../config.js';

/** 默认布局（CONFIG.layout 别名，本体坐标；rot 缺省 0）。 */
function defaults() {
  return {
    shelves: CONFIG.layout.shelfAnchors.map((a) => ({ x: a.x, z: a.z - 1.1, rot: 0 })), // 锚点 → 本体
    tables: CONFIG.layout.experience.map((a) => ({ x: a.x, z: a.z, rot: 0 })),
    checkout: { x: CONFIG.layout.checkout.x, z: CONFIG.layout.checkout.z, rot: 0 },
  };
}

/** 归一化布局条目：rot 按 90° 步进取模（缺省沿用 prev）。 */
function normPiece(v, prevRot = 0) {
  return {
    x: v.x,
    z: v.z,
    rot: Number.isFinite(v.rot) ? (((Math.round(v.rot / 90) % 4) + 4) % 4) * 90 : prevRot,
  };
}

/**
 * 有效布局（默认 + customLayout 稀疏覆盖）。每条 {x, z, rot}（rot ∈ 0/90/180/270）。
 * @param {object} gs GameState
 * @returns {{shelves: Array<{x,z,rot}>, tables: Array<{x,z,rot}>, checkout: {x,z,rot}}}
 */
export function layoutOf(gs) {
  const d = defaults();
  const c = gs && gs.customLayout;
  if (c) {
    for (const [key, arr] of [['shelves', d.shelves], ['tables', d.tables]]) {
      if (!c[key]) continue;
      for (const [k, v] of Object.entries(c[key])) {
        const i = Number(k);
        if (arr[i] && v && Number.isFinite(v.x) && Number.isFinite(v.z)) {
          arr[i] = normPiece(v, arr[i].rot);
        }
      }
    }
    if (c.checkout && Number.isFinite(c.checkout.x) && Number.isFinite(c.checkout.z)) {
      d.checkout = normPiece(c.checkout, d.checkout.rot);
    }
  }
  return d;
}

/** 店内可摆放范围（本体中心；收购翼房后东扩）。 */
function placeBounds(gs) {
  const wing = gs && gs.expansion && gs.expansion.wing_right;
  return {
    minX: -6.3, // 主店西墙内（库房属仓储区，不开放摆放）
    maxX: wing ? 11.3 : 6.5,
    minZ: -3.5,
    maxZ: 4.2,
  };
}

/**
 * 移动一个构件（写入 customLayout，钳制店内范围）。
 * @param {object} gs
 * @param {'shelf'|'table'|'checkout'} kind
 * @param {number} idx table/shelf 用序号；checkout 传 0
 * @param {number} x @param {number} z
 * @param {number} [rot] 朝向（度数，90° 步进；缺省保留原值）
 * @returns {{x: number, z: number}} 实际落点（钳制后）
 */
export function moveLayoutPiece(gs, kind, idx, x, z, rot = null) {
  const b = placeBounds(gs);
  const px = Math.min(b.maxX, Math.max(b.minX, x));
  const pz = Math.min(b.maxZ, Math.max(b.minZ, z));
  if (!gs.customLayout) gs.customLayout = {};
  const prev = layoutOf(gs);
  const prevRot = kind === 'checkout' ? prev.checkout.rot
    : kind === 'shelf' ? prev.shelves[idx].rot
    : prev.tables[idx].rot;
  const r = rot === null ? prevRot : (((Math.round(rot / 90) % 4) + 4) % 4) * 90;
  if (kind === 'checkout') {
    gs.customLayout.checkout = { x: px, z: pz, rot: r };
  } else if (kind === 'shelf') {
    if (!gs.customLayout.shelves) gs.customLayout.shelves = {};
    gs.customLayout.shelves[idx] = { x: px, z: pz, rot: r };
  } else if (kind === 'table') {
    if (!gs.customLayout.tables) gs.customLayout.tables = {};
    gs.customLayout.tables[idx] = { x: px, z: pz, rot: r };
  }
  return { x: px, z: pz };
}

/** 构件前向偏移（本地 +z 旋转 rot 度后的世界 xz 偏移，供交互锚点用）。 */
export function frontOffset(rot, dist) {
  const rad = (rot * Math.PI) / 180;
  return { x: Math.sin(rad) * dist, z: Math.cos(rad) * dist };
}

/** 本地 (lx,lz) 绕 y 轴转 rot 度后的世界 (x,z)（与 three rotation.y=rot° 同向）。 */
export function rotOffset(rot, lx, lz) {
  const rad = (rot * Math.PI) / 180;
  return {
    x: lx * Math.cos(rad) + lz * Math.sin(rad),
    z: -lx * Math.sin(rad) + lz * Math.cos(rad),
  };
}

/** 恢复默认布局（清空覆盖）。 */
export function resetLayout(gs) {
  gs.customLayout = null;
}

/** 货架交互锚点（interaction.js 距离校验用；本体 + 前向偏移 1.1，随 rot 转向）。 */
export function shelfAnchorOf(gs, shelfIdx) {
  const s = layoutOf(gs).shelves[shelfIdx];
  if (!s) return null;
  const off = frontOffset(s.rot || 0, 1.1);
  return { x: s.x + off.x, z: s.z + off.z };
}
