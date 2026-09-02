/**
 * story.js — 常客故事线推进 + 周边收藏掉落/效果。
 *
 * 纯 ES Module；副作用集中写进 GameState（regulars / collectibles /
 * storyQueue / reputation / cash）。
 *
 * @module sim/story
 */

import { CONFIG } from '../config.js';

/** 数值工具：clamp。 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 按 id 取常客静态定义。 */
export function regularDef(id) {
  return CONFIG.regulars.find((r) => r.id === id) || null;
}

/**
 * 顾客完成购买后调用：推进常客进度 / 剧情事件队列。
 * 规则：常客顾客满意度 ≥1 时 storyStage +1；满 3 段完结并发一次性奖励。
 * @param {object} gs GameState
 * @param {object} customer 顾客（需含 regularId / satisfaction）
 */
export function onCustomerServed(gs, customer) {
  if (!customer.regularId) return;
  const reg = gs.regulars.find((r) => r.id === customer.regularId);
  const def = regularDef(customer.regularId);
  if (!reg || !def || reg.completed) return;
  if (customer.satisfaction < 1) return;
  if (reg.storyStage < def.stories.length) {
    reg.storyStage += 1;
    gs.storyQueue.push(def.stories[reg.storyStage - 1]);
  }
  if (reg.storyStage >= def.stories.length) {
    reg.completed = true;
    const parts = [];
    if (def.reward.cash > 0) {
      gs.cash += def.reward.cash;
      parts.push(`💰 +${def.reward.cash}`);
    }
    if (def.reward.rep > 0) {
      gs.reputation = clamp(gs.reputation + def.reward.rep, 0, CONFIG.reputationGoal);
      parts.push(`⭐ 声望 +${def.reward.rep}`);
    }
    gs.storyQueue.push(
      CONFIG.strings.regularReward
        .replace('{name}', reg.name)
        .replace('{reward}', parts.join('、') || '🎉 祝福'),
    );
  }
}

/**
 * 进货 merch 时按单位独立 roll 收藏掉落。
 * 传说 1.5% / 稀有 6% / 普通 20%；该稀有度池已集齐则向低档顺延。
 * 稀有：声望 +2；传说：提供全局客流 +10%（由 economy.dailyFootfall 读取）。
 * @param {object} gs GameState
 * @param {object} rng 种子随机数实例
 * @param {number} merchQty 本次 merch 进货数量
 * @returns {{id: string, name: string, rarity: string}[]} 新获得的收藏列表
 */
export function rollCollectibleDrop(gs, rng, merchQty) {
  const drops = [];
  const d = CONFIG.drops;
  const tiers = ['legendary', 'rare', 'normal'];
  for (let i = 0; i < merchQty; i += 1) {
    const roll = rng.next();
    let tier = null;
    if (roll < d.legendaryChance) tier = 'legendary';
    else if (roll < d.legendaryChance + d.rareChance) tier = 'rare';
    else if (roll < d.legendaryChance + d.rareChance + d.normalChance) tier = 'normal';
    if (!tier) continue;
    // 该档已集齐则向低档顺延寻找未获得品
    let picked = null;
    for (let k = tiers.indexOf(tier); k < tiers.length; k += 1) {
      const pool = gs.collectibles.filter((c) => c.rarity === tiers[k] && !c.owned);
      if (pool.length > 0) {
        picked = pool[Math.floor(rng.next() * pool.length)];
        break;
      }
    }
    if (!picked) continue;
    picked.owned = true;
    drops.push({ id: picked.id, name: picked.name, rarity: picked.rarity });
    gs.storyQueue.push(
      CONFIG.strings.dropAnnounce
        .replace('{emoji}', CONFIG.rarityEmojis[picked.rarity])
        .replace('{rarity}', CONFIG.rarityNames[picked.rarity])
        .replace('{name}', picked.name),
    );
    if (picked.rarity === 'rare') {
      gs.reputation = clamp(gs.reputation + d.rareRepBonus, 0, CONFIG.reputationGoal);
    }
  }
  return drops;
}

/** 是否持有任一传说周边（客流 +10% 效果）。 */
export function hasLegendary(gs) {
  return gs.collectibles.some((c) => c.rarity === 'legendary' && c.owned);
}
