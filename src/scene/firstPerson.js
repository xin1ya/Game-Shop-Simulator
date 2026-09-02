/**
 * firstPerson.js — 第一人称控制：Pointer Lock 鼠标环视 + WASD 平移 +
 * AABB 碰撞滑动 + 轻微头部摆动（bob）+ v2 交互几何工具。
 *
 * 本模块刻意不 import three、不在顶层触碰 DOM：
 * 纯函数（clamp / applyLook / computeMoveDelta / slideMove / buildObstacles /
 * distance2D / withinRange / aimScore / doorSlowFactor）
 * 可在 node --test 中直接导入做单元测试；
 * FirstPersonController 仅在构造函数与方法内使用 DOM / camera API。
 *
 * 坐标约定：y 为高度；yaw=0 时相机朝 -z；pitch 上仰为正。
 *
 * v2 增量（T09 / B22 / A06）：
 *   - bounds.maxZ 4.55 → 8.0（CONFIG.street.blockZ 未落地时按 8.0 降级）——
 *     单调放宽上界，室内障碍 AABB 一个不动
 *   - distance2D / withinRange：交互距离几何（唯一真值
 *     CONFIG.firstPerson.interactRange，本文件禁止自带 2.5 字面量）
 *   - aimScore：准星朝向锥（resolveTarget 拾取排序用）
 *   - doorSlowFactor：门口箱子堆积软惩罚（×0.7，不生成障碍 AABB）
 *
 * @module scene/firstPerson
 */

import { CONFIG } from '../config.js';

/** v2 可行走上界：CONFIG.street.blockZ 优先，未落地按架构定稿 8.0（B22）。 */
const OUTDOOR_MAX_Z = (CONFIG.street && typeof CONFIG.street.blockZ === 'number')
  ? CONFIG.street.blockZ : 8.0;

/**
 * 数值钳制。
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 两点 XZ 平面距离。 */
export function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

/**
 * 是否在交互距离内。
 * range 缺省读唯一真值 CONFIG.firstPerson.interactRange（裁决 8）。
 * @param {{x:number,z:number}} a
 * @param {{x:number,z:number}} b
 * @param {number} [range] 覆盖距离（测试用；业务代码禁止传字面量）
 * @returns {boolean}
 */
export function withinRange(a, b, range) {
  const r = typeof range === 'number' ? range
    : ((CONFIG.firstPerson && CONFIG.firstPerson.interactRange)
      ?? Number.POSITIVE_INFINITY);
  return distance2D(a, b) <= r;
}

/**
 * 准星朝向得分：aimDir 与 toTarget 的单位点积 ∈ [-1, 1]。
 * 1 = 正对目标；≥ aimConeCos 视为命中朝向锥。
 * @param {{x:number,z:number}} aimDir 已归一化的朝向向量
 * @param {{x:number,z:number}} toTarget 指向目标的向量（未归一化亦可）
 * @returns {number}
 */
export function aimScore(aimDir, toTarget) {
  const len = Math.hypot(toTarget.x, toTarget.z);
  if (len === 0) return 1; // 与目标重合：视为正对
  return (aimDir.x * toTarget.x + aimDir.z * toTarget.z) / len;
}

/**
 * 门口箱子堆积软惩罚（A06）：箱子超上限且玩家位于门口区域 → ×0.7。
 * 只影响移动速度，不生成障碍 AABB（保护室内 BFS 断言）。
 * @param {number} x 玩家 x
 * @param {number} z 玩家 z
 * @param {number} boxCount 门口非空箱数
 * @param {object} [cfg] 数值来源（默认 CONFIG.logistics / CONFIG.street，缺省用架构定稿值）
 * @returns {number} 速度倍率（1 或 doorSlowMult）
 */
export function doorSlowFactor(x, z, boxCount, cfg = null) {
  const c = cfg || {};
  const threshold = c.boxSlowThreshold
    ?? ((CONFIG.street && CONFIG.street.boxSlowThreshold) ?? 8);
  const mult = c.doorSlowMult
    ?? ((CONFIG.logistics && CONFIG.logistics.doorSlowMult) ?? 0.7);
  const doorX = c.doorX ?? 5.8;
  const doorZoneHalfW = c.doorZoneHalfW ?? 1.6;
  const doorZoneMinZ = c.doorZoneMinZ ?? 4.0;
  const inDoorZone = Math.abs(x - doorX) < doorZoneHalfW && z > doorZoneMinZ;
  return boxCount > threshold && inDoorZone ? mult : 1;
}

/**
 * v2 生效可行走范围：maxZ 单调放宽到街道外沿（B22）。
 * CONFIG.street.blockZ（或降级值 8.0）> CONFIG.firstPerson.bounds.maxZ 时取前者；
 * 永不低于配置原值 → 只增加自由格，不产生新封闭区域（裁决 3）。
 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}}
 */
/** v3 生效可行走范围：maxZ 放宽到全街；maxX=12 覆盖翼房（翼房内部形状由 wingObstacles 约束）。
 * @param {object|null} [gs] GameState（保留参数位；当前界与 expansion 无关）
 */
export function effectiveBounds(gs = null) {
  void gs;
  const b = CONFIG.firstPerson.bounds;
  return {
    minX: b.minX,
    maxX: b.maxX,
    minZ: b.minZ,
    maxZ: Math.max(b.maxZ, OUTDOOR_MAX_Z),
  };
}

/** 由 yaw 求已归一化的水平朝向向量（yaw=0 → -z）。 */
export function aimDirection(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * 鼠标环视：按灵敏度累加偏航 / 俯仰，俯仰钳制在 ±pitchLimit。
 * @param {number} yaw 当前偏航（弧度）
 * @param {number} pitch 当前俯仰（弧度）
 * @param {number} deltaX 鼠标水平位移（像素，右为正）
 * @param {number} deltaY 鼠标垂直位移（像素，下为正）
 * @param {number} sensitivity 弧度/像素
 * @param {number} pitchLimit 俯仰上限（弧度）
 * @returns {{yaw: number, pitch: number}}
 */
export function applyLook(yaw, pitch, deltaX, deltaY, sensitivity, pitchLimit) {
  return {
    yaw: yaw - deltaX * sensitivity,
    pitch: clamp(pitch - deltaY * sensitivity, -pitchLimit, pitchLimit),
  };
}

/** 前进 / 左右平移键位集合。 */
const KEY_FORWARD = ['KeyW', 'ArrowUp'];
const KEY_BACK = ['KeyS', 'ArrowDown'];
const KEY_LEFT = ['KeyA', 'ArrowLeft'];
const KEY_RIGHT = ['KeyD', 'ArrowRight'];

function hasAny(keys, codes) {
  return codes.some((c) => keys.has(c));
}

/**
 * 由按键集合与偏航计算本帧世界位移（归一化后乘以距离）。
 * @param {Set<string>} keys 按下的 KeyboardEvent.code 集合
 * @param {number} yaw 当前偏航（弧度）
 * @param {number} distance 本帧位移长度
 * @returns {{dx: number, dz: number}}
 */
export function computeMoveDelta(keys, yaw, distance) {
  let forward = 0;
  let strafe = 0;
  if (hasAny(keys, KEY_FORWARD)) forward += 1;
  if (hasAny(keys, KEY_BACK)) forward -= 1;
  if (hasAny(keys, KEY_RIGHT)) strafe += 1;
  if (hasAny(keys, KEY_LEFT)) strafe -= 1;
  if (forward === 0 && strafe === 0) return { dx: 0, dz: 0 };
  const len = Math.hypot(forward, strafe);
  forward /= len;
  strafe /= len;
  // yaw=0 朝 -z；前向 = (-sin yaw, -cos yaw)，右向 = (cos yaw, -sin yaw)
  return {
    dx: (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * distance,
    dz: (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * distance,
  };
}

/**
 * 货架视觉放大系数（shop.js buildShelf 的 shelf.scale x/y 与障碍 hx 共用真值）。
 * 货架升级时货架本体 x/y 放大、z 不变 → 碰撞 hx 同步放大、hz 不变。
 * @param {number} level 货架升级等级（CONFIG.upgrades.shelf，1~maxLevel）
 * @returns {number}
 */
export function shelfVisualScale(level) {
  const maxLevel = (CONFIG.upgrades && CONFIG.upgrades.maxLevel) || 3;
  const l = clamp(Math.floor(Number(level) || 1), 1, maxLevel);
  return 1 + 0.15 * (l - 1);
}

/**
 * 障碍描述（中心 + 半宽）展开为 AABB。
 * @param {{x: number, z: number, hx: number, hz: number}} o
 * @returns {{minX: number, maxX: number, minZ: number, maxZ: number}}
 */
export function expandObstacle(o) {
  return { minX: o.x - o.hx, maxX: o.x + o.hx, minZ: o.z - o.hz, maxZ: o.z + o.hz };
}

/**
 * 按店铺升级状态构建生效的障碍 AABB 列表。
 * @param {object} fpCfg CONFIG.firstPerson
 * @param {{tableCount?: number, decorLevel?: number, shelfLevel?: number, staffDoorOpen?: boolean, wingRight?: boolean, layout?: object}} [opts]
 *   tableCount：主区体验桌数（≤4）；wingRight：收购翼房 → 追加 2 张翼房桌障碍
 *   layout：layoutOf(gs) 有效布局（2026-09 布局模式；缺省 = 配置默认位）
 *   staffDoorOpen：库房门开=true（默认 true，测试连通性）；关门 → 门洞加障碍板
 * @returns {Array<{minX: number, maxX: number, minZ: number, maxZ: number}>}
 */
export function buildObstacles(fpCfg, {
  tableCount = 1, decorLevel = 1, shelfLevel = 1, staffDoorOpen = true, wingRight = false,
  layout = null,
} = {}) {
  // 货架：hx 随货架升级放大（z 不放大，与 shop.js shelf.scale.set(s, s, 1) 对齐）；
  // 布局 rot 90/270 → 长宽轴互换（旋转后占地转向）
  const shelfScale = shelfVisualScale(shelfLevel);
  const list = fpCfg.shelfObstacles.map((o, i) => {
    const pos = layout && layout.shelves && layout.shelves[i] ? layout.shelves[i] : o;
    const rot90 = pos.rot === 90 || pos.rot === 270;
    return expandObstacle({
      ...o, x: pos.x, z: pos.z,
      hx: rot90 ? o.hz : o.hx * shelfScale,
      hz: rot90 ? o.hx * shelfScale : o.hz,
    });
  });
  // 体验桌：前 4 个为主区（按 tableCount），后 2 个为翼房（wingRight 时启用）
  const n = clamp(Math.floor(tableCount), 0, 4);
  const tableAt = (i) => (layout && layout.tables && layout.tables[i]) || fpCfg.tableObstacles[i];
  const tableOb = (i) => {
    const t = fpCfg.tableObstacles[i];
    const pos = tableAt(i);
    const rot90 = pos.rot === 90 || pos.rot === 270;
    return expandObstacle({
      ...t, x: pos.x, z: pos.z,
      hx: rot90 ? t.hz : t.hx,
      hz: rot90 ? t.hx : t.hz,
    });
  };
  for (let i = 0; i < n; i += 1) {
    list.push(tableOb(i));
  }
  if (wingRight) {
    for (let i = 4; i < fpCfg.tableObstacles.length; i += 1) {
      list.push(tableOb(i));
    }
  }
  const checkoutPos = (layout && layout.checkout) || fpCfg.checkoutObstacle;
  const ckRot90 = checkoutPos.rot === 90 || checkoutPos.rot === 270;
  list.push(expandObstacle({
    ...fpCfg.checkoutObstacle, x: checkoutPos.x, z: checkoutPos.z,
    hx: ckRot90 ? fpCfg.checkoutObstacle.hz : fpCfg.checkoutObstacle.hx,
    hz: ckRot90 ? fpCfg.checkoutObstacle.hx : fpCfg.checkoutObstacle.hz,
  }));
  list.push(expandObstacle(fpCfg.plantObstacles[0]));
  if (decorLevel >= 2 && fpCfg.plantObstacles[1]) {
    list.push(expandObstacle(fpCfg.plantObstacles[1]));
  }
  // 临街墙壁 + 窗户（门洞 z=4.9 中央可通行）
  if (Array.isArray(fpCfg.frontWallObstacles)) {
    for (const o of fpCfg.frontWallObstacles) list.push(expandObstacle(o));
  }
  // v3 库房：左墙两段（让开门洞）+ 库房障碍 + 街道补阻挡
  if (Array.isArray(fpCfg.leftWallObstacles)) {
    for (const o of fpCfg.leftWallObstacles) list.push(expandObstacle(o));
  }
  if (Array.isArray(fpCfg.stockroomObstacles)) {
    for (const o of fpCfg.stockroomObstacles) list.push(expandObstacle(o));
  }
  if (Array.isArray(fpCfg.streetObstacles)) {
    for (const o of fpCfg.streetObstacles) list.push(expandObstacle(o));
  }
  // 远侧立面墙（全街步行外沿，白名单）
  if (fpCfg.farWallObstacle) {
    list.push(expandObstacle(fpCfg.farWallObstacle));
  }
  // 店内右墙：收购翼房 → 分段（门洞常通）+ 翼房三面墙；否则整墙
  if (wingRight && Array.isArray(fpCfg.rightWallObstacles)) {
    for (const o of fpCfg.rightWallObstacles) list.push(expandObstacle(o));
    for (const o of fpCfg.wingObstacles) list.push(expandObstacle(o));
  } else if (fpCfg.shopRightWallObstacle) {
    list.push(expandObstacle(fpCfg.shopRightWallObstacle));
  }
  // 库房门手动开关（2026-09）：关门时门洞有碰撞板
  if (!staffDoorOpen) {
    list.push(expandObstacle({ x: -6.9, z: -1, hx: 0.15, hz: 0.6 }));
  }
  return list;
}

/**
 * AABB 推挤滑动解算（分轴移动，无需物理引擎）：
 * 先沿 x 移动并钳制出障碍，再沿 z；每轴都被 bounds 钳制。
 * 已位于障碍内时按移动方向推出到最近边缘。
 * @param {{x: number, z: number}} pos 当前位置
 * @param {{dx: number, dz: number}} delta 期望位移
 * @param {number} radius 玩家碰撞半径
 * @param {Array<{minX: number, maxX: number, minZ: number, maxZ: number}>} obstacles
 * @param {{minX: number, maxX: number, minZ: number, maxZ: number}} bounds 可行走范围
 * @returns {{x: number, z: number}} 解算后的位置
 */
export function slideMove(pos, delta, radius, obstacles, bounds) {
  // x 轴：z 取移动前位置（分轴解算，贴墙滑动）
  let nx = clamp(pos.x + delta.dx, bounds.minX, bounds.maxX);
  for (const o of obstacles) {
    if (pos.z > o.minZ - radius && pos.z < o.maxZ + radius
        && nx > o.minX - radius && nx < o.maxX + radius) {
      nx = delta.dx >= 0 ? o.minX - radius : o.maxX + radius;
    }
  }
  nx = clamp(nx, bounds.minX, bounds.maxX);
  // z 轴：x 取解算后的新位置
  let nz = clamp(pos.z + delta.dz, bounds.minZ, bounds.maxZ);
  for (const o of obstacles) {
    if (nx > o.minX - radius && nx < o.maxX + radius
        && nz > o.minZ - radius && nz < o.maxZ + radius) {
      nz = delta.dz >= 0 ? o.minZ - radius : o.maxZ + radius;
    }
  }
  nz = clamp(nz, bounds.minZ, bounds.maxZ);
  return { x: nx, z: nz };
}

/**
 * 第一人称控制器。
 * 负责 Pointer Lock 事件配对、鼠标环视、键盘移动、碰撞与头部摆动，
 * 每帧把结果写入传入的透视相机。
 */
export class FirstPersonController {
  /**
   * @param {object} camera 透视相机（rotation.order 须为 'YXZ'）
   * @param {HTMLElement} domElement Pointer Lock 目标元素（canvas）
   * @param {object} cfg CONFIG.firstPerson
   */
  constructor(camera, domElement, cfg) {
    this.camera = camera;
    this.dom = domElement;
    this.cfg = cfg;
    this.pitchLimit = (cfg.pitchClampDeg * Math.PI) / 180;
    /** v2 生效 bounds（maxZ 放宽到街道；室内不变）。 */
    this.bounds = effectiveBounds();
    /** 门口软惩罚倍率（每帧由 main.js 注入，默认无惩罚）。 */
    this.speedMult = 1;

    this.yaw = cfg.spawn.yaw;
    this.pitch = 0;
    this.x = cfg.spawn.x;
    this.z = cfg.spawn.z;

    /** @type {Set<string>} */
    this.keys = new Set();
    this.locked = false;
    /** @type {Array} 生效障碍 AABB 列表（由 setObstacles 注入） */
    this.obstacles = [];
    this.bobPhase = 0;
    this.bobAmount = 0;
    /** @type {Function|null} 锁定状态变化回调（参数：locked） */
    this.onLockChange = null;

    this._onMouseMove = (ev) => {
      if (!this.locked) return;
      const r = applyLook(
        this.yaw, this.pitch, ev.movementX, ev.movementY,
        this.cfg.mouseSensitivity, this.pitchLimit,
      );
      this.yaw = r.yaw;
      this.pitch = r.pitch;
    };
    this._onKeyDown = (ev) => {
      if (this.locked) this.keys.add(ev.code);
    };
    this._onKeyUp = (ev) => {
      this.keys.delete(ev.code);
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) this.keys.clear(); // 防按键卡死
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
  }

  /** 请求 Pointer Lock（必须由用户手势触发）。 */
  enter() {
    if (!this.locked) this.dom.requestPointerLock();
  }

  /** 退出 Pointer Lock（未锁定时为无害空操作）。 */
  exit() {
    if (this.locked) document.exitPointerLock();
  }

  /** 回到出生点并清零视角 / 摆动 / 按键状态（开门时调用）。 */
  reset() {
    this.yaw = this.cfg.spawn.yaw;
    this.pitch = 0;
    this.x = this.cfg.spawn.x;
    this.z = this.cfg.spawn.z;
    this.keys.clear();
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.applyCamera();
  }

  /** @param {Array} obstacles buildObstacles 的返回列表 */
  setObstacles(obstacles) {
    this.obstacles = obstacles;
  }

  /** 把当前位置 / 视角 / 摆动写入相机。 */
  applyCamera() {
    const bobY = Math.sin(this.bobPhase) * this.cfg.bobAmplitude * this.bobAmount;
    this.camera.position.set(this.x, this.cfg.eyeHeight + bobY, this.z);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  /**
   * 每帧更新：仅在锁定时响应移动；未锁定时摆动衰减、相机保持原位。
   * @param {number} dt 真实帧间隔（秒）
   */
  update(dt) {
    if (this.locked) {
      const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = this.cfg.moveSpeed * (sprint ? this.cfg.sprintMult : 1) * this.speedMult;
      const delta = computeMoveDelta(this.keys, this.yaw, speed * dt);
      const moving = delta.dx !== 0 || delta.dz !== 0;
      if (moving) {
        const next = slideMove(
          { x: this.x, z: this.z }, delta,
          this.cfg.playerRadius, this.obstacles, this.bounds,
        );
        this.x = next.x;
        this.z = next.z;
        this.bobPhase += dt * this.cfg.bobFrequency;
        this.bobAmount = Math.min(1, this.bobAmount + dt * 6);
      } else {
        this.bobAmount = Math.max(0, this.bobAmount - dt * 6);
      }
    } else {
      this.bobAmount = Math.max(0, this.bobAmount - dt * 6);
    }
    this.applyCamera();
  }
}
