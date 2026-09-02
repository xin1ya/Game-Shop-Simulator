/**
 * stockroom.js — 库房（v3 需求 10）：左墙（x=-6.9，门洞 z∈[-1.6,-0.4]）后的真实房间。
 *
 * 静态：地板 / 西+北+南三面墙 / 垃圾桶 / 纸板堆底座（2026-09 取消置物架，
 *   库房直接放未拆封快递箱——placeBox 落在库房地面，street.js 箱子渲染）。
 * 动态（sync(gs)）：纸板堆按 gs.stockroom.cardboard 增减（至多可视 8 张）。
 *
 * 不新增障碍 AABB（碰撞在 config.firstPerson.stockroomObstacles 手工对齐）。
 *
 * @module scene/stockroom
 */

import * as THREE from 'three';
import { makeToonMaterial, addOutline, makeLabelPlane } from './scene.js';
import { CONFIG } from '../config.js';

/** 房间范围（与 config.firstPerson.stockroomObstacles / layout.stockroom 对齐）。 */
const ROOM = { x0: -10.4, x1: -6.9, z0: -4.2, z1: 2.2 };
/** 纸板堆位置（南墙根）。 */
const CARDBOARD_POS = { x: -8.2, z: 1.85 };
const MAX_CARDBOARD_SHEETS = 8;

function box(w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makeToonMaterial(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  addOutline(mesh);
  return mesh;
}

/** 垃圾桶（深绿圆桶 + 桶口沿）。 */
function buildTrashBin() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.18, 0.5, 12),
    makeToonMaterial(0x4a6b4f),
  );
  body.position.y = 0.25;
  body.castShadow = true;
  addOutline(body);
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.25, 0.06, 12),
    makeToonMaterial(0x3a5a3e),
  );
  rim.position.y = 0.52;
  addOutline(rim);
  g.add(body, rim);
  return g;
}

/** 纸板一张（压扁的纸箱）。 */
function makeCardboardSheet(i) {
  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.025, 0.4),
    makeToonMaterial(0xc9a25f),
  );
  sheet.position.set(
    CARDBOARD_POS.x + (i % 2) * 0.03,
    0.015 + i * 0.028,
    CARDBOARD_POS.z - (i % 2) * 0.03,
  );
  sheet.rotation.y = (i % 2) * 0.12;
  sheet.castShadow = true;
  addOutline(sheet);
  return sheet;
}

/**
 * 构建库房。
 * @param {THREE.Scene} scene
 * @returns {{group: THREE.Group, sync: Function}}
 */
export function buildStockroom(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // ---- 静态房间 ----
  const WALL = 0xe8d5ae; // 库房墙比店内略深
  const cx = (ROOM.x0 + ROOM.x1) / 2;
  const cz = (ROOM.z0 + ROOM.z1) / 2;
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM.x1 - ROOM.x0 + 0.3, 0.3, ROOM.z1 - ROOM.z0 + 0.3),
    makeToonMaterial(0xd8c49a),
  );
  floor.position.set(cx, -0.15, cz);
  floor.receiveShadow = true;
  group.add(floor);
  // 西/北/南三面墙（东侧面即店内左墙 + 门洞，由 shop.js 处理）
  group.add(box(0.3, 2.6, ROOM.z1 - ROOM.z0 + 0.3, WALL, ROOM.x0, 1.3, cz));
  group.add(box(ROOM.x1 - ROOM.x0 + 0.3, 2.6, 0.3, WALL, cx, 1.3, ROOM.z0));
  group.add(box(ROOM.x1 - ROOM.x0 + 0.3, 2.6, 0.3, WALL, cx, 1.3, ROOM.z1));
  // 垃圾桶
  const bin = buildTrashBin();
  bin.position.set(CONFIG.layout.trashBin.x, 0, CONFIG.layout.trashBin.z);
  group.add(bin);
  // 纸板堆底座木托
  group.add(box(0.6, 0.04, 0.5, 0x8a5a2b, CARDBOARD_POS.x, 0.02, CARDBOARD_POS.z));

  // ---- 动态层 ----
  const dynGroup = new THREE.Group();
  group.add(dynGroup);
  let cardboardShown = -1;

  return {
    group,
    /** 每帧刷新：货架存货 + 纸板堆。 */
    sync(gs) {
      // 纸板堆
      const cb = Math.min((gs.stockroom && gs.stockroom.cardboard) || 0, MAX_CARDBOARD_SHEETS);
      if (cb !== cardboardShown) {
        cardboardShown = cb;
        dynGroup.children
          .filter((o) => o.userData.cardboard)
          .forEach((o) => dynGroup.remove(o));
        for (let i = 0; i < cb; i += 1) {
          const sheet = makeCardboardSheet(i);
          sheet.userData.cardboard = true;
          dynGroup.add(sheet);
        }
      }
    },
  };
}
