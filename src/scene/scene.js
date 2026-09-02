/**
 * scene.js — Three 渲染器 / 等距 45° 相机 / 第一人称透视相机 /
 * 昼夜光照 / toon gradientMap / inverted hull 描边工具。
 *
 * 仅本层允许 import three。
 *
 * @module scene/scene
 */

import * as THREE from 'three';

/** 全局共享的 3 阶 gradientMap（DataTexture）。 */
let sharedGradientMap = null;

/**
 * 获取共享 3 阶 toon gradientMap。
 * @returns {THREE.DataTexture}
 */
export function getGradientMap() {
  if (sharedGradientMap) return sharedGradientMap;
  const data = new Uint8Array([90, 170, 255]); // 3 阶色调分离
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  sharedGradientMap = tex;
  return tex;
}

/**
 * 创建赛璐璐材质（MeshToonMaterial + 共享 gradientMap）。
 * @param {number|string} color 颜色
 * @param {object} [opts] 额外材质参数（transparent / opacity 等）
 * @returns {THREE.MeshToonMaterial}
 */
export function makeToonMaterial(color, opts = {}) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: getGradientMap(),
    ...opts,
  });
}

/**
 * 无描边赛璐璐材质（行人 / 邻铺立面等远量实体省 draw call 用）。
 * 与 makeToonMaterial 同参数，仅约定调用方不为其附加 inverted hull。
 * @param {number|string} color 颜色
 * @param {object} [opts] 额外材质参数
 * @returns {THREE.MeshToonMaterial}
 */
export function makeFlatToonMaterial(color, opts = {}) {
  return makeToonMaterial(color, opts);
}

/**
 * inverted hull 描边：为 mesh 附加背面外扩黑色壳（scale 1.04）。
 * @param {THREE.Mesh} mesh 目标网格
 * @param {number} [scale] 外扩比例
 */
export function addOutline(mesh, scale = 1.04) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: 0x3a2410, side: THREE.BackSide }),
  );
  outline.scale.setScalar(scale);
  outline.raycast = () => {}; // 描边壳不参与拾取
  mesh.add(outline);
  return outline;
}

/**
 * 实体标签牌（真实世界固定标签：贴在表面、不随镜头转——与 Sprite 气泡相对）。
 * 返回面朝 +z 的平面网格；要朝 -z（临街立面）由调用方 rotation.y = Math.PI。
 * @param {THREE.Texture} texture 贴图（CanvasTexture）
 * @param {number} w 宽（世界单位）
 * @param {number} h 高
 * @param {{doubleSide?: boolean}} [opts] doubleSide=true → 门牌类双面可读（防背面消失）
 * @returns {THREE.Mesh}
 */
export function makeLabelPlane(texture, w, h, opts = {}) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    }),
  );
  mesh.raycast = () => {}; // 标签不参与拾取
  return mesh;
}

/**
 * 创建渲染器。
 * @param {HTMLCanvasElement} canvas
 * @returns {THREE.WebGLRenderer}
 */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/**
 * 创建斜 45° 等距相机（正交）。
 * @returns {THREE.OrthographicCamera}
 */
export function createIsometricCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const frustum = 8.2; // 半高（世界单位）
  const camera = new THREE.OrthographicCamera(
    -frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 100,
  );
  camera.position.set(12, 12, 12);
  camera.lookAt(0, 0, 0);
  return camera;
}

/** 等距相机预设：店内（默认，对齐 v1 视角）。 */
const ISO_PRESET_SHOP = {
  pos: [12, 12, 12],
  target: [0, 0, 0],
  frustum: 8.2,
};

/** 等距相机预设：街道（覆盖 24×20 外景，距离 ×1.35，允许轻微俯角调整）。 */
const ISO_PRESET_STREET = {
  pos: [16.2, 16.2, 19],
  target: [0, 0, 5],
  frustum: 8.2 * 1.35,
};

/**
 * 应用等距相机预设（B21：Z 键在「店内 / 街道」双预设间切换）。
 * @param {THREE.OrthographicCamera} camera createIsometricCamera 产物
 * @param {'shop'|'street'} preset 预设名
 */
export function applyIsoPreset(camera, preset) {
  const p = preset === 'street' ? ISO_PRESET_STREET : ISO_PRESET_SHOP;
  camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
  camera.top = p.frustum;
  camera.bottom = -p.frustum;
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = -p.frustum * aspect;
  camera.right = p.frustum * aspect;
  camera.updateProjectionMatrix();
  camera.lookAt(p.target[0], p.target[1], p.target[2]);
}

/**
 * 创建第一人称透视相机（rotation order YXZ：yaw 绕 Y、pitch 绕 X）。
 * @param {number} [fov] 视场角（度）
 * @returns {THREE.PerspectiveCamera}
 */
export function createFirstPersonCamera(fov = 68) {
  const camera = new THREE.PerspectiveCamera(
    fov, window.innerWidth / window.innerHeight, 0.05, 60,
  );
  camera.rotation.order = 'YXZ';
  return camera;
}

/** 窗口尺寸变化时同步相机与渲染器（正交 / 透视相机均支持）。 */
export function handleResize(camera, renderer) {
  const aspect = window.innerWidth / window.innerHeight;
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
  } else {
    const frustum = camera.top;
    camera.left = -frustum * aspect;
    camera.right = frustum * aspect;
  }
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * 创建光照（半球环境光 + 暖色平行光带柔和阴影）。
 * @param {THREE.Scene} scene
 * @returns {{sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight}}
 */
export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xfff2dd, 0xcf9d68, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe0b0, 1.6);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.radius = 4;
  scene.add(sun);
  return { sun, hemi };
}

/**
 * 营业 / 打烊的昼夜光照差异。
 * @param {{sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight}} lights
 * @param {string} phase 游戏阶段
 */
export function setPhaseLighting(lights, phase) {
  if (phase === 'OPEN') {
    // 白天：明亮暖色
    lights.sun.intensity = 1.6;
    lights.sun.color.set(0xffe0b0);
    lights.hemi.intensity = 0.85;
  } else {
    // 打烊 / 晨间：昏暗暖橙
    lights.sun.intensity = 0.55;
    lights.sun.color.set(0xff9a5c);
    lights.hemi.intensity = 0.45;
  }
}
