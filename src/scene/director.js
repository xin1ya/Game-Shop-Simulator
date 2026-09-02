/**
 * director.js — 桥接层：把 DaySession 中顾客的 sim 状态映射为
 * 3D 实体的移动 / 动画 / 心情气泡，并支持点击拾取。
 *
 * v2（T08）：QUEUED 沿收银台排队站位、需求气泡（emoji+SKU+售价，优先于心情气泡）、
 * 员工实体（复用 Q 版小人）、同屏上限 24。
 *
 * 只读 sim 状态，不回写；移动采用"目标点缓动"近似（视觉层自由发挥）。
 *
 * @module scene/director
 */

import * as THREE from 'three';
import { buildCharacter, buildStaffCharacter, makeBubble, setBubbleEmoji, disposeCharacter } from './character.js';
import { shelfIndexOfSku, shelfIndexOfCat } from '../sim/logistics.js';
import { staffTargetOf } from '../sim/staff.js';
import { slideMove, buildObstacles, effectiveBounds } from './firstPerson.js';
import { layoutOf } from '../sim/layout.js';
import { CONFIG } from '../config.js';

/** 顾客/员工避障半径（slideMove 用，略小于玩家 0.28）。 */
const NPC_RADIUS = 0.25;

/**
 * NPC 避障移动（2026-09 寻路优化）：slideMove 分轴滑墙 + 卡死检测侧移绕行。
 * slideMove 在「目标点位于障碍边缘另一侧」时会死锁（前进轴被挡、滑动轴已到）——
 * 检测到几乎没移动时，沿垂直于目标的切线方向侧移（沿墙走向角点，过角点后前进轴恢复自由）。
 * @returns {boolean} 是否发生了位移
 */
function moveNpcWithAvoidance(pos, target, step, obstacles, bounds) {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= 0.02) return false;
  const delta = { dx: (dx / dist) * step, dz: (dz / dist) * step };
  const moved = slideMove({ x: pos.x, z: pos.z }, delta, NPC_RADIUS, obstacles, bounds);
  const movedDist = Math.hypot(moved.x - pos.x, moved.z - pos.z);
  if (movedDist >= step * 0.2) {
    pos.x = moved.x;
    pos.z = moved.z;
    return true;
  }
  // 卡住：沿墙侧移（左右各试一次，走能走的那侧）
  for (const s of [1, -1]) {
    const side = { dx: (-dz / dist) * step * s, dz: (dx / dist) * step * s };
    const alt = slideMove({ x: pos.x, z: pos.z }, side, NPC_RADIUS, obstacles, bounds);
    if (Math.hypot(alt.x - pos.x, alt.z - pos.z) > step * 0.5) {
      pos.x = alt.x;
      pos.z = alt.z;
      return true;
    }
  }
  pos.x = moved.x;
  pos.z = moved.z;
  return movedDist > 1e-6;
}

/** 各状态对应的心情气泡 emoji。 */
const STATE_EMOJI = {
  EXPERIENCING: '🎲',
  PAYING: '💰',
  QUEUED: '💳',
  LEAVING: '❤️',
  LEAVING_ANGRY: '💢',
};

/**
 * ★ 行为气泡常态化（第 4 项）：顾客进店后头顶持续显示「想要什么」。
 * 想买周边 → 对应 SKU emoji；想买桌游/体验 → 对应桌游 emoji 或 🎲；
 * 排队结账 → 💳；购买后离开 → ❤️；怒走 → 💢。
 * 优先级：需求气泡（可交互）> 结账/体验状态 > 想要商品 > 无。
 * @param {object} c Customer
 * @param {object} gs GameState
 * @returns {string|null}
 */
function behaviorEmoji(c, gs) {
  // 结账/体验状态优先（是"行为"不是"想要"）
  if (c.state === 'QUEUED' || c.state === 'PAYING') return '💳';
  if (c.state === 'EXPERIENCING') return '🎲';
  if (c.state === 'LEAVING_ANGRY') return '💢';
  if (c.state === 'LEAVING') return c.bought.length > 0 ? '❤️' : null;
  // 想要的具体商品（targetSku 已确定 → 对应 SKU emoji）
  if (c.targetSku && CONFIG.skus[c.targetSku]) {
    return CONFIG.skus[c.targetSku].emoji;
  }
  // 想要品类（浏览中，target 是品类）→ 品类代表 emoji
  if (c.target && CONFIG.products[c.target]) {
    return CONFIG.products[c.target].emoji;
  }
  // 去体验区（想玩游戏）
  if (c.state === 'TO_EXPERIENCE') return '🎲';
  return null;
}

export class Director {
  /**
   * @param {THREE.Scene} scene
   * @param {{positions: object}} shopCtx buildShop 返回值
   */
  constructor(scene, shopCtx) {
    this.scene = scene;
    this.shopCtx = shopCtx;
    /** @type {Map<number, {group: THREE.Group, bubble: THREE.Sprite, type: string, bobPhase: number, moving: boolean}>} */
    this.entities = new Map();
    this.raycaster = new THREE.Raycaster();
  }

  /** 按顾客当前 sim 状态取目标世界坐标。v3：浏览目标 = 目标商品所在货架。 */
  targetFor(c, gs = null) {
    const p = this.shopCtx.positions;
    switch (c.state) {
      case 'ENTERING':
        return p.waitPoint;
      case 'BROWSING': {
        // 目标 SKU（已定）→ 所在货架；只有品类意向 → 该品类有货的第一个货架；都没有 → 中岛
        let idx = -1;
        if (gs && c.targetSku) idx = shelfIndexOfSku(gs, c.targetSku);
        if (idx < 0 && gs && c.target) idx = shelfIndexOfCat(gs, c.target);
        return (idx >= 0 && p.shelves[idx]) || p.waitPoint;
      }
      case 'TO_EXPERIENCE':
        return (c.slotId !== null && p.experienceSlots[c.slotId]) || p.queuePoint;
      case 'EXPERIENCING':
        return (c.slotId !== null && p.experienceSlots[c.slotId]) || p.queuePoint;
      case 'QUEUED': {
        // v2：按队列位置站位（queue 数组下标 → queueSlots）
        const idx = this._queueIndex(c);
        return p.queueSlots && p.queueSlots[idx]
          ? p.queueSlots[idx]
          : p.checkout;
      }
      case 'TO_CHECKOUT':
      case 'PAYING':
        return p.checkout;
      case 'LEAVING':
      case 'LEAVING_ANGRY':
        return p.door;
      default:
        return p.door;
    }
  }

  /** 顾客在队列中的下标（由最近一次 sync 的 session.queue 缓存）。 */
  _queueIndex(c) {
    const q = this._lastQueue || [];
    const idx = q.indexOf(c.id);
    return idx === -1 ? 0 : idx;
  }

  /**
   * 每帧同步：新增 / 移动 / 移除顾客实体，刷新气泡与走路动画。
   * v2：同步需求气泡（优先于心情气泡）、缓存队列顺序、同步员工实体。
   * @param {object} session DaySession
   * @param {number} dt 真实帧间隔（秒）
   * @param {number} elapsed 累计时间（秒，用于摇摆动画）
   * @param {object|null} gs GameState（v2：需求气泡需要；可空降级）
   */
  sync(session, dt, elapsed, gs = null) {
    this._lastQueue = session.queue || [];
    // 2026-09 寻路优化：顾客/员工移动统一走 slideMove 避障（货架/桌子/墙体滑墙绕行）。
    // 障碍列表每帧按当前布局重建（布局模式拖动后即时生效；~30 个 AABB 构建开销可忽略）。
    let obstacles = null;
    let bounds = null;
    if (gs) {
      obstacles = buildObstacles(CONFIG.firstPerson, {
        tableCount: (this.shopCtx.positions.mainTableCount ?? 1),
        decorLevel: gs.upgrades.decor,
        shelfLevel: gs.upgrades.shelf,
        staffDoorOpen: gs.staffDoorOpen === true,
        wingRight: gs.expansion && gs.expansion.wing_right === true,
        layout: layoutOf(gs),
      });
      bounds = effectiveBounds(gs);
    }
    // 需求气泡优先表：customerId → emoji（含 SKU 信息时叠加在 emoji 上）
    const needEmoji = new Map();
    for (const n of session.needs || []) {
      if (n.state !== 'PENDING' && n.state !== 'CLAIMED') continue;
      const def = CONFIG.needs.types[n.kind];
      if (def) needEmoji.set(n.customerId, def.emoji);
    }
    const alive = new Set();
    for (const c of session.customers) {
      alive.add(c.id);
      let ent = this.entities.get(c.id);
      if (!ent) {
        const group = buildCharacter(c.type);
        group.userData.customerId = c.id;
        group.position.copy(this.shopCtx.positions.door);
        const bubble = makeBubble();
        group.add(bubble);
        this.scene.add(group);
        ent = { group, bubble, type: c.type, bobPhase: (c.id * 1.7) % Math.PI, moving: false };
        this.entities.set(c.id, ent);
      }

      // 目标点缓动移动（2026-09：slideMove 避障 + 卡死侧移绕行，绕开货架/桌子/墙体）
      const target = this.targetFor(c, gs);
      const pos = ent.group.position;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = Math.min(dist, dt * 3.2);
      if (dist > 0.02) {
        if (obstacles) {
          moveNpcWithAvoidance(pos, target, step, obstacles, bounds);
        } else {
          pos.x += (dx / dist) * step;
          pos.z += (dz / dist) * step;
        }
        ent.group.rotation.y = Math.atan2(dx, dz);
        ent.moving = true;
      } else {
        ent.moving = false;
      }
      // sim 位姿回写（需求气泡距离判定用，只读不写语义外的字段）
      c.pos.x = pos.x;
      c.pos.z = pos.z;

      // 走路摇摆 / 站立呼吸
      const limbs = ent.group.userData.limbs;
      if (limbs) {
        if (ent.moving) {
          const swing = Math.sin(elapsed * 10 + ent.bobPhase) * 0.5;
          limbs.legL.rotation.x = swing;
          limbs.legR.rotation.x = -swing;
          pos.y = Math.abs(Math.sin(elapsed * 10 + ent.bobPhase)) * 0.05;
        } else {
          limbs.legL.rotation.x = 0;
          limbs.legR.rotation.x = 0;
          pos.y = Math.sin(elapsed * 2.2 + ent.bobPhase) * 0.02 + 0.02;
        }
      }

      // 气泡：需求气泡优先于行为气泡（★ 常态化显示想要什么，B12/第4项）
      let emoji = needEmoji.get(c.id) || (gs ? behaviorEmoji(c, gs) : (STATE_EMOJI[c.state] || null));
      setBubbleEmoji(ent.bubble, emoji);
    }

    // 移除已离店实体（员工 key 是字符串 'staff-N'，由下方 staffAlive 循环单独处理——
    // 否则员工每帧被删又重建、永远钉在出生点：「员工固定在原吧台」bug 的根因）
    for (const [id, ent] of this.entities) {
      if (typeof id === 'string' && id.startsWith('staff-')) continue;
      if (!alive.has(id)) {
        this.scene.remove(ent.group);
        disposeCharacter(ent.group);
        this.entities.delete(id);
      }
    }

    // ---- 员工实体（复用 Q 版小人，按任务点走动）----
    if (gs && gs.staff) {
      const staffAlive = new Set();
      for (const m of gs.staff.members) {
        if (!m.onDutyToday) continue;
        const key = `staff-${m.id}`;
        staffAlive.add(key);
        let ent = this.entities.get(key);
        if (!ent) {
          const group = buildStaffCharacter(m.role);
          group.position.copy(this.shopCtx.positions.door); // 从店门入场（避免出生在收银台障碍内被挤出）
          const bubble = makeBubble();
          group.add(bubble);
          this.scene.add(group);
          ent = { group, bubble, type: m.role, bobPhase: m.id * 1.3, moving: false };
          this.entities.set(key, ent);
        }
        // 员工目标点：sim 任务系统联动（staffTargetOf；仓管走箱/导购走向需求顾客）
        const p = this.shopCtx.positions;
        const target = staffTargetOf(gs, session, p, m);
        const pos = ent.group.position;
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const step = Math.min(dist, dt * 3.0);
        if (dist > 0.02) {
          if (obstacles) {
            moveNpcWithAvoidance(pos, target, step, obstacles, bounds);
          } else {
            pos.x += (dx / dist) * step;
            pos.z += (dz / dist) * step;
          }
          ent.group.rotation.y = Math.atan2(dx, dz);
          ent.moving = true;
        } else {
          ent.moving = false;
        }
        const limbs = ent.group.userData.limbs;
        if (limbs) {
          const swing = ent.moving ? Math.sin(elapsed * 9 + ent.bobPhase) * 0.5 : 0;
          limbs.legL.rotation.x = swing;
          limbs.legR.rotation.x = -swing;
        }
        // 员工气泡：岗位 emoji（常驻淡显示）
        const roleDef = CONFIG.employees.roles[m.role];
        setBubbleEmoji(ent.bubble, roleDef ? roleDef.emoji : null);
      }
      for (const [id, ent] of this.entities) {
        // key 混用：数字=顾客 id，字符串 'staff-N'=员工 id；只对字符串调 startsWith
        if (typeof id === 'string' && id.startsWith('staff-') && !staffAlive.has(id)) {
          this.scene.remove(ent.group);
          disposeCharacter(ent.group);
          this.entities.delete(id);
        }
      }
    }
  }

  /**
   * 点击拾取顾客。
   * @param {number} ndcX 归一化设备坐标 x（-1~1）
   * @param {number} ndcY 归一化设备坐标 y（-1~1）
   * @param {THREE.Camera} camera
   * @returns {number|null} 顾客 id
   */
  pickCustomer(ndcX, ndcY, camera) {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const groups = [...this.entities.values()].map((e) => e.group);
    const hits = this.raycaster.intersectObjects(groups, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node) {
        if (typeof node.userData.customerId === 'number') {
          return node.userData.customerId;
        }
        node = node.parent;
      }
    }
    return null;
  }

  /** 清空全部顾客实体（换天/重开时调用）。 */
  clear() {
    for (const [, ent] of this.entities) {
      this.scene.remove(ent.group);
      disposeCharacter(ent.group);
    }
    this.entities.clear();
  }
}
