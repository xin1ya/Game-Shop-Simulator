/**
 * character.js — 程序化 Q 版小人构建 + 类型配色/配饰 + 心情气泡 emoji sprite。
 *
 * 低模拼装：胶囊身体 / 球形头 / 圆柱四肢；4 种顾客类型用配色与配饰区分。
 *
 * @module scene/character
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { makeToonMaterial, addOutline } from './scene.js';

/** 各顾客类型的配色与配饰（呈现层数据，非玩法数值）。 */
const LOOKS = {
  student:   { body: 0x7ec8e3, accent: 0x4a90c2, accessory: 'backpack' },
  core:      { body: 0x9b7ede, accent: 0x6a4faf, accessory: 'headphones' },
  collector: { body: 0xf5c542, accent: 0xc79420, accessory: 'hat' },
  casual:    { body: 0x95d5b2, accent: 0x5f9e80, accessory: 'none' },
};

const SKIN = 0xffd9b3;

/** 带描边的网格创建辅助。 */
function part(geometry, color, x, y, z) {
  const mesh = new THREE.Mesh(geometry, makeToonMaterial(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  addOutline(mesh);
  return mesh;
}

/** 背包（学生党）。 */
function buildBackpack(color) {
  const g = new THREE.Group();
  g.add(part(new THREE.BoxGeometry(0.34, 0.42, 0.18), color, 0, 0.85, -0.3));
  return g;
}

/** 耳机（核心玩家）。 */
function buildHeadphones(color) {
  const g = new THREE.Group();
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.26, 0.045, 8, 16, Math.PI),
    makeToonMaterial(color),
  );
  band.position.set(0, 1.42, 0);
  g.add(band);
  g.add(part(new THREE.SphereGeometry(0.09, 8, 8), color, -0.28, 1.38, 0));
  g.add(part(new THREE.SphereGeometry(0.09, 8, 8), color, 0.28, 1.38, 0));
  return g;
}

/** 礼帽（收藏家）。 */
function buildHat(color) {
  const g = new THREE.Group();
  g.add(part(new THREE.CylinderGeometry(0.2, 0.22, 0.24, 12), color, 0, 1.78, 0));
  g.add(part(new THREE.CylinderGeometry(0.36, 0.36, 0.04, 12), color, 0, 1.66, 0));
  return g;
}

/**
 * 构建 Q 版顾客小人。
 * @param {string} type CustomerTypeId
 * @returns {THREE.Group} 顾客实体（userData.customerId 由 director 写入）
 */
export function buildCharacter(type) {
  const look = LOOKS[type] || LOOKS.casual;
  const g = new THREE.Group();

  // 身体（胶囊）、头（球）、四肢（圆柱）
  const body = part(new THREE.CapsuleGeometry(0.26, 0.4, 6, 12), look.body, 0, 0.72, 0);
  const head = part(new THREE.SphereGeometry(0.3, 14, 12), SKIN, 0, 1.4, 0);
  const legL = part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), look.accent, -0.12, 0.2, 0);
  const legR = part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), look.accent, 0.12, 0.2, 0);
  const armL = part(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), look.body, -0.36, 0.78, 0);
  const armR = part(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), look.body, 0.36, 0.78, 0);
  armL.rotation.z = 0.25;
  armR.rotation.z = -0.25;
  g.add(body, head, legL, legR, armL, armR);

  // 配饰
  if (look.accessory === 'backpack') g.add(buildBackpack(look.accent));
  else if (look.accessory === 'headphones') g.add(buildHeadphones(look.accent));
  else if (look.accessory === 'hat') g.add(buildHat(look.accent));

  g.userData.limbs = { legL, legR, armL, armR };
  return g;
}

/** 员工配色（复用 Q 版小人，围裙/马甲区分岗位，裁决 Q8）。 */
const STAFF_LOOKS = {
  cashier: { body: 0xe8a8a8, accent: 0xb85c5c },  // 收银员：红围裙
  guide: { body: 0xa8d8b0, accent: 0x4f9e6a },    // 导购员：绿马甲
  host: { body: 0xf2d18f, accent: 0xc99b3f },     // 体验官：黄围裙
  stocker: { body: 0xc2b49a, accent: 0x8a7355 },  // 仓管员：棕工装
};

/**
 * 构建员工小人（复用 buildCharacter 结构，岗位配色 + 小围裙）。
 * @param {string} role 岗位 id（cashier/guide/host/stocker）
 * @returns {THREE.Group}
 */
export function buildStaffCharacter(role) {
  const look = STAFF_LOOKS[role] || STAFF_LOOKS.cashier;
  const g = new THREE.Group();
  const body = part(new THREE.CapsuleGeometry(0.26, 0.4, 6, 12), look.body, 0, 0.72, 0);
  const head = part(new THREE.SphereGeometry(0.3, 14, 12), SKIN, 0, 1.4, 0);
  const legL = part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), look.accent, -0.12, 0.2, 0);
  const legR = part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), look.accent, 0.12, 0.2, 0);
  const armL = part(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), look.body, -0.36, 0.78, 0);
  const armR = part(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), look.body, 0.36, 0.78, 0);
  armL.rotation.z = 0.25;
  armR.rotation.z = -0.25;
  // 围裙（岗位标识）
  const apron = part(new THREE.BoxGeometry(0.34, 0.34, 0.1), look.accent, 0, 0.72, 0.24);
  g.add(body, head, legL, legR, armL, armR, apron);
  g.userData.limbs = { legL, legR, armL, armR };
  return g;
}

// ---- 店长 GLB（player.glb：蒙皮角色 + idle/walk clip；缺资产回退程序化） ----

const playerLoader = new GLTFLoader();
let playerTpl = null;
let playerLoading = false;

/** 加载 player.glb 模板（材质 toonify、蒙皮件 frustumCulled=false、不描边）。 */
function ensurePlayerAsset(onReady) {
  if (playerTpl) { onReady(playerTpl); return; }
  if (playerLoading) return;
  playerLoading = true;
  playerLoader.load('assets/glb/player.glb', (gltf) => {
    const tpl = gltf.scene;
    tpl.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const src = o.material;
      o.material = makeToonMaterial(src && src.color ? src.color.clone() : 0xffffff);
      o.castShadow = true;
      o.frustumCulled = false; // 蒙皮包围球不可靠（走动时可能被整件剔除）
    });
    tpl.userData.clips = gltf.animations;
    playerTpl = tpl;
    onReady(tpl);
  }, undefined, () => {
    playerLoading = false; // 失败保持程序化回退
  });
}

/** 切换到指定 clip（idle/walk，交叉淡入淡出）。 */
export function playManagerAnim(group, name) {
  const a = group.userData.animator;
  if (!a || a.current === name) return;
  const next = a.actions[name];
  if (!next) return;
  if (a.current && a.actions[a.current]) a.actions[a.current].fadeOut(0.15);
  next.reset().fadeIn(0.15).play();
  a.current = name;
}

/**
 * 构建店长小人（★ 俯瞰视角的可操纵角色）。
 * 双路径：player.glb 就绪后切换为蒙皮 GLB（idle/walk 动画）；
 * 未就绪/缺失 → 程序化拼装（四肢摇摆动画）。
 * @returns {THREE.Group}
 */
export function buildManagerCharacter() {
  const g = new THREE.Group();
  const body = part(new THREE.CapsuleGeometry(0.26, 0.4, 6, 12), 0x7a9e7e, 0, 0.72, 0);
  const head = part(new THREE.SphereGeometry(0.3, 14, 12), SKIN, 0, 1.4, 0);
  const legL = part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), 0x4a3a2a, -0.12, 0.2, 0);
  const legR = part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), 0x4a3a2a, 0.12, 0.2, 0);
  const armL = part(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), 0x7a9e7e, -0.36, 0.78, 0);
  const armR = part(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), 0x7a9e7e, 0.36, 0.78, 0);
  armL.rotation.z = 0.25;
  armR.rotation.z = -0.25;
  // 围裙（店主标识）
  const apron = part(new THREE.BoxGeometry(0.36, 0.36, 0.1), 0xc9763f, 0, 0.72, 0.24);
  // 报童帽
  const capTop = part(new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0x8a5a2b, 0, 1.52, 0);
  const capBrim = part(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 12), 0x6b4423, 0, 1.5, 0.12);
  g.add(body, head, legL, legR, armL, armR, apron, capTop, capBrim);
  g.userData.limbs = { legL, legR, armL, armR };

  // GLB 就绪后整体换装为蒙皮角色（SkeletonUtils.clone 重绑骨架）
  ensurePlayerAsset((tpl) => {
    const scene = SkeletonUtils.clone(tpl);
    while (g.children.length > 0) g.remove(g.children[0]);
    g.add(scene);
    const mixer = new THREE.AnimationMixer(scene);
    const actions = {};
    for (const clip of tpl.userData.clips || []) {
      actions[clip.name] = mixer.clipAction(clip);
    }
    g.userData.animator = { mixer, actions, current: null };
    playManagerAnim(g, 'idle');
  });
  return g;
}

/** emoji → CanvasTexture。 */
function emojiTexture(emoji) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = '92px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 64, 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 创建心情气泡 sprite（初始隐藏）。
 * @returns {THREE.Sprite} 气泡（置于角色头顶；用 setBubbleEmoji 换表情）
 */
export function makeBubble() {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ transparent: true, depthTest: false }),
  );
  sprite.scale.set(0.7, 0.7, 1);
  sprite.position.set(0.42, 2.05, 0);
  sprite.visible = false;
  sprite.userData.emoji = null;
  return sprite;
}

/**
 * 切换气泡表情；emoji 为 null 时隐藏。仅在变化时重建贴图。
 * @param {THREE.Sprite} bubble
 * @param {string|null} emoji
 */
export function setBubbleEmoji(bubble, emoji) {
  if (bubble.userData.emoji === emoji) return;
  bubble.userData.emoji = emoji;
  if (bubble.material.map) {
    bubble.material.map.dispose();
    bubble.material.map = null;
  }
  if (emoji === null) {
    bubble.visible = false;
    return;
  }
  bubble.material.map = emojiTexture(emoji);
  bubble.material.needsUpdate = true;
  bubble.visible = true;
}

/** 释放角色实体资源。 */
export function disposeCharacter(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}
