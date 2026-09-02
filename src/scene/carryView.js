/**
 * carryView.js — 手持物品 3D 呈现（双手抱起）。
 *
 * 双视角：第一人称挂 fpCamera 正中偏下（跟随相机 + 走路摆动）；
 * 等距俯瞰挂店长胸前正前方。手持类型（session.carry）：
 *   {type:'item', skuId, qty} → SKU GLB 克隆（0.55×/0.45×）
 *   {type:'box', box}         → 整箱 crate GLB（0.85×/0.8×，双手抱箱）
 *   {type:'cardboard', n}     → 折叠纸壳（扁平纸板）
 * GLB 克隆共享几何/材质（userData.sharedAsset），换货时只摘不 dispose。
 * 资产未就绪：触发加载 + 程序化回退，就绪后下一帧自动补挂。
 *
 * @module scene/carryView
 */

import * as THREE from 'three';
import { makeToonMaterial, addOutline } from './scene.js';
import { getSkuAsset, ensureSkuAsset } from './productAssets.js';

export class CarryView {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} fpCamera 第一人称相机
   * @param {THREE.Group} manager 俯瞰店长小人
   */
  constructor(scene, fpCamera, manager) {
    this.fpCamera = fpCamera;
    // 相机需入场景树，子节点才参与渲染
    if (!fpCamera.parent) scene.add(fpCamera);

    this.fpHolder = new THREE.Group();
    // 双手抱起：正中偏下
    this.fpHolder.position.set(0, -0.3, -0.52);
    this.fpHolder.rotation.set(0.1, 0, 0); // 正对镜头微抬
    fpCamera.add(this.fpHolder);

    this.isoHolder = new THREE.Group();
    this.isoHolder.position.set(0, 0.6, 0.32); // 店长双手胸前抱起（身体正前方）
    manager.add(this.isoHolder);

    /** @type {string|Symbol|null} 当前展示键 */
    this.key = null;
  }

  /** 换货重建（sharedAsset 克隆：摘下即可，不 dispose 共享资源）。 */
  _fill(holder, carry, scale) {
    while (holder.children.length > 0) holder.remove(holder.children[0]);
    if (!carry) return;
    if (carry.type === 'box') {
      const asset = getSkuAsset('crate');
      if (asset) {
        const inst = asset.clone(true);
        inst.scale.setScalar(scale);
        holder.add(inst);
        return;
      }
      ensureSkuAsset('crate', () => { this.key = Symbol('reload'); });
      const fallback = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.44, 0.5), makeToonMaterial(0xd8a86a));
      fallback.position.y = 0.22;
      addOutline(fallback);
      holder.add(fallback);
      return;
    }
    if (carry.type === 'cardboard') {
      const sheet = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.03, 0.4),
        makeToonMaterial(0xc9a25f),
      );
      sheet.rotation.y = 0.1;
      addOutline(sheet);
      holder.add(sheet);
      return;
    }
    // 商品：置物盒盛放（merch_bin 托盘 + 1~2 个小样；GLB 未就绪回退小盒）
    const tray = getSkuAsset('merch_bin');
    const mini = getSkuAsset(carry.skuId);
    if (tray && mini) {
      const t = tray.clone(true);
      t.scale.setScalar(scale);
      holder.add(t);
      const n = Math.min(carry.qty, 2);
      for (let i = 0; i < n; i += 1) {
        const m = mini.clone(true);
        m.scale.setScalar(0.55);
        m.position.set(-0.05 + i * 0.1, 0.04, 0);
        t.add(m); // 作为托盘子节点，随托盘缩放
      }
      return;
    }
    ensureSkuAsset('merch_bin', () => { this.key = Symbol('reload'); });
    ensureSkuAsset(carry.skuId, () => { this.key = Symbol('reload'); });
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.16, 0.18),
      makeToonMaterial(0xf29ec4),
    );
    addOutline(box);
    holder.add(box);
  }

  /**
   * 每帧同步。
   * @param {object|null} carry session.carry
   * @param {boolean} fpActive 是否第一人称视角（会话期）
   * @param {number} [bobPhase] 走路摆相位（fp.bobPhase）
   * @param {number} [bobAmount] 摆动强度（fp.bobAmount）
   */
  sync(carry, fpActive, bobPhase = 0, bobAmount = 0) {
    const key = carry
      ? (carry.type === 'item' ? `item:${carry.skuId}`
        : carry.type === 'box' ? `box:${carry.box.id}`
        : `cardboard:${carry.n}`)
      : null;
    if (key !== this.key) {
      this.key = key;
      const isBox = carry && carry.type === 'box';
      this._fill(this.fpHolder, carry, isBox ? 0.85 : 0.55);
      this._fill(this.isoHolder, carry, isBox ? 0.8 : 0.45);
    }
    const show = Boolean(carry);
    this.fpHolder.visible = Boolean(fpActive && show);
    this.isoHolder.visible = Boolean(!fpActive && show);
    // 走路摆动（FP 双手抱起随头部 bob 起伏，基线在正中偏下）
    this.fpHolder.position.y = -0.3 + Math.sin(bobPhase) * 0.02 * bobAmount;
  }
}
