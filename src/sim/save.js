/**
 * save.js — localStorage 存读档（v2 key: bgs_save_v2；v1 key 兼容读取 + 一次迁移）。
 *
 * 本模块是 sim 层唯一允许接触 localStorage 的文件；
 * 通过 injectStorage() 可注入自定义存储（Node 测试/无头环境用内存 fallback），
 * 未注入且环境无 localStorage 时静默降级为 no-op，保证 Node 下可导入。
 *
 * 迁移纪律（架构 §7.3）：任何一步都不允许让旧档失效。
 *  - JSON.parse 失败 → return null，保留 v1 key 不动
 *  - migrateV1toV2 内部逐字段兜底，不整体拒绝
 *  - 写 v2 失败 → 静默降级，游戏用内存中的迁移结果继续
 *  - 整体抛异常 → 用 v1 的 day/cash/reputation/rngState 新建 v2 档（能玩 > 崩溃）
 *
 * @module sim/save
 */

import { CONFIG } from '../config.js';
import { serialize, deserialize, newGame } from './gameState.js';

/** @type {{getItem: Function, setItem: Function, removeItem: Function}|null} */
let injected = null;

/**
 * 注入自定义存储（Node 测试用）。传 null 恢复默认行为。
 * @param {{getItem: Function, setItem: Function, removeItem: Function}|null} storage
 */
export function injectStorage(storage) {
  injected = storage;
}

/** 解析当前可用存储；不可用时返回 null。 */
function resolveStorage() {
  if (injected) return injected;
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      return globalThis.localStorage;
    }
  } catch (e) {
    // 某些环境访问 localStorage 会抛异常，按不可用处理
  }
  return null;
}

/**
 * 保存进度（v2 key）。
 * @param {object} gs GameState
 * @returns {boolean} 是否成功
 */
export function saveGame(gs) {
  const store = resolveStorage();
  if (!store) return false;
  try {
    store.setItem(CONFIG.saveKey, serialize(gs));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 读取进度：v2 优先；无 v2 则探测 v1 → 一次迁移 → 立即回写 v2（v1 key 保留不删）。
 * @returns {object|null} GameState；无存档或不可恢复时返回 null
 */
export function loadGame() {
  const store = resolveStorage();
  if (!store) return null;
  let jsonV2 = null;
  let jsonV1 = null;
  try {
    jsonV2 = store.getItem(CONFIG.saveKey);
    jsonV1 = store.getItem(CONFIG.legacySaveKey);
  } catch (e) {
    return null;
  }
  if (jsonV2) {
    const gs = deserialize(jsonV2); // deserialize 内含字段兜底与守恒自愈
    if (gs) return gs;
    // v2 损坏：继续尝试 v1（双保险）
  }
  if (!jsonV1) return null;
  try {
    const raw = JSON.parse(jsonV1);
    const gs = deserialize(typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : '{}');
    if (gs) {
      try {
        store.setItem(CONFIG.saveKey, serialize(gs)); // 一次性迁移回写（失败静默）
      } catch (e) {
        // 配额/隐私模式：游戏继续用内存结果，不回滚
      }
      return gs;
    }
    return null;
  } catch (e) {
    // 迁移整体抛异常（理论上 migrateV1toV2 已内部兜底，此处为最后防线）：
    // 用 v1 可抢救字段新建 v2 档，玩家损失进度但能继续玩
    try {
      const salvage = JSON.parse(jsonV1);
      const gs = newGame(Number.isFinite(salvage.rngState) ? salvage.rngState : 1);
      if (Number.isFinite(salvage.day)) gs.day = Math.floor(salvage.day);
      if (Number.isFinite(salvage.cash)) gs.cash = Math.round(salvage.cash);
      if (Number.isFinite(salvage.reputation)) {
        gs.reputation = Math.min(CONFIG.reputationGoal, Math.max(0, Math.round(salvage.reputation)));
      }
      gs.phase = 'MORNING';
      return gs;
    } catch (e2) {
      return null; // 连抢救都失败：走「新开一家店」
    }
  }
}

/** 是否存在存档（v2 或 v1 任一存在即 true）。 */
export function hasSave() {
  const store = resolveStorage();
  if (!store) return false;
  try {
    return store.getItem(CONFIG.saveKey) !== null
      || store.getItem(CONFIG.legacySaveKey) !== null;
  } catch (e) {
    return false;
  }
}

/** 删除存档（同时移除 v2 与 v1）。 */
export function clearSave() {
  const store = resolveStorage();
  if (!store) return;
  try {
    store.removeItem(CONFIG.saveKey);
    store.removeItem(CONFIG.legacySaveKey);
  } catch (e) {
    // 忽略清理失败
  }
}
