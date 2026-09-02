/**
 * productAssets.js — SKU 商品 GLB 资产加载（tools/assetgen 管线产物）。
 *
 * 双路径契约（管线工作流第 5 步）：
 *   ensureSkuAsset(skuId) 异步加载 assets/glb/<skuId>.glb；
 *   getSkuAsset(skuId) 同步取模板——已就绪返回 Group，未就绪/缺失返回 null，
 *   调用方（shelf.js）此时走程序化回退模型，加载完成后经回调触发重建。
 *
 * 模板处理（toonify）：GLB 材质整体替换为 MeshToonMaterial（保留 color /
 * transparent / emissive——材质在 Blender 端已做 sRGB→线性，GLTFLoader 读回
 * 线性值，这里直接继承 Color 对象不再二次转换）；不透明件加 inverted hull
 * 描边；材质角色名含 glass（半透明）/ ems（发光）的件不加描边壳
 * （半透明件描边会反包正面成黑块，发光小件描边糊成一团）。
 *
 * 克隆共享几何与材质：实例 userData.sharedAsset=true，shelf.js 销毁时跳过
 * dispose（模板常驻缓存，共享资源不能随实例销毁）。
 *
 * @module scene/productAssets
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeToonMaterial, addOutline } from './scene.js';

const loader = new GLTFLoader();
/** @type {Map<string, THREE.Group|null>} 模板缓存（null = 加载失败，永久回退） */
const cache = new Map();
/** @type {Map<string, Function[]>} 加载中的就绪回调队列 */
const pending = new Map();

/** 同步取 SKU 模板（未加载/加载失败 → null）。 */
export function getSkuAsset(skuId) {
  return cache.get(skuId) || null;
}

/**
 * 确保 SKU 资产加载中/已加载。
 * @param {string} skuId
 * @param {Function} [onReady] 加载成功回调（失败不回调；调用方继续用回退模型）
 */
export function ensureSkuAsset(skuId, onReady) {
  if (cache.has(skuId)) {
    const t = cache.get(skuId);
    if (t && onReady) onReady(t);
    return;
  }
  if (pending.has(skuId)) {
    if (onReady) pending.get(skuId).push(onReady);
    return;
  }
  const cbs = onReady ? [onReady] : [];
  pending.set(skuId, cbs);
  loader.load(
    `assets/glb/${skuId}.glb`,
    (gltf) => {
      let template;
      try {
        template = prepareTemplate(gltf.scene);
      } catch (e) {
        console.error('[productAssets] toonify 失败，回退程序化：', skuId, e);
        cache.set(skuId, null);
        pending.delete(skuId);
        return;
      }
      cache.set(skuId, template);
      pending.delete(skuId);
      for (const cb of cbs) cb(template);
    },
    undefined,
    (err) => {
      // 404 / 解析失败 → 标记 null，保持程序化回退
      console.error('[productAssets] GLB 加载失败，回退程序化：', skuId, err);
      cache.set(skuId, null);
      pending.delete(skuId);
    },
  );
}

/** 材质角色名含 glass / ems 的件：跳过描边（透明件/发光小件）。 */
function skipOutline(matName) {
  return /glass|ems/i.test(matName || '');
}

/**
 * 把 GLB 场景处理为可克隆模板：材质 toonify + 描边 + 阴影。
 * @param {THREE.Group} root GLTFLoader 的 gltf.scene
 * @returns {THREE.Group}
 */
function prepareTemplate(root) {
  // 先收集再处理：addOutline 会向 mesh 挂描边壳子节点，
  // 边 traverse 边加会无限递归（RangeError 爆栈）
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const src = o.material;
    const matName = src && src.name ? src.name : '';
    const toon = makeToonMaterial(src ? src.color.clone() : 0xffffff);
    toon.name = matName;
    if (src && src.transparent) {
      toon.transparent = true;
      toon.opacity = src.opacity;
      toon.depthWrite = false; // 透明杯壳不写深度，内部奶茶/珍珠不被错误遮挡
    }
    if (src && src.emissive && (src.emissive.r > 0 || src.emissive.g > 0 || src.emissive.b > 0)) {
      toon.emissive.copy(src.emissive);
      toon.emissiveIntensity = src.emissiveIntensity ?? 1;
    }
    o.material = toon;
    o.castShadow = true;
    if (!skipOutline(matName)) addOutline(o);
  }
  return root;
}
