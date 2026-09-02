/**
 * rng.js — mulberry32 种子随机数工厂。
 *
 * 一切随机性必须来自本模块注入的 rng 实例，禁止使用 Math.random()。
 * rng.state 为可序列化的 32 位无符号整数，随 GameState 存档以保证可复现。
 *
 * @module rng
 */

/**
 * 创建 mulberry32 随机数生成器。
 * @param {number} seed 种子（会被转为 32 位无符号整数；0 会被替换为 1）。
 * @returns {{
 *   next: () => number,
 *   int: (min: number, max: number) => number,
 *   pick: <T>(arr: T[]) => T,
 *   state: number,
 * }} rng 实例。next() 返回 [0,1)；int(min,max) 返回闭区间整数；pick 等概率取元素。
 */
export function createRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  const rng = {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) {
      return min + Math.floor(rng.next() * (max - min + 1));
    },
    pick(arr) {
      return arr[Math.floor(rng.next() * arr.length)];
    },
    get state() {
      return s >>> 0;
    },
    set state(v) {
      s = (v >>> 0) || 1;
    },
  };
  return rng;
}
