/**
 * main.js — 薄编排：初始化 sim / scene / ui，主循环 rAF，阶段切换。
 *
 * v2 阶段流：TITLE → MORNING（SKU 进货/定价/升级/员工）→ PREP（备货 90s：
 * 货车到店卸箱、开箱/取货/上架）→ OPEN（营业 105s：顾客/结账/气泡响应）→
 * CLOSING（日结，含薪资）→ MORNING …；GAMEOVER / VICTORY 结局画面。
 *
 * 第一人称交互：准星对准目标按住 F（开箱 1.5s / 取货 0.6s / 上架 4.0s /
 * 结账 2.0s / 响应气泡 1.5s），2.5m 距离闸门；等距俯瞰模式无距离限制。
 * V 键切换视角；Z 键切换等距预设（店内/街道）；Tab 后仓面板。
 *
 * @module main
 */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { newGame } from './sim/gameState.js';
import { setPrice, setSkuPrice, buyUpgrade, settleDay, restock, buyExpansion } from './sim/economy.js';
import {
  rollDailyEvent, startPrepSession, startOpenSession, stepSession,
  nextDay, applyMorningActions, closeOutDay, getCheckoutOrder, startEveningSession,
} from './sim/day.js';
import { saveGame, loadGame, hasSave, clearSave } from './sim/save.js';
import {
  resolveTarget, beginHold, cancelHold, holdProgress,
} from './sim/interaction.js';
import { activeNeeds, needDisplay, respondNeed } from './sim/needs.js';
import { doorBoxCount, takeOutToHands, pushBox, takeSlotToHands } from './sim/logistics.js';
import { layoutOf, moveLayoutPiece } from './sim/layout.js';
import {
  createRenderer, createIsometricCamera, createFirstPersonCamera,
  createLights, setPhaseLighting, handleResize, applyIsoPreset,
} from './scene/scene.js';
import { buildShop, animateDoors } from './scene/shop.js';
import { buildStreet } from './scene/street.js';
import { buildShelves } from './scene/shelf.js';
import { buildStockroom } from './scene/stockroom.js';
import { Director } from './scene/director.js';
import {
  FirstPersonController, buildObstacles, aimDirection, doorSlowFactor,
  computeMoveDelta, slideMove, effectiveBounds,
} from './scene/firstPerson.js';
import { buildManagerCharacter, playManagerAnim } from './scene/character.js';
import { CarryView } from './scene/carryView.js';
import { Hud } from './ui/hud.js';
import {
  showTitle, showMorning, showBackroom, showClosing, showGameOver, showVictory, closePanels,
  showMall, showTakeout, isTakeoutOpen, showChangePanel, isChangeOpen,
  showPricePanel, isPricePanelOpen,
} from './ui/panels.js';
import {
  openCodex, isCodexOpen, showCustomerCard, closeCustomerCard, showStoryPopup, isStoryOpen,
} from './ui/codex.js';

// ---------- 全局上下文 ----------
const canvas = document.getElementById('scene-canvas');
const hudRoot = document.getElementById('hud-root');
const panelRoot = document.getElementById('panel-root');
const popupRoot = document.getElementById('popup-root');

const renderer = createRenderer(canvas);
const camera = createIsometricCamera();
const fpCamera = createFirstPersonCamera(CONFIG.firstPerson.fov);
const scene3d = new THREE.Scene();
scene3d.background = new THREE.Color(0xffe9c4);
scene3d.fog = new THREE.Fog(0xffe9c4, 30, 60);
const lights = createLights(scene3d);

/** @type {object|null} GameState */
let gs = null;
/** @type {object|null} DaySession（PREP/OPEN 共用同一 session 对象） */
let session = null;
/** @type {object|null} 种子随机数（随档保存 state） */
let rng = null;
let shopCtx = null;
let streetCtx = null;
let shelfCtx = null;
/** @type {object|null} 库房（v3） */
let stockCtx = null;
let director = null;
let hud = null;
let accumulator = 0;
let lastTime = 0;
/** @type {'fps'|'iso'} 视角模式：第一人称 / 全局俯瞰（V 键切换） */
let viewMode = 'fps';
/** @type {'shop'|'street'} 等距预设（Z 键切换） */
let isoPreset = 'shop';
/** @type {FirstPersonController|null} */
let fp = null;
/** 找零面板状态（需求 4）：当前面板 + 面板锁定的顾客 id。 */
let changePanel = null;
let changePanelCustomer = null;

/** 打开找零面板（玩家结账通道：答对即完成队首结账）。 */
function openChangePanel(order) {
  if (changePanel && changePanel.isOpen()) return;
  if (fp) fp.exit(); // 面板需要光标
  changePanelCustomer = order.customerId;
  changePanel = showChangePanel(popupRoot, order, {
    onCorrect() {
      if (session) session.playerPayDone += 1; // stepCheckout 下一 tick 立即完成
      changePanelCustomer = null;
    },
    onWrong() {
      const c = session && session.customers.find((x) => x.id === order.customerId);
      if (c) c.changeWrong = true; // 该客满意度封顶 0
    },
    onGiveUp() {},
  });
}

/**
 * 准星交互（2026-09）：左键 = 放置/操作/服务，右键 = 拾起（F 保留为左键别名）。
 * @param {'lmb'|'rmb'} btn
 */
function doInteract(btn) {
  if (!inSession() || !session) return;
  if (layoutMode) return; // 布局模式下走拖放，不走常规交互
  if (isTakeoutOpen(popupRoot) || isChangeOpen(popupRoot) || isPricePanelOpen(popupRoot)) return;
  const target = resolveTarget(gs, session, playerCtx(), btn);
  if (!target) return;
  if (target.kind === 'takeout') {
    if (fp) fp.exit();
    showTakeout(popupRoot, gs, {
      onPick(skuId) {
        takeOutToHands(gs, session, skuId);
        hud.setCarry(session.carry);
      },
      onClose() {},
    });
    return;
  }
  if (target.kind === 'pay') {
    const order = getCheckoutOrder(gs, session);
    if (order) openChangePanel(order); // 手动结账仅找零小游戏
    return;
  }
  beginHold(gs, session, target.kind, target.targetId, playerCtx());
}

// ---------- 货架 raycast（价签调价 / 拿货重摆，2026-09） ----------
const shelfRaycaster = new THREE.Raycaster();

/**
 * 从屏幕 ndc 发射线，找货架上的「价格标签 / 商品格」。
 * prefer 指定优先 kind：先扫全部命中找 prefer 类，没有再退而取另一类
 * （同一射线上商品和价签常先后命中——左键调价要穿透商品命中价签，右键拿货反之）。
 * @returns {{kind:'priceTag'|'shelfSlot', slotIdx:number}|null}
 */
function pickShelfSpot(ndcX, ndcY, cam, prefer = null) {
  if (!scene3d || !cam) return null;
  shelfRaycaster.setFromCamera({ x: ndcX, y: ndcY }, cam);
  const hits = shelfRaycaster.intersectObjects(scene3d.children, true);
  let first = null;
  let preferred = null;
  for (const h of hits) {
    let o = h.object;
    let found = null;
    while (o && !found) {
      if (o.userData && o.userData.priceTag) {
        found = { kind: 'priceTag', slotIdx: o.userData.shelfSlot };
      } else if (o.userData && typeof o.userData.shelfSlot === 'number') {
        found = { kind: 'shelfSlot', slotIdx: o.userData.shelfSlot };
      }
      o = o.parent;
    }
    if (!found) continue;
    if (!first) first = found;
    if (prefer && found.kind === prefer) { preferred = found; break; }
  }
  return preferred || first;
}

/** 打开价签调价面板（fp 先退锁交还光标）。 */
function openShelfPricePanel(slotIdx) {
  const slot = gs && gs.shelfSlots ? gs.shelfSlots[slotIdx] : null;
  const skuId = slot && slot.qty > 0 ? slot.sku : null;
  if (!skuId) return;
  if (fp) fp.exit();
  showPricePanel(popupRoot, gs, skuId, {
    onSet(price) {
      setSkuPrice(gs, skuId, price);
      persist();
    },
    onClose() {},
  });
}

/** 右键拿起货架一整格商品入双手（空手才生效）。 */
function tryTakeShelfSlot(slotIdx) {
  if (!inSession() || !session) return false;
  if (session.carry) return false;
  if (!takeSlotToHands(gs, session, slotIdx)) return false;
  hud.setCarry(session.carry);
  persist();
  return true;
}

// ---------- 布局模式（2026-09：EVENING 打烊后调整构件位置） ----------

/** 布局模式开关（仅 EVENING 可开；离开 EVENING 自动关）。 */
function setLayoutMode(on) {
  if (on && (!gs || gs.phase !== 'EVENING')) return;
  if (layoutDrag) cancelLayoutDrag(); // 拖动中切换 = 取消
  layoutMode = on;
  hud.setHint(on ? '🧱 布局模式：右键拾起构件 → 移动鼠标 → R 旋转 → 左键放下 / 右键取消（B 退出）' : null);
}

/** 射线 ∩ 地面（y=0）交点；fp 限距 7m 防构件甩到天边。 */
function groundPointAt(ndcX, ndcY, cam) {
  shelfRaycaster.setFromCamera({ x: ndcX, y: ndcY }, cam);
  const p = new THREE.Vector3();
  if (!shelfRaycaster.ray.intersectPlane(groundPlane, p)) return null;
  if (fpsActive()) {
    const dx = p.x - fp.x;
    const dz = p.z - fp.z;
    const d = Math.hypot(dx, dz);
    if (d > 7) { p.x = fp.x + (dx / d) * 7; p.z = fp.z + (dz / d) * 7; }
  }
  return p;
}

/** 射线拾取可移动构件（货架/体验桌/收银台），返回 {kind, idx, group, rot}。 */
function pickLayoutPiece(ndcX, ndcY, cam) {
  shelfRaycaster.setFromCamera({ x: ndcX, y: ndcY }, cam);
  const hits = shelfRaycaster.intersectObjects(scene3d.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o) {
      if (o.userData && o.userData.layoutKind) {
        const kind = o.userData.layoutKind;
        const idx = o.userData.layoutIdx ?? 0;
        const lay = layoutOf(gs);
        const piece = kind === 'checkout' ? lay.checkout
          : kind === 'shelf' ? lay.shelves[idx] : lay.tables[idx];
        return {
          kind, idx, group: o, rot: (piece && piece.rot) || 0,
        };
      }
      o = o.parent;
    }
  }
  return null;
}

/** 每帧拖动：构件跟随指针地面点（0.2m 网格吸附；视觉暂移，放下才写数据）。 */
function stepLayoutDrag() {
  if (!layoutDrag) return;
  const cam = fpsActive() ? fpCamera : camera;
  const ndc = fpsActive() ? { x: 0, y: 0 } : pointerNdc;
  const p = groundPointAt(ndc.x, ndc.y, cam);
  if (!p) return;
  layoutDrag.group.position.set(
    Math.round(p.x / 0.2) * 0.2,
    layoutDrag.group.position.y,
    Math.round(p.z / 0.2) * 0.2,
  );
}

/** 左键放下：写 customLayout（含 rot 朝向）→ 重建场景与碰撞 → 存档。 */
function commitLayoutDrag() {
  const { kind, idx, group, rot } = layoutDrag;
  layoutDrag = null;
  moveLayoutPiece(gs, kind, idx, group.position.x, group.position.z, rot ?? 0);
  shopCtx.rebuild(gs);
  fp.setObstacles(buildObstacles(CONFIG.firstPerson, {
    tableCount: shopCtx.positions.mainTableCount ?? 1,
    decorLevel: gs.upgrades.decor,
    shelfLevel: gs.upgrades.shelf,
    staffDoorOpen: gs.staffDoorOpen === true,
    wingRight: gs.expansion && gs.expansion.wing_right === true,
    layout: layoutOf(gs),
  }));
  persist();
}

/** 右键取消：重建回位（数据未写，构件弹回原位置）。 */
function cancelLayoutDrag() {
  layoutDrag = null;
  shopCtx.rebuild(gs);
}
/** ★ 俯瞰视角的店长小人实体与逻辑位置（第 7 项：俯瞰=第三人称操纵店长）。 */
let manager = null;
const managerPos = { x: 0, z: 3.6 };
/** 布局模式（2026-09，仅 EVENING）：右键拾起构件 → 跟随指针 → 左键放下 / 右键取消。 */
let layoutMode = false;
/** 拖动中：{kind, idx, group}；group = shop 场景里的构件根（放下/取消时 rebuild 销毁）。 */
let layoutDrag = null;
/** 最近一次指针 ndc（iso 拖动跟手用）。 */
const pointerNdc = { x: 0, y: 0 };
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** 俯瞰移动按键集合（等距无 pointer lock，需独立键盘追踪）。 */
const isoKeys = new Set();
/** 店长走路摆相位（视觉动画用）。 */
let managerBobPhase = 0;

/** 会话中的阶段（PREP/OPEN/EVENING 都算会话期）。 */
function inSession() {
  return gs && session && (gs.phase === 'PREP' || gs.phase === 'OPEN' || gs.phase === 'EVENING');
}

/** 当前是否处于"会话期的第一人称视角"。 */
function fpsActive() {
  return viewMode === 'fps' && inSession();
}

/** 当前是否处于"会话期的等距俯瞰视角"（操纵店长小人）。 */
function isoActive() {
  return viewMode === 'iso' && inSession();
}

/** 把店长实体放到逻辑位置（位置唯一真值：fps=fp 控制器，iso=managerPos）。 */
function syncManagerVisual(dt) {
  if (!manager) return;
  if (fpsActive()) {
    manager.visible = false;
    managerPos.x = fp.x;
    managerPos.z = fp.z;
  } else {
    manager.visible = true;
    manager.position.set(managerPos.x, 0, managerPos.z);
    // 移动时转向
    // GLB 蒙皮角色（animator）：walk/idle 切换 + mixer 推进；程序化：四肢摇摆
    if (manager.userData.animator) {
      playManagerAnim(manager, manager.userData.moving ? 'walk' : 'idle');
      manager.userData.animator.mixer.update(dt || 0.016);
      manager.position.y = 0; // walk clip 自带起伏
    } else if (manager.userData.moving) {
      managerBobPhase += (dt || 0.016) * 8;
      const limbs = manager.userData.limbs;
      if (limbs) {
        const swing = Math.sin(managerBobPhase) * 0.5;
        limbs.legL.rotation.x = swing;
        limbs.legR.rotation.x = -swing;
      }
      manager.position.y = Math.abs(Math.sin(managerBobPhase)) * 0.05;
    } else {
      const limbs = manager.userData.limbs;
      if (limbs) { limbs.legL.rotation.x = 0; limbs.legR.rotation.x = 0; }
      manager.position.y = 0;
    }
  }
}

/** 每帧驱动玻璃滑门 + 库房员工门：玩家或任一顾客接近门口即开（纯视觉）。 */
function updateDoors(dt) {
  if (!shopCtx || !shopCtx.group) return;
  const doorX = CONFIG.layout.door.x; // 5.8
  const DOOR_Z = 4.9; // 前墙门洞平面
  const px = fpsActive() ? fp.x : managerPos.x;
  const pz = fpsActive() ? fp.z : managerPos.z;
  let near = Math.hypot(px - doorX, pz - DOOR_Z) < 1.5;
  if (!near && session) {
    for (const c of session.customers) {
      if (Math.hypot(c.pos.x - doorX, c.pos.z - DOOR_Z) < 1.3) { near = true; break; }
    }
  }
  // 员工通道门（库房）：手动开关（左键 doorToggle），状态读 gs.staffDoorOpen
  animateDoors(shopCtx.group, near, dt, gs ? gs.staffDoorOpen === true : false);
}

/** 根据视角 / 锁定 / 阶段状态刷新准星与提示。 */
function updateFpOverlay() {
  if (!fp) return;
  // 屋顶：第一人称显示，等距俯瞰隐藏（防遮挡店内视线）；墙壁恒显
  const roof = shopCtx && shopCtx.group.userData.roof;
  if (roof) roof.visible = fpsActive();
  if (manager) manager.visible = isoActive(); // 店长小人：俯瞰显 / 第一人称隐
  if (fpsActive() && fp.locked) {
    hud.setCrosshair(true);
    hud.setHint(null);
  } else if (fpsActive()) {
    hud.setCrosshair(false);
    hud.setHint(CONFIG.strings.fpEnterHint);
  } else if (inSession()) {
    hud.setCrosshair(false);
    hud.setHint(CONFIG.strings.fpIsoHint);
  } else {
    hud.setCrosshair(false);
    hud.setHint(null);
  }
}

/** 玩家位姿上下文（interaction/needs 距离闸门用）。位置取当前视角的唯一真值。 */
function playerCtx() {
  const px = fpsActive() ? fp.x : managerPos.x;
  const pz = fpsActive() ? fp.z : managerPos.z;
  return {
    x: px,
    z: pz,
    yaw: fp ? fp.yaw : 0,
    viewMode: fpsActive() ? 'fp' : 'iso',
    aimDir: fp ? aimDirection(fp.yaw) : null,
  };
}

// ---------- 剧情弹窗队列 ----------
function drainStoryQueue() {
  if (!gs || gs.storyQueue.length === 0) return;
  if (isStoryOpen(popupRoot)) return;
  if (fp) fp.exit(); // 弹窗打开时退出 pointer lock，交还光标
  const text = gs.storyQueue.shift();
  showStoryPopup(popupRoot, text, () => drainStoryQueue());
}

// ---------- 阶段切换 ----------
function persist() {
  if (gs && rng) {
    gs.rngState = rng.state;
    saveGame(gs);
  }
}

function toMorning() {
  if (changePanel) { changePanel.close(); changePanel = null; changePanelCustomer = null; } // 找零面板随阶段关闭
  closePanels(panelRoot);
  closeCustomerCard(popupRoot);
  if (fp) fp.exit();
  if (director) director.clear();
  if (streetCtx) streetCtx.clearDynamic();
  session = null;
  updateFpOverlay();
  setPhaseLighting(lights, 'MORNING');
  hud.update(gs, null);
  drainStoryQueue();
  showMorning(panelRoot, gs, {
    rng,
    onPrice(cat, price) {
      setPrice(gs, cat, price);
      hud.update(gs, null);
    },
    onSkuPrice(skuId, price) {
      setSkuPrice(gs, skuId, price);
      hud.update(gs, null);
    },
    onUpgrade(line) {
      const ok = buyUpgrade(gs, line);
      if (ok && shopCtx) shopCtx.rebuild(gs);
      if (ok) updateFpOverlay(); // rebuild 后同步屋顶/店长显隐（防俯瞰被屋顶盖住）
      hud.update(gs, null);
      return ok;
    },
    // 2026-09 店铺扩张：购买后重建场景 + 碰撞/行走域
    onExpansion(id) {
      const ok = buyExpansion(gs, id);
      if (ok) {
        shopCtx.rebuild(gs);
        updateFpOverlay();
        fp.bounds = effectiveBounds(gs);
        fp.setObstacles(buildObstacles(CONFIG.firstPerson, {
          tableCount: shopCtx.positions.mainTableCount ?? 1,
          decorLevel: gs.upgrades.decor,
          shelfLevel: gs.upgrades.shelf,
          staffDoorOpen: gs.staffDoorOpen === true,
          wingRight: gs.expansion.wing_right === true,
          layout: layoutOf(gs),
        }));
        hud.update(gs, null);
        persist();
      }
      return ok;
    },
    onStaffChange() {
      hud.update(gs, null);
      persist();
    },
    // v3 进货商城：全屏页内即时下单（restock 扣款 + ORDERED 单，早单晚到/晚单次日早到）
    onOpenMall() {
      showMall(panelRoot, gs, {
        onPlace(orders) {
          restock(gs, orders, rng);
          persist();
        },
        onClose() {
          toMorning(); // 返回晨间面板（在途摘要刷新）
        },
      });
    },
    onOpen(orders) {
      openStore(orders);
    },
  });
}

/** 开门：下单 → 抽事件 → 进入 PREP 备货阶段（货车在途）。 */
function openStore(orders) {
  if (changePanel) { changePanel.close(); changePanel = null; changePanelCustomer = null; } // 找零面板随阶段关闭
  // 晨间进货下单（生成 Delivery(ORDERED)，含收藏掉落），随后抽事件
  applyMorningActions(gs, { orders }, rng);
  const eventId = rollDailyEvent(gs, rng);
  if (eventId) {
    const ev = CONFIG.events.find((e) => e.id === eventId);
    if (ev) gs.storyQueue.unshift(`${CONFIG.strings.eventTitle}：${ev.emoji} ${ev.name} —— ${ev.desc}`);
  }
  session = startPrepSession(gs, rng);
  closePanels(panelRoot);
  setPhaseLighting(lights, 'PREP');
  if (streetCtx) streetCtx.setLampOpen(false);
  // 第一人称：回到出生点、按当前升级刷新碰撞盒、默认第一人称视角
  viewMode = 'fps';
  fp.reset();
  fp.bounds = effectiveBounds(gs); // 收购翼房后刷新行走域
  fp.setObstacles(buildObstacles(CONFIG.firstPerson, {
    tableCount: shopCtx.positions.mainTableCount ?? 1,
    decorLevel: gs.upgrades.decor,
    shelfLevel: gs.upgrades.shelf,
    staffDoorOpen: gs.staffDoorOpen === true,
    wingRight: gs.expansion && gs.expansion.wing_right === true,
    layout: layoutOf(gs),
  }));
  hud.update(gs, session);
  updateFpOverlay();
  drainStoryQueue();
}

/** 提前开门（PREP → OPEN）：未搬完的箱子留到营业中继续处理。 */
function openEarly() {
  if (!gs || gs.phase !== 'PREP' || !session) return;
  gs.storyQueue.push(CONFIG.strings.openEarly);
  startOpenSession(gs, rng, session); // 复用 PREP session（箱子/后仓原样保留）
  setPhaseLighting(lights, 'OPEN');
  if (streetCtx) streetCtx.setLampOpen(true);
  hud.update(gs, session);
  updateFpOverlay();
  drainStoryQueue();
}

function toClosing() {
  if (changePanel) { changePanel.close(); changePanel = null; changePanelCustomer = null; } // 找零面板随阶段关闭
  closeCustomerCard(popupRoot);
  if (fp) fp.exit();
  closeOutDay(gs, session); // 打烊清场：手上未上架的货入后仓、未取空箱子转后仓（不损失货）
  const report = settleDay(gs);
  persist();
  setPhaseLighting(lights, 'CLOSING');
  if (streetCtx) streetCtx.setLampOpen(false);
  hud.update(gs, null);
  updateFpOverlay();
  if (report.gameover) {
    clearSave(); // 破产清档
    showGameOver(panelRoot, gs, { onRestart: restart });
  } else if (report.victory) {
    gs.storyQueue.push(CONFIG.strings.victoryText);
    showVictory(panelRoot, gs, {
      onContinue() {
        gs.freePlay = true;
        nextDay(gs);
        persist();
        toMorning();
      },
      onRestart: restart,
    });
  } else {
    showClosing(panelRoot, gs, report, {
      onNext() {
        // 2026-09：日结后进入打烊整理（理货/下单/收纸板），不自动进下一天
        closePanels(panelRoot);
        startEveningSession(gs, session);
        setPhaseLighting(lights, 'CLOSING');
        hud.update(gs, session);
        updateFpOverlay();
        drainStoryQueue();
      },
    });
  }
}

function restart() {
  clearSave();
  bootGame(newGame(Date.now() % 2147483647));
}

// ---------- 初始化 / 读档 ----------
function bootGame(state) {
  gs = state;
  rng = createRng(gs.rngState ?? (Date.now() % 2147483647)); // ?? 而非 ||：种子 0 是合法种子
  if (!shopCtx) {
    shopCtx = buildShop(scene3d, gs);
  } else {
    shopCtx.rebuild(gs);
  }
  if (!streetCtx) streetCtx = buildStreet(scene3d, gs);
  if (!shelfCtx) shelfCtx = buildShelves(scene3d, gs, shopCtx);
  if (!stockCtx) stockCtx = buildStockroom(scene3d);
  if (!director) director = new Director(scene3d, shopCtx);
  director.clear();
  hud.update(gs, null);
  toMorning();
}

function showTitleScreen() {
  setPhaseLighting(lights, 'MORNING');
  showTitle(panelRoot, {
    hasSave: hasSave(),
    onNew() {
      clearSave();
      bootGame(newGame(Date.now() % 2147483647));
    },
    onContinue() {
      const loaded = loadGame();
      bootGame(loaded || newGame(Date.now() % 2147483647));
    },
  });
}

/** 倍速切换（hud 按钮 / X 键共用）。 */
function toggleSpeed() {
  if (session && inSession()) {
    session.speed = session.speed === 1 ? 2 : 1;
    hud.update(gs, session);
  }
}

/** 打开图鉴（hud 按钮 / C 键共用）。 */
function openCodexPanel() {
  if (!gs || isCodexOpen(popupRoot)) return;
  if (fp) fp.exit(); // 图鉴打开时退出 pointer lock
  openCodex(popupRoot, gs, () => {});
}

hud = new Hud(hudRoot, {
  onToggleSpeed: toggleSpeed,
  onOpenCodex: openCodexPanel,
  onRespondNeed(needId) {
    // 等距模式下点击气泡列表项直接响应（无距离限制，裁决 4）
    if (!inSession()) return;
    respondNeed(gs, session, needId, 'player', playerCtx());
    hud.update(gs, session);
  },
});

// 店铺与街道先以初始状态建一次（标题画面背景）
const bootGs = newGame(1);
shopCtx = buildShop(scene3d, bootGs);
streetCtx = buildStreet(scene3d, bootGs);
shelfCtx = buildShelves(scene3d, bootGs, shopCtx);
stockCtx = buildStockroom(scene3d);
director = new Director(scene3d, shopCtx);

// 第一人称控制器（Pointer Lock 环视 + WASD 移动 + 碰撞）
fp = new FirstPersonController(fpCamera, canvas, CONFIG.firstPerson);
fp.onLockChange = () => updateFpOverlay();

// ★ 俯瞰视角的店长小人（第 7 项：初始隐藏，V 键切俯瞰时显示并可操纵）
manager = buildManagerCharacter();
manager.visible = false;
scene3d.add(manager);
managerPos.x = CONFIG.firstPerson.spawn.x;
managerPos.z = CONFIG.firstPerson.spawn.z;

// v3 手持物品呈现（FP 相机右下 / iso 店长手上）
const carryView = new CarryView(scene3d, fpCamera, manager);

showTitleScreen();

// ---------- 点击：进入第一人称 / 准星交互（左键放置/操作，右键拾起） / 俯瞰点选 ----------
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault()); // 右键不入系统菜单

canvas.addEventListener('pointerdown', (ev) => {
  if (!inSession()) return;
  // 布局模式（EVENING）：右键拾起/取消，左键放下
  if (layoutMode) {
    const cam = fpsActive() ? fpCamera : camera;
    const ndc = fpsActive()
      ? { x: 0, y: 0 }
      : { x: (ev.clientX / window.innerWidth) * 2 - 1, y: -(ev.clientY / window.innerHeight) * 2 + 1 };
    if (layoutDrag) {
      if (ev.button === 0) commitLayoutDrag();
      else if (ev.button === 2) cancelLayoutDrag();
      return;
    }
    if (ev.button === 2) {
      const piece = pickLayoutPiece(ndc.x, ndc.y, cam);
      if (piece) layoutDrag = piece;
    }
    return;
  }
  if (viewMode === 'fps') {
    if (!fp.locked) {
      // 剧情弹窗打开时不进入锁定（否则"继续"按钮拿不到光标，只能 ESC）
      if (isStoryOpen(popupRoot)) return;
      closeCustomerCard(popupRoot);
      fp.enter();
      return;
    }
    // 锁定期间无光标：左键=放置/操作，右键=拾起；左键无目标时准星拾取顾客卡片
    if (ev.button === 2) {
      // 右键先验货架拿货（准星对准货架商品、空手 → 拿起整格）
      const spot = pickShelfSpot(0, 0, fpCamera, 'shelfSlot');
      if (spot && !session.carry && tryTakeShelfSlot(spot.slotIdx)) return;
      doInteract('rmb');
      return;
    }
    const target = resolveTarget(gs, session, playerCtx(), 'lmb');
    if (target) {
      doInteract('lmb');
      return;
    }
    // 空手左键：准星对准价格标签 → 调价面板
    if (!session.carry) {
      const spot = pickShelfSpot(0, 0, fpCamera, 'priceTag');
      if (spot && spot.kind === 'priceTag') {
        openShelfPricePanel(spot.slotIdx);
        return;
      }
    }
    const id = director.pickCustomer(0, 0, fpCamera);
    if (id !== null) {
      const customer = session.customers.find((c) => c.id === id);
      if (customer) {
        fp.exit(); // 信息卡片需要光标交互
        showCustomerCard(popupRoot, customer, window.innerWidth / 2, window.innerHeight / 2);
        return;
      }
    }
    closeCustomerCard(popupRoot);
    return;
  }
  // 全局俯瞰模式：左键点价签调价/点顾客看卡片；右键 = 拾起类交互（先验货架拿货）
  const ndcX = (ev.clientX / window.innerWidth) * 2 - 1;
  const ndcY = -(ev.clientY / window.innerHeight) * 2 + 1;
  if (ev.button === 2) {
    const spot = pickShelfSpot(ndcX, ndcY, camera, 'shelfSlot');
    if (spot && !session.carry && tryTakeShelfSlot(spot.slotIdx)) return;
    doInteract('rmb');
    return;
  }
  if (!session.carry) {
    const spot = pickShelfSpot(ndcX, ndcY, camera, 'priceTag');
    if (spot && spot.kind === 'priceTag') {
      openShelfPricePanel(spot.slotIdx);
      return;
    }
  }
  const id = director.pickCustomer(ndcX, ndcY, camera);
  if (id !== null) {
    const customer = session.customers.find((c) => c.id === id);
    if (customer) showCustomerCard(popupRoot, customer, ev.clientX, ev.clientY);
  } else {
    closeCustomerCard(popupRoot);
  }
});

// ---------- 键盘：V 视角 / Z 等距预设 / Tab 后仓 / F 交互 ----------
window.addEventListener('keydown', (ev) => {
  // 俯瞰移动键追踪（等距无 pointer lock，独立维护）
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(ev.code)) {
    isoKeys.add(ev.code);
  }
  if (ev.code === 'KeyV' && inSession()) {
    const prev = viewMode;
    viewMode = viewMode === 'fps' ? 'iso' : 'fps';
    if (viewMode === 'iso') {
      // fps → iso：同步位置到店长，退锁
      managerPos.x = fp.x;
      managerPos.z = fp.z;
      fp.exit();
      isoKeys.clear();
    } else if (prev === 'iso') {
      // iso → fps：同步位置回第一人称控制器
      fp.x = managerPos.x;
      fp.z = managerPos.z;
      fp.applyCamera();
    }
    updateFpOverlay();
    return;
  }
  if (ev.code === 'KeyZ' && inSession() && viewMode === 'iso') {
    isoPreset = isoPreset === 'shop' ? 'street' : 'shop';
    applyIsoPreset(camera, isoPreset);
    return;
  }
  if (ev.code === 'Tab') {
    ev.preventDefault();
    if (!gs) return;
    if (panelRoot.children.length > 0) {
      closePanels(panelRoot); // 已打开则关闭
      return;
    }
    if (fp) fp.exit(); // 面板打开时退出 pointer lock
    showBackroom(panelRoot, gs, { onClose: () => closePanels(panelRoot) });
    return;
  }
  // F 键 = 左键（放置/操作）别名；准星左键/右键交互见 pointerdown
  if (ev.code === 'KeyF' && inSession() && !ev.repeat) {
    doInteract('lmb');
  }
  // ---- 按键补全（2026-09：所有按钮都有对应按键）----
  // Space/Enter = 剧情弹窗「继续」
  if ((ev.code === 'Space' || ev.code === 'Enter') && isStoryOpen(popupRoot)) {
    ev.preventDefault();
    const btn = popupRoot.querySelector('[data-story] button');
    if (btn) btn.click();
    return;
  }
  if (ev.code === 'Space') {
    ev.preventDefault(); // 防页面滚动
    return;
  }
  // Esc = 关闭顶层面板/卡片（找零面板有自己的 Esc，不重复处理）
  if (ev.code === 'Escape') {
    if (isChangeOpen(popupRoot)) return;
    closeCustomerCard(popupRoot);
    if (isTakeoutOpen(popupRoot)) {
      const btn = popupRoot.querySelector('[data-takeout] [data-k="close"]');
      if (btn) btn.click();
    } else if (panelRoot.children.length > 0) {
      closePanels(panelRoot);
    }
    return;
  }
  // Enter = 当前面板主按钮（开始备货/下单/打烊整理/标题新开；找零面板自理）
  if (ev.code === 'Enter' && panelRoot.children.length > 0 && !isChangeOpen(popupRoot)) {
    const btn = panelRoot.querySelector(
      '[data-k="open"], [data-k="place"], [data-k="next"], .report-footer .btn, .btns .btn',
    );
    if (btn) btn.click();
    return;
  }
  // X = 倍速；C = 图鉴；M = 商城（晨间/打烊整理）；N = 打烊休息（EVENING）
  if (ev.code === 'KeyX') {
    toggleSpeed();
    return;
  }
  if (ev.code === 'KeyC') {
    openCodexPanel();
    return;
  }
  if (ev.code === 'KeyM') {
    const mallBtn = panelRoot.querySelector('[data-k="mall"]');
    if (mallBtn) { mallBtn.click(); return; }
    if (gs && (gs.phase === 'EVENING' || gs.phase === 'PREP')) eveningMallBtn.click();
    return;
  }
  if (ev.code === 'KeyN' && gs && gs.phase === 'EVENING') {
    eveningRestBtn.click();
  }
  // B = 布局模式开关（仅 EVENING）
  if (ev.code === 'KeyB' && gs && gs.phase === 'EVENING') {
    setLayoutMode(!layoutMode);
  }
  // 布局拖动中 R = 旋转构件 90°
  if (ev.code === 'KeyR' && layoutDrag) {
    layoutDrag.rot = ((layoutDrag.rot ?? 0) + 90) % 360;
    layoutDrag.group.rotation.y = (layoutDrag.rot * Math.PI) / 180;
    return;
  }
  // O = 提前开门（仅 PREP）
  if (ev.code === 'KeyO' && gs && gs.phase === 'PREP') {
    openEarly();
  }
});

window.addEventListener('keyup', (ev) => {
  isoKeys.delete(ev.code);
});

window.addEventListener('pointermove', (ev) => {
  pointerNdc.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointerNdc.y = -(ev.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('resize', () => {
  handleResize(camera, renderer);
  handleResize(fpCamera, renderer);
});

/** 每帧刷新交互提示与进度环。 */
function updateInteractionHud() {
  if (!inSession()) {
    hud.setInteract(null, false);
    hud.setProgress(null);
    return;
  }
  // 布局模式：提示条显示拖放操作（需求气泡/进度环照常隐藏）
  if (layoutMode) {
    const pseudo = (label) => ({ label, distance: 0, inRange: true });
    hud.setInteract(layoutDrag
      ? { lmb: pseudo('放下构件'), rmb: pseudo('取消') }
      : { lmb: null, rmb: pseudo('拾起构件（货架/吧台/桌子）') }, fpsActive());
    hud.setProgress(null);
    hud.setNeeds([]);
    return;
  }
  const prog = holdProgress(session);
  hud.setProgress(prog);
  // 双键提示：左键=放置/操作/服务，右键=拾起
  if (!prog.active) {
    const lmb = resolveTarget(gs, session, playerCtx(), 'lmb');
    const rmb = resolveTarget(gs, session, playerCtx(), 'rmb');
    hud.setInteract({ lmb, rmb }, fpsActive());
  } else {
    hud.setInteract(null, fpsActive());
  }
  // 需求气泡列表
  const items = activeNeeds(session).map((n) => {
    const d = needDisplay(gs, session, n);
    const cust = session.customers.find((c) => c.id === n.customerId);
    const dist = cust && fpsActive()
      ? Math.hypot(cust.pos.x - fp.x, cust.pos.z - fp.z) : null;
    return {
      id: d.id,
      emoji: d.emoji,
      text: d.label,
      skuLine: d.sku,
      ttlRatio: n.maxTtl > 0 ? Math.max(0, n.ttl / n.maxTtl) : 0,
      urgent: d.urgent,
      cooling: n.state === 'CLAIMED',
      distText: dist !== null && dist > CONFIG.firstPerson.interactRange
        ? `距离 ${dist.toFixed(1)}m，走近些再回应` : '',
    };
  });
  hud.setNeeds(items);
}

// ---------- 主循环 ----------
function frame(timeMs) {
  requestAnimationFrame(frame);
  const time = timeMs / 1000;
  const dt = Math.min(0.1, lastTime === 0 ? 0.016 : time - lastTime); // 真实帧间隔（封顶防卡顿跳变）
  lastTime = time;

  if (inSession()) {
    // ★ 俯瞰模式：WASD 操纵店长小人（等距屏幕对齐：上=-z 店内 / 右=+x）
    if (isoActive() && !layoutDrag) { // 布局拖动中冻结店长（相机不动，指针地面点稳定）
      const sprint = isoKeys.has('ShiftLeft') || isoKeys.has('ShiftRight');
      const speed = CONFIG.firstPerson.moveSpeed * (sprint ? CONFIG.firstPerson.sprintMult : 1)
        * doorSlowFactor(managerPos.x, managerPos.z, doorBoxCount(gs));
      const delta = computeMoveDelta(isoKeys, 0, speed * dt); // yaw=0 → 屏幕对齐
      manager.userData.moving = delta.dx !== 0 || delta.dz !== 0;
      if (manager.userData.moving) {
        const next = slideMove(
          { x: managerPos.x, z: managerPos.z }, delta,
          CONFIG.firstPerson.playerRadius, fp.obstacles, effectiveBounds(),
        );
        managerPos.x = next.x;
        managerPos.z = next.z;
        manager.rotation.y = Math.atan2(delta.dx, delta.dz);
      }
      syncManagerVisual(dt);
    } else {
      syncManagerVisual(dt);
    }

    // 玩家位姿写入 session（sim 层距离闸门消费）：取当前视角唯一真值
    session.playerPos.x = fpsActive() ? fp.x : managerPos.x;
    session.playerPos.z = fpsActive() ? fp.z : managerPos.z;
    session.viewMode = fpsActive() ? 'fp' : 'iso';
    session.holding = false; // 即时交互（instantHold）：无按住状态
    // 门口箱子堆积减速（A06 软惩罚，不生成障碍）
    fp.speedMult = doorSlowFactor(fp.x, fp.z, doorBoxCount(gs));

    // v3 推箱（需求 8）：玩家身体与落地箱重叠 → 沿径向推开（半穿透深度）
    {
      const px = fpsActive() ? fp.x : managerPos.x;
      const pz = fpsActive() ? fp.z : managerPos.z;
      const R = CONFIG.firstPerson.playerRadius + CONFIG.logistics.boxHalf;
      for (const b of gs.logistics.boxes) {
        if (!b.settled || b.y > 0.01) continue;
        const dx = b.x - px;
        const dz = b.z - pz;
        const d = Math.hypot(dx, dz);
        if (d < R && d > 1e-6) {
          pushBox(gs, b.id, (dx / d) * (R - d) * 0.8, (dz / d) * (R - d) * 0.8);
        }
      }
    }

    // 固定步长逻辑 tick；2 倍速 = 每帧 tick 数翻倍（PREP/OPEN 均支持，A31）
    accumulator += dt * session.speed;
    while (accumulator >= CONFIG.tick
      && (gs.phase === 'PREP' || gs.phase === 'OPEN' || gs.phase === 'EVENING')) {
      stepSession(session, gs, rng, CONFIG.tick);
      accumulator -= CONFIG.tick;
      // PREP 自然结束（prepClock 满 90s）→ stepSession 内部已 startOpenSession
      if (gs.phase === 'OPEN' && session.phase === 'OPEN' && session.clock === 0) {
        // 刚切入 OPEN：换灯光与灯牌（只触发一次）
        setPhaseLighting(lights, 'OPEN');
        if (streetCtx) streetCtx.setLampOpen(true);
      }
    }
    director.sync(session, dt, time, gs);
    if (streetCtx) streetCtx.sync(gs, session, dt);
    if (shelfCtx) shelfCtx.sync(gs);
    if (stockCtx) stockCtx.sync(gs);
    // 布局模式：阶段离开 EVENING 自动关闭
    if (layoutMode && gs.phase !== 'EVENING') setLayoutMode(false);
    if (layoutDrag) stepLayoutDrag();
    // 库房门手动开关 → 状态变化时重建碰撞障碍（关门时门洞有碰撞板）
    if (fp._staffDoorOpen !== gs.staffDoorOpen) {
      fp._staffDoorOpen = gs.staffDoorOpen;
      fp.setObstacles(buildObstacles(CONFIG.firstPerson, {
        tableCount: shopCtx.positions.mainTableCount ?? 1,
        decorLevel: gs.upgrades.decor,
        shelfLevel: gs.upgrades.shelf,
        staffDoorOpen: gs.staffDoorOpen === true,
        wingRight: gs.expansion && gs.expansion.wing_right === true,
        layout: layoutOf(gs),
      }));
    }
    // v3 找零面板：锁定顾客已不在队首（离店/被接走）→ 自动关闭
    if (changePanel && changePanel.isOpen()
      && (!session.queue.length || session.queue[0] !== changePanelCustomer)) {
      changePanel.close();
      changePanel = null;
      changePanelCustomer = null;
    }
    if (viewMode === 'fps') fp.update(dt);
    hud.update(gs, session);
    updateInteractionHud();
    drainStoryQueue();
    if (gs.phase === 'CLOSING') {
      toClosing();
    }
  }

  // v3 手持物品呈现 + HUD 提示（会话外隐藏）
  carryView.sync(inSession() ? session.carry : null, fpsActive(), fp.bobPhase, fp.bobAmount);
  hud.setCarry(inSession() ? session.carry : null);

  // 玻璃滑门（会话内外都响应：会话内跟顾客/玩家，会话外跟店长位置）
  updateDoors(dt);

  // ★ 相机：fps 用第一人称透视；iso 用等距俯瞰并跟随店长小人（布局拖动中冻结）
  if (isoActive() && !layoutDrag) {
    const off = isoPreset === 'street'
      ? { x: 16.2, y: 16.2, z: 14 }
      : { x: 12, y: 12, z: 12 };
    camera.position.set(managerPos.x + off.x, off.y, managerPos.z + off.z);
    camera.lookAt(managerPos.x, 0, managerPos.z);
    renderer.render(scene3d, camera);
  } else {
    const activeCamera = fpsActive() ? fpCamera : camera;
    renderer.render(scene3d, activeCamera);
  }
}
// ---------- e2e / 调试句柄（只读引用；不承担游戏逻辑，勿在业务代码中消费） ----------
window.BGS = {
  get gs() { return gs; },
  get session() { return session; },
  get fp() { return fp; },
  get shopCtx() { return shopCtx; },
  get shelfCtx() { return shelfCtx; },
  get stockCtx() { return stockCtx; },
  get camera() { return camera; },
  get layoutMode() { return layoutMode; },
  get layoutDrag() { return layoutDrag ? { kind: layoutDrag.kind, idx: layoutDrag.idx } : null; },
  get director() { return director; },
  /** 控制台调试指令：BGS.cheat.cash(1000) 加金币 / BGS.cheat.rep(10) 加声望。 */
  cheat: {
    cash(n = 1000) {
      if (!gs) return '当前没有进行中的游戏';
      gs.cash += Number(n) || 0;
      hud.update(gs, session);
      persist();
      return `💰 金币 ${gs.cash - (Number(n) || 0)} → ${gs.cash}（已存档）`;
    },
    rep(n = 10) {
      if (!gs) return '当前没有进行中的游戏';
      gs.reputation = Math.min(CONFIG.reputationGoal, gs.reputation + (Number(n) || 0));
      hud.update(gs, session);
      persist();
      return `⭐ 声望 → ${gs.reputation}/${CONFIG.reputationGoal}（已存档）`;
    },
  },
  managerPos,
};
requestAnimationFrame(frame);

// 提前开门按钮：注入到 HUD 栏（仅 PREP 阶段可点）
const earlyOpenBtn = document.createElement('button');
earlyOpenBtn.className = 'hud-btn';
earlyOpenBtn.innerHTML = '提前开门 <span class="kbd">O</span>';
earlyOpenBtn.style.display = 'none';
earlyOpenBtn.addEventListener('click', () => openEarly());
hudRoot.querySelector('.hud-bar').appendChild(earlyOpenBtn);

// 商城按钮（PREP 备货 / EVENING 打烊整理均可下单；白天单当晚到，晚上单次日早到）
const eveningMallBtn = document.createElement('button');
eveningMallBtn.className = 'hud-btn';
eveningMallBtn.innerHTML = '商城 <span class="kbd">M</span>';
eveningMallBtn.style.display = 'none';
eveningMallBtn.addEventListener('click', () => {
  if (!gs || (gs.phase !== 'EVENING' && gs.phase !== 'PREP')) return;
  if (fp) fp.exit();
  showMall(panelRoot, gs, {
    onPlace(orders) {
      restock(gs, orders, rng);
      persist();
    },
    onClose() {
      closePanels(panelRoot);
    },
  });
});
hudRoot.querySelector('.hud-bar').appendChild(eveningMallBtn);

const eveningRestBtn = document.createElement('button');
eveningRestBtn.className = 'hud-btn';
eveningRestBtn.innerHTML = '打烊 <span class="kbd">N</span>';
eveningRestBtn.style.display = 'none';
eveningRestBtn.addEventListener('click', () => {
  if (!gs || gs.phase !== 'EVENING') return;
  nextDay(gs);
  persist();
  toMorning();
});
hudRoot.querySelector('.hud-bar').appendChild(eveningRestBtn);

// 布局模式按钮（EVENING；右键拖放货架/吧台/桌子）
const layoutBtn = document.createElement('button');
layoutBtn.className = 'hud-btn';
layoutBtn.innerHTML = '布局 <span class="kbd">B</span>';
layoutBtn.style.display = 'none';
layoutBtn.addEventListener('click', () => setLayoutMode(!layoutMode));
hudRoot.querySelector('.hud-bar').appendChild(layoutBtn);

// 每帧按阶段显隐提前开门按钮（放在 hud.update 之外的轻量检查）
setInterval(() => {
  earlyOpenBtn.style.display = (gs && gs.phase === 'PREP' && session) ? '' : 'none';
  // 商城按钮（PREP/EVENING）；打烊按钮组（EVENING）
  const evening = gs && gs.phase === 'EVENING' && session;
  const mallVisible = gs && (gs.phase === 'EVENING' || gs.phase === 'PREP') && session;
  eveningMallBtn.style.display = mallVisible ? '' : 'none';
  eveningRestBtn.style.display = evening ? '' : 'none';
  layoutBtn.style.display = evening ? '' : 'none';
  layoutBtn.classList.toggle('active', layoutMode);
}, 250);
