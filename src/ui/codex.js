/**
 * codex.js — 图鉴面板（常客故事 / 周边收藏 Tab）+ 顾客信息卡片 + 文本剧情弹窗。
 *
 * 只读 GameState；UI 只负责渲染 config 中的文案。
 *
 * @module ui/codex
 */

import { CONFIG } from '../config.js';

/**
 * 打开图鉴面板。
 * @param {HTMLElement} root popup 容器
 * @param {object} gs GameState
 * @param {Function} onClose 关闭回调
 */
export function openCodex(root, gs, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.dataset.codex = '1';
  const panel = document.createElement('div');
  panel.className = 'panel';
  overlay.appendChild(panel);
  root.appendChild(overlay);

  function render(tab) {
    const regularsActive = tab === 'regulars';
    let bodyHtml = '';
    if (regularsActive) {
      bodyHtml = '<div class="codex-list">'
        + gs.regulars.map((reg) => {
          const def = CONFIG.regulars.find((r) => r.id === reg.id);
          const typeDef = CONFIG.customerTypes[reg.type];
          if (!reg.unlocked) {
            return `<div class="codex-item locked">
              <span class="avatar">❓</span>
              <div class="body"><div class="title">？？？</div>
              <div class="story">声望达到 ${def.unlockRep} 后可能出现……</div></div>
            </div>`;
          }
          const story = reg.storyStage > 0 ? def.stories[reg.storyStage - 1] : '还没有什么故事，让他满意而归吧。';
          return `<div class="codex-item">
            <span class="avatar">${typeDef.emoji}</span>
            <div class="body">
              <div class="title">${reg.name} <span class="pips">${'★'.repeat(reg.storyStage)}${'☆'.repeat(3 - reg.storyStage)}</span></div>
              <div>${typeDef.name} ｜ 到访 ${reg.visits} 次${reg.completed ? ' ｜ ✅ 故事完结' : ''}</div>
              <div class="story">${story}</div>
            </div>
          </div>`;
        }).join('') + '</div>';
    } else {
      bodyHtml = '<div class="codex-grid">'
        + gs.collectibles.map((c) => {
          const rEmoji = CONFIG.rarityEmojis[c.rarity];
          const rName = CONFIG.rarityNames[c.rarity];
          if (!c.owned) {
            return `<div class="codex-cell locked"><span class="icon">❔</span>？？？<div class="rarity">${rEmoji} ${rName}</div></div>`;
          }
          return `<div class="codex-cell"><span class="icon">🎁</span>${c.name}<div class="rarity">${rEmoji} ${rName}</div></div>`;
        }).join('') + '</div>'
        + '<div class="sub" style="margin-top:10px">🔵 稀有周边：获得时声望 +1 ｜ 🟡 传说周边：客流 +10%（进货周边商品时概率掉落）</div>';
    }
    panel.innerHTML = `
      <h2>📖 图鉴</h2>
      <div class="codex-tabs">
        <button data-k="regulars" class="${regularsActive ? 'active' : ''}">💛 常客故事</button>
        <button data-k="collect" class="${regularsActive ? '' : 'active'}">🎁 周边收藏</button>
      </div>
      ${bodyHtml}
      <div class="report-footer"><button class="btn secondary" data-k="close">关闭</button></div>
    `;
    panel.querySelector('[data-k="regulars"]').addEventListener('click', () => render('regulars'));
    panel.querySelector('[data-k="collect"]').addEventListener('click', () => render('collect'));
    panel.querySelector('[data-k="close"]').addEventListener('click', () => {
      overlay.remove();
      onClose();
    });
  }
  render('regulars');
}

/** 当前是否开着图鉴。 */
export function isCodexOpen(root) {
  return root.querySelector('[data-codex]') !== null;
}

/**
 * 显示顾客信息卡片（点击顾客时）。
 * @param {HTMLElement} root popup 容器
 * @param {object} customer Customer
 * @param {number} x 屏幕 x 像素
 * @param {number} y 屏幕 y 像素
 */
export function showCustomerCard(root, customer, x, y) {
  closeCustomerCard(root);
  const def = CONFIG.customerTypes[customer.type];
  const card = document.createElement('div');
  card.className = 'cust-card';
  card.dataset.custCard = '1';
  const moodEmoji = customer.state === 'LEAVING_ANGRY' ? '💢'
    : customer.bought.length > 0 ? '❤️'
      : customer.state === 'EXPERIENCING' ? '🎲' : '🙂';
  const topPref = CONFIG.categoryOrder
    .slice()
    .sort((a, b) => (customer.pref[b] || 0) - (customer.pref[a] || 0))[0];
  const patiencePct = Math.max(0, Math.min(100,
    (customer.patience / def.patience[1]) * 100));
  const stateNames = {
    ENTERING: '进店中', BROWSING: '浏览货架', TO_EXPERIENCE: '前往体验区',
    EXPERIENCING: '试玩中', TO_CHECKOUT: '前往收银台', PAYING: '结账中',
    LEAVING: '满意离开', LEAVING_ANGRY: '生气离开',
  };
  card.innerHTML = `
    <div class="title">${def.emoji} ${def.name} <span class="mood">${moodEmoji}</span></div>
    <div>💰 预算 ${customer.budget} ｜ ❤️ 喜欢：${CONFIG.products[topPref].name}</div>
    <div>📍 ${stateNames[customer.state] || customer.state}</div>
    <div class="patience-bar"><div class="patience-fill" style="width:${patiencePct}%"></div></div>
  `;
  const px = Math.min(window.innerWidth - 220, Math.max(10, x + 14));
  const py = Math.min(window.innerHeight - 160, Math.max(60, y - 20));
  card.style.left = `${px}px`;
  card.style.top = `${py}px`;
  root.appendChild(card);
}

/** 关闭顾客信息卡片。 */
export function closeCustomerCard(root) {
  const old = root.querySelector('[data-cust-card]');
  if (old) old.remove();
}

/**
 * 弹出一条剧情/通知文本（带"继续"按钮）。
 * @param {HTMLElement} root popup 容器
 * @param {string} text 文案
 * @param {Function} onClose 关闭回调
 */
export function showStoryPopup(root, text, onClose) {
  const el = document.createElement('div');
  el.className = 'story-popup';
  el.dataset.story = '1';
  el.innerHTML = `<div>${text}</div><div class="btns"><button class="btn secondary" data-k="ok">继续 ▶<span class="kbd">Space</span></button></div>`;
  root.appendChild(el);
  el.querySelector('[data-k="ok"]').addEventListener('click', () => {
    el.remove();
    onClose();
  });
}

/** 是否正有剧情弹窗。 */
export function isStoryOpen(root) {
  return root.querySelector('[data-story]') !== null;
}
