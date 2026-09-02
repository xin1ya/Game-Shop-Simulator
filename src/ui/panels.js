/**
 * panels.js — 晨间决策面板（SKU 进货/定价滑杆/升级/员工）+ 日结画面 + 破产/胜利画面 + 标题画面 + 后仓面板。
 *
 * v2：进货按 SKU（步进 = 一箱 4 件）、定价按 SKU、员工雇佣/解雇/排班卡片、
 * 日结含薪资行、后仓面板展示四态库存。
 *
 * 只读 GameState；玩家意图通过 handlers 回调派发（main.js 负责调 sim 层）。
 *
 * @module ui/panels
 */

import { CONFIG } from '../config.js';
import { inventoryCap, rentFor, skuUnlocked } from '../sim/economy.js';
import { backroomOfCat, onShelfOf } from '../sim/logistics.js';
import { hire, fire, setDuty, dailyWageOf } from '../sim/staff.js';

/** 清空容器并挂载一个 overlay，返回 overlay 元素。 */
function mountOverlay(root) {
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  root.appendChild(overlay);
  return overlay;
}

/** 关闭面板（清空容器）。 */
export function closePanels(root) {
  root.innerHTML = '';
}

/**
 * 标题画面。
 * @param {HTMLElement} root
 * @param {{hasSave: boolean, onNew: Function, onContinue: Function}} opts
 */
export function showTitle(root, opts) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel title-card';
  panel.innerHTML = `
    <div class="logo">🎲🏠</div>
    <h1>桌游店物语</h1>
    <p>开门迎客 · 进货定价 · 收藏周边 · 把小店经营成街区名店！</p>
    <div class="btns">
      <button class="btn" data-k="new">✨ 新开一家店<span class="kbd">Enter</span></button>
      ${opts.hasSave ? '<button class="btn secondary" data-k="continue">📂 继续经营</button>' : ''}
    </div>
    <a class="dl-link" href="assets/glb/player.glb" download="player.glb">⬇ 下载店长人物模型（player.glb · 含 idle/walk 动画）</a>
  `;
  overlay.appendChild(panel);
  panel.querySelector('[data-k="new"]').addEventListener('click', () => opts.onNew());
  const cont = panel.querySelector('[data-k="continue"]');
  if (cont) cont.addEventListener('click', () => opts.onContinue());
}

/**
 * 晨间决策面板。
 * v2：SKU 级进货（步进 4 = 一箱）+ SKU 定价 + 升级 + 员工雇佣/排班。
 * @param {HTMLElement} root
 * @param {object} gs GameState
 * @param {{
 *   onPrice: (cat: string, price: number) => void,
 *   onSkuPrice: (skuId: string, price: number) => void,
 *   onUpgrade: (line: string) => boolean,
 *   onOpen: (orders: Record<string, number>) => void,
 *   onStaffChange: () => void,
 *   rng: object,
 * }} handlers
 */
export function showMorning(root, gs, handlers) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel';
  overlay.appendChild(panel);

  const sCfg = CONFIG.seasons;
  // 在途合计（早单当晚到 / 晚单次日早到）
  const inbound = CONFIG.skuOrder.reduce(
    (sum, id) => sum + gs.skus[id].inTransit + gs.skus[id].inBox, 0,
  );

  panel.innerHTML = `
    <h2>🌅 第 ${gs.day} 天 · 晨间准备 ${sCfg.emojis[gs.season]}${sCfg.names[gs.season]}季</h2>
    <div class="sub">现金 💰 ${gs.cash} ｜ 本季活动周剩余 ${gs.activityDaysLeft} 天 ｜ 下次账单日：第 ${Math.ceil(gs.day / CONFIG.rent.intervalDays) * CONFIG.rent.intervalDays} 天（租金 💰${rentFor(gs)}）｜ 商城今早下单 · 今晚打烊时送达</div>
    <div class="morning-cols">
      <div class="morning-col">
        <h3>📦 进货</h3><div data-k="mallEntry"></div>
        <h3>🏪 店铺扩张</h3><div data-k="expansion"></div>
      </div>
      <div class="morning-col morning-col-wide">
        <h3>🏷️ 定价（指导价 ±50%）</h3><div class="sku-scroll" data-k="prices"></div>
      </div>
      <div class="morning-col">
        <h3>🔧 店铺升级</h3><div data-k="upgrades"></div>
        <h3>🤝 员工</h3><div class="staff-section" data-k="staff"></div>
      </div>
    </div>
    <div class="morning-footer">
      <span data-k="total">📦 在途（陆续到店）：${inbound} 件</span>
      <button class="btn" data-k="open">🔔 开始备货<span class="kbd">Enter</span></button>
    </div>
  `;

  const mallEntry = panel.querySelector('[data-k="mallEntry"]');
  const priceBox = panel.querySelector('[data-k="prices"]');
  const upgradeBox = panel.querySelector('[data-k="upgrades"]');
  const expansionBox = panel.querySelector('[data-k="expansion"]');
  const staffBox = panel.querySelector('[data-k="staff"]');
  const totalEl = panel.querySelector('[data-k="total"]');
  const openBtn = panel.querySelector('[data-k="open"]');

  // ---- 商城入口（v3：进货移入全屏商城页；早上下单当晚到）----
  mallEntry.innerHTML = `
    <button class="btn mall-open" data-k="mall">🛒 打开进货商城<span class="kbd">M</span></button>
    <div class="mall-note">今早下单 · 今晚打烊时货车送达店门口</div>
    <div class="inbound-line">📦 在途（陆续到店）：<b>${inbound}</b> 件</div>
  `;
  mallEntry.querySelector('[data-k="mall"]').addEventListener('click', () => {
    if (handlers.onOpenMall) handlers.onOpenMall();
  });

  function refreshAll() {
    // 升级/员工操作后只刷新现金行（进货在商城页内闭环）
    totalEl.textContent = `📦 在途：${inbound} 件 ｜ 现金 💰 ${gs.cash}`;
  }

  // ---- SKU 定价滑杆 ----
  for (const skuId of CONFIG.skuOrder) {
    const sku = CONFIG.skus[skuId];
    if (!skuUnlocked(gs, skuId)) continue; // 未解锁不显示定价
    const e = CONFIG.economy;
    const min = Math.round(sku.guidePrice * e.priceClampMin);
    const max = Math.round(sku.guidePrice * e.priceClampMax);
    const row = document.createElement('div');
    row.className = 'sku-price-row';
    row.innerHTML = `
      <span class="name">${sku.emoji} ${sku.name}</span>
      <input type="range" min="${min}" max="${max}" step="1" value="${gs.skuPrices[skuId]}" />
      <span class="val"></span>
    `;
    const slider = row.querySelector('input');
    const val = row.querySelector('.val');
    const refreshVal = () => {
      const price = Number(slider.value);
      const pct = Math.round((price / sku.guidePrice) * 100);
      val.textContent = `💰${price} (${pct}%)`;
      val.classList.toggle('cheap', price <= sku.guidePrice * e.cheapThreshold);
      val.classList.toggle('pricey', price > sku.guidePrice * e.cheapThreshold);
    };
    slider.addEventListener('input', () => {
      handlers.onSkuPrice(skuId, Number(slider.value));
      refreshVal();
    });
    refreshVal();
    priceBox.appendChild(row);
  }

  // ---- 升级行 ----
  function renderUpgrades() {
    upgradeBox.innerHTML = '';
    for (const line of CONFIG.upgrades.lines) {
      const level = gs.upgrades[line];
      const maxed = level >= CONFIG.upgrades.maxLevel;
      const cost = maxed ? 0 : CONFIG.upgrades.costs[level + 1];
      const row = document.createElement('div');
      row.className = 'upgrade-row';
      row.innerHTML = `
        <span class="name">${CONFIG.upgrades.emojis[line]} ${CONFIG.upgrades.names[line]}</span>
        <span class="pips">${'●'.repeat(level)}${'○'.repeat(CONFIG.upgrades.maxLevel - level)}</span>
        <button ${maxed || gs.cash < cost ? 'disabled' : ''}>
          ${maxed ? '已满级' : `💰${cost}`}
        </button>
      `;
      if (!maxed) {
        row.querySelector('button').addEventListener('click', () => {
          if (handlers.onUpgrade(line)) {
            renderUpgrades();
            refreshAll(); // 货架升级影响库存上限
          }
        });
      }
      upgradeBox.appendChild(row);
    }
  }

  // ---- 店铺扩张区（2026-09：独立左列，三级一次性购买项）----
  function renderExpansion() {
    expansionBox.innerHTML = '';
    for (const def of (CONFIG.expansion && CONFIG.expansion.levels) || []) {
      const owned = gs.expansion && gs.expansion[def.id];
      const row = document.createElement('div');
      row.className = 'upgrade-row expansion-row';
      row.innerHTML = `
        <span class="name">${def.emoji} ${def.name}</span>
        <span class="pips exp-paths">${def.desc}</span>
        <button ${owned || gs.cash < def.cost ? 'disabled' : ''}>
          ${owned ? '✓ 已购' : `💰${def.cost}`}
        </button>
      `;
      if (!owned) {
        row.querySelector('button').addEventListener('click', () => {
          if (handlers.onExpansion && handlers.onExpansion(def.id)) {
            renderExpansion();
            renderUpgrades(); // 现金联动刷新
          }
        });
      }
      expansionBox.appendChild(row);
    }
  }
  renderExpansion();

  // ---- 员工区（雇佣 / 排班 / 解雇）----
  function renderStaff() {
    staffBox.innerHTML = '';
    const cfg = CONFIG.employees;
    // 雇佣位
    const hireRow = document.createElement('div');
    hireRow.className = 'hire-row';
    hireRow.innerHTML = cfg.roleOrder.map((role) => {
      const r = cfg.roles[role];
      const full = gs.staff.members.length >= cfg.maxCount;
      const poor = gs.cash < r.signBonus;
      return `<button data-role="${role}" ${full || poor ? 'disabled' : ''}>${r.emoji} ${r.name} 签约💰${r.signBonus} · 日薪${r.dailyWage}</button>`;
    }).join('');
    hireRow.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const res = hire(gs, handlers.rng, btn.dataset.role);
        if (res.ok) {
          renderStaff();
          refreshAll();
          if (handlers.onStaffChange) handlers.onStaffChange();
        }
      });
    });
    staffBox.appendChild(hireRow);
    // 在职卡片
    for (const m of gs.staff.members) {
      const roleDef = cfg.roles[m.role];
      const card = document.createElement('div');
      card.className = `staff-card${m.quitting ? ' quitting' : ''}`;
      const fatigueCls = m.fatigue > cfg.fatigue.severeAt ? 'high' : (m.fatigue > cfg.fatigue.penaltyAt ? 'mid' : '');
      card.innerHTML = `
        <span class="avatar">${roleDef.emoji}</span>
        <div class="body">
          <div><span class="role-name">${m.name} · ${roleDef.name}</span> <span class="stars">${'★'.repeat(m.stars)}</span></div>
          <div class="meta">日薪 💰${dailyWageOf(m)}${m.quitting ? ' ｜ ⚠️ 明天离职' : ''}</div>
          <div class="fatigue-bar"><div class="fatigue-fill ${fatigueCls}" style="width:${m.fatigue}%"></div></div>
        </div>
        <div class="ops">
          <button class="${m.onDutyToday ? 'duty-on' : ''}" data-k="duty">${m.onDutyToday ? '今日在岗' : '今日休息'}</button>
          <button class="fire" data-k="fire">解雇</button>
        </div>
      `;
      card.querySelector('[data-k="duty"]').addEventListener('click', () => {
        setDuty(gs, m.id, !m.onDutyToday);
        renderStaff();
      });
      card.querySelector('[data-k="fire"]').addEventListener('click', () => {
        const res = fire(gs, m.id);
        if (res.ok) {
          renderStaff();
          refreshAll();
          if (handlers.onStaffChange) handlers.onStaffChange();
        }
      });
      staffBox.appendChild(card);
    }
  }

  renderUpgrades();
  renderStaff();
  refreshAll();

  openBtn.addEventListener('click', () => {
    handlers.onOpen({}); // v3：进货已在商城页内即时下单，这里不再带订单
  });
}

/**
 * 进货商城（v3 需求 7）：全屏精美商城页，替代晨间面板的进货清单。
 * 卡片网格：商品图（assets/img/sku/<id>.png，Blender 渲染静态图，缺图回退 emoji）
 * + 进价/指导价/在库四态 + 整箱 stepper；购物车合计 + 现金校验；下单即时生效
 * （economy.restock 扣款 + 生成 ORDERED 单；早上下单当晚到，晚上下单次日早到）。
 * @param {HTMLElement} root
 * @param {object} gs GameState
 * @param {{
 *   onPlace: (orders: Record<string, number>) => void,  // 下单（main.js 调 restock）
 *   onClose: () => void,                                 // 返回晨间面板
 * }} handlers
 */
export function showMall(root, gs, handlers) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel wide mall';
  overlay.appendChild(panel);

  const boxCap = CONFIG.logistics.boxCapacity;
  const cart = {};
  for (const skuId of CONFIG.skuOrder) cart[skuId] = 0;
  const rarityNames = CONFIG.skuRarityNames || {};
  // 到货时段（2026-09）：白天下单当晚到，晚上下单次日早到
  const arriveText = gs.phase === 'EVENING' ? '明早备货时送达' : '今晚打烊时送达';
  const catNames = {
    boardgame_low: '平价桌游', boardgame_high: '精品桌游',
    snacks: '饮品零食', merch: '周边商品',
  };

  panel.innerHTML = `
    <h2>🛒 进货商城</h2>
    <div class="sub">现金 💰 <b>${gs.cash}</b> ｜ 整箱 ${boxCap} 件起订 ｜ 下单后 <b>${arriveText}</b>，货车送到店门口</div>
    <div class="mall-grid" data-k="grid"></div>
    <div class="morning-footer mall-footer">
      <span data-k="cartTotal">购物车：0 件 · 💰 0</span>
      <span class="mall-actions">
        <button class="btn secondary" data-k="close">🌅 返回<span class="kbd">Esc</span></button>
        <button class="btn" data-k="place" disabled>📦 下单（${arriveText}）<span class="kbd">Enter</span></button>
      </span>
    </div>
  `;

  const grid = panel.querySelector('[data-k="grid"]');
  const cartTotalEl = panel.querySelector('[data-k="cartTotal"]');
  const placeBtn = panel.querySelector('[data-k="place"]');

  const cartCount = () => CONFIG.skuOrder.reduce((s, id) => s + cart[id], 0);
  const cartCost = () => CONFIG.skuOrder.reduce(
    (s, id) => s + cart[id] * CONFIG.skus[id].cost, 0,
  );

  function refreshFooter() {
    const n = cartCount();
    const cost = cartCost();
    cartTotalEl.textContent = `购物车：${n} 件 · 💰 ${cost}（现金 ${gs.cash}）`;
    cartTotalEl.classList.toggle('over', cost > gs.cash);
    placeBtn.disabled = n === 0 || cost > gs.cash;
  }

  for (const skuId of CONFIG.skuOrder) {
    const sku = CONFIG.skus[skuId];
    const unlocked = skuUnlocked(gs, skuId);
    const card = document.createElement('div');
    card.className = `mall-card${unlocked ? '' : ' locked'}`;
    const cur = gs.skus[skuId];
    const stockTotal = cur.inTransit + cur.inBox + cur.backroom + cur.onShelf;
    card.innerHTML = `
      <div class="mall-img" data-k="img"></div>
      <div class="mall-name">${sku.emoji} ${sku.name}<span class="rarity">${rarityNames[sku.rarity] || ''}</span></div>
      <div class="mall-meta">
        <span>${catNames[sku.cat] || sku.cat}</span>
        <span>进价 💰${sku.cost} / 指导 💰${sku.guidePrice}</span>
        <span data-k="stock">在库 ${stockTotal}（不限量）${cur.inTransit > 0 ? `（在途 ${cur.inTransit}）` : ''}</span>
      </div>
      ${unlocked ? `
      <div class="stepper">
        <button data-k="minus">−</button>
        <span class="qty">0</span>
        <button data-k="plus">＋</button>
      </div>` : `
      <div class="lock-hint">🔒 声望 ${sku.unlockRep} 解锁（当前 ${gs.reputation}）</div>`}
    `;
    // 商品图（静态渲染 PNG；加载失败回退大 emoji）
    const imgBox = card.querySelector('[data-k="img"]');
    const img = document.createElement('img');
    img.src = `assets/img/sku/${skuId}.png`;
    img.alt = sku.name;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      imgBox.textContent = sku.emoji;
      imgBox.classList.add('emoji-fallback');
    });
    imgBox.appendChild(img);

    if (unlocked) {
      const qtyEl = card.querySelector('.qty');
      const minus = card.querySelector('[data-k="minus"]');
      const plus = card.querySelector('[data-k="plus"]');
      const refreshBtns = () => {
        qtyEl.textContent = String(cart[skuId]);
        minus.disabled = cart[skuId] <= 0;
        // 2026-09 在库上限取消：只受现金约束
        plus.disabled = cartCost() + sku.cost * boxCap > gs.cash;
      };
      minus.addEventListener('click', () => {
        if (cart[skuId] > 0) { cart[skuId] -= boxCap; refreshAll(); }
      });
      plus.addEventListener('click', () => {
        if (!plus.disabled) { cart[skuId] += boxCap; refreshAll(); }
      });
      card._refreshBtns = refreshBtns;
    }
    grid.appendChild(card);
  }

  function refreshAll() {
    grid.querySelectorAll('.mall-card').forEach((c) => {
      if (c._refreshBtns) c._refreshBtns();
    });
    refreshFooter();
  }

  panel.querySelector('[data-k="close"]').addEventListener('click', () => handlers.onClose());
  placeBtn.addEventListener('click', () => {
    if (placeBtn.disabled) return;
    handlers.onPlace({ ...cart });
    for (const skuId of CONFIG.skuOrder) cart[skuId] = 0;
    handlers.onClose(); // 下单后回晨间面板（摘要刷新）
  });

  refreshAll();
}

/**
 * 找零面板（v3 需求 4）：左侧顾客购物清单，右侧金额区 + 数字键盘。
 * 答对 → 立即完成该客结账（onCorrect）；答错 → 抖动重试（onWrong，该客满意度封顶 0）；
 * Esc 仅关闭可重开（手动结账只保留本小游戏通道，无计时兜底）。
 * 游戏不暂停（队首耐心实时消耗，答错/犹豫有代价）。
 * @param {HTMLElement} root popup 容器
 * @param {{customerId:number, items:Array, total:number, bill:number, change:number}} order getCheckoutOrder 产物
 * @param {{onCorrect: () => void, onWrong: () => void, onGiveUp: () => void}} handlers
 * @returns {{close: () => void, isOpen: () => boolean}}
 */
export function showChangePanel(root, order, handlers) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.dataset.change = '1';
  const panel = document.createElement('div');
  panel.className = 'panel change';
  const itemRows = order.items.map((it) => `
    <div class="change-item">
      <span class="emoji">${it.emoji}</span>
      <span class="name">${it.name}</span>
      <span class="qty">×${it.qty}</span>
      <span class="price">💰${it.price}</span>
    </div>`).join('');
  panel.innerHTML = `
    <h2>💳 收银找零</h2>
    <div class="change-cols">
      <div class="change-left">
        <h3>🧾 购物清单</h3>
        ${itemRows}
      </div>
      <div class="change-right">
        <div class="change-line"><span>应收</span><b>💰 ${order.total}</b></div>
        <div class="change-line"><span>实收（顾客递来）</span><b>💰 ${order.bill}</b></div>
        <div class="change-line target"><span>找零</span><b>💰 ？</b></div>
        <div class="change-display" data-k="display">0</div>
        <div class="change-numpad" data-k="numpad"></div>
        <div class="change-actions">
          <button class="btn" data-k="confirm">确认找零<span class="kbd">Enter</span></button>
        </div>
      </div>
    </div>
  `;
  overlay.appendChild(panel);
  root.appendChild(overlay);

  const display = panel.querySelector('[data-k="display"]');
  const numpad = panel.querySelector('[data-k="numpad"]');
  let input = '';
  let wrongCount = 0;

  function refresh() {
    display.textContent = input === '' ? '0' : input;
  }
  function press(k) {
    if (k === 'C') { input = ''; }
    else if (k === '←') { input = input.slice(0, -1); }
    else if (input.length < 6) { input = (input + k).replace(/^0+(?=\d)/, ''); }
    refresh();
  }
  for (const k of ['1','2','3','4','5','6','7','8','9','0','←','C']) {
    const btn = document.createElement('button');
    btn.textContent = k;
    btn.addEventListener('click', () => press(k));
    numpad.appendChild(btn);
  }
  function onKey(ev) {
    if (/^Digit[0-9]$/.test(ev.code) || /^Numpad[0-9]$/.test(ev.code)) {
      press(ev.code.slice(-1));
    } else if (ev.code === 'Backspace') { press('←'); }
    else if (ev.code === 'Enter' || ev.code === 'NumpadEnter') { confirm(); }
    else if (ev.code === 'Escape') { close(); } // Esc 仅关闭（可再按 F 重开）
  }
  window.addEventListener('keydown', onKey);

  function confirm() {
    const val = Number(input || '0');
    if (val === order.change) {
      close();
      handlers.onCorrect();
    } else {
      wrongCount += 1;
      if (wrongCount === 1) handlers.onWrong();
      input = '';
      refresh();
      panel.classList.remove('shake');
      void panel.offsetWidth; // 重触抖动动画
      panel.classList.add('shake');
    }
  }
  panel.querySelector('[data-k="confirm"]').addEventListener('click', confirm);
  let open = true;
  function close() {
    if (!open) return;
    open = false;
    window.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  return { close, isOpen: () => open };
}

/** 找零面板是否开着。 */
export function isChangeOpen(root) {
  return Boolean(root.querySelector('[data-change]'));
}

/**
 * 库房取货选择（v3 需求 10）：从后仓拿一箱货上手（≤4 件）。
 * 挂在 popupRoot（会话中弹出，不遮全屏；游戏继续跑）。
 * @param {HTMLElement} root popup 容器
 * @param {object} gs GameState
 * @param {{onPick: (skuId: string) => void, onClose: () => void}} handlers
 */
export function showTakeout(root, gs, handlers) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.dataset.takeout = '1';
  const panel = document.createElement('div');
  panel.className = 'panel takeout';
  panel.innerHTML = `<h2>📦 库房取货</h2><div class="sub">选择要拿上手的商品（一次一箱 ≤${CONFIG.logistics.boxCapacity} 件）</div>`;
  const list = document.createElement('div');
  list.className = 'takeout-list';
  let any = false;
  for (const skuId of CONFIG.skuOrder) {
    const st = gs.skus[skuId];
    if (!st || st.backroom <= 0) continue;
    any = true;
    const sku = CONFIG.skus[skuId];
    const btn = document.createElement('button');
    btn.className = 'takeout-item';
    btn.innerHTML = `${sku.emoji} ${sku.name} <span class="qty">后仓 ×${st.backroom}</span>`;
    btn.addEventListener('click', () => {
      handlers.onPick(skuId);
      close();
    });
    list.appendChild(btn);
  }
  if (!any) {
    list.innerHTML = '<div class="sub">后仓空空如也——先去门口搬箱或去商城进货。</div>';
  }
  panel.appendChild(list);
  const footer = document.createElement('div');
  footer.className = 'report-footer';
  footer.innerHTML = '<button class="btn secondary" data-k="close">取消</button>';
  footer.querySelector('[data-k="close"]').addEventListener('click', () => close());
  panel.appendChild(footer);
  overlay.appendChild(panel);
  root.appendChild(overlay);

  function close() {
    overlay.remove();
    handlers.onClose();
  }
}

/** 取货面板是否开着（main.js 键位守卫用）。 */
export function isTakeoutOpen(root) {
  return Boolean(root.querySelector('[data-takeout]'));
}

/**
 * 价签调价面板（2026-09：准星/点击货架价格标签左键打开）。
 * 数字输入 + 步进按钮，范围钳制在指导价 ±50%（setSkuPrice 内部再钳一次兜底）。
 * @param {HTMLElement} root
 * @param {object} gs GameState
 * @param {string} skuId
 * @param {{onSet: (price:number)=>void, onClose: ()=>void}} handlers
 */
export function showPricePanel(root, gs, skuId, handlers) {
  const sku = CONFIG.skus[skuId];
  if (!sku) return;
  const guide = sku.guidePrice;
  const min = Math.round(guide * CONFIG.economy.priceClampMin);
  const max = Math.round(guide * CONFIG.economy.priceClampMax);
  const cur = gs.skuPrices[skuId];
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.dataset.pricePanel = '1';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <h2>🏷️ 调整价格</h2>
    <div class="sub">${sku.emoji} ${sku.name} — 当前 💰${cur} ｜ 指导 💰${guide}（可设 ${min}~${max}）</div>
    <div class="price-row">
      <button class="btn secondary" data-k="m10">−10</button>
      <button class="btn secondary" data-k="m1">−1</button>
      <input data-k="val" type="number" value="${cur}" min="${min}" max="${max}"
        style="width:90px;font-size:22px;text-align:center;padding:6px;border-radius:10px;border:2px solid #c9a25f;background:#fffaf0;color:#5b3a1a" />
      <button class="btn secondary" data-k="p1">＋1</button>
      <button class="btn secondary" data-k="p10">＋10</button>
    </div>
    <div class="report-footer">
      <button class="btn" data-k="ok">✅ 确定 <span class="kbd">Enter</span></button>
      <button class="btn secondary" data-k="cancel">取消 <span class="kbd">Esc</span></button>
    </div>`;
  overlay.appendChild(panel);
  root.appendChild(overlay);
  const input = panel.querySelector('[data-k="val"]');
  const clampVal = () => Math.min(max, Math.max(min, Math.round(Number(input.value) || cur)));
  for (const [k, d] of [['m10', -10], ['m1', -1], ['p1', 1], ['p10', 10]]) {
    panel.querySelector(`[data-k="${k}"]`).addEventListener('click', () => {
      input.value = String(Math.min(max, Math.max(min, (Math.round(Number(input.value) || cur)) + d)));
    });
  }
  panel.querySelector('[data-k="ok"]').addEventListener('click', () => {
    handlers.onSet(clampVal());
    close();
  });
  panel.querySelector('[data-k="cancel"]').addEventListener('click', () => close());
  input.addEventListener('keydown', (ev) => {
    if (ev.code === 'Enter') { ev.stopPropagation(); handlers.onSet(clampVal()); close(); }
    if (ev.code === 'Escape') { ev.stopPropagation(); close(); }
  });
  input.focus();
  input.select();
  function close() {
    overlay.remove();
    handlers.onClose();
  }
}

/** 调价面板是否开着（main.js 键位守卫用）。 */
export function isPricePanelOpen(root) {
  return Boolean(root.querySelector('[data-price-panel]'));
}

/**
 * 后仓面板（Tab 键 / 员工通道门打开）：四态库存一览。
 * @param {HTMLElement} root
 * @param {object} gs GameState
 * @param {{onClose: Function}} handlers
 */
export function showBackroom(root, gs, handlers) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel';
  const catNames = {
    boardgame_low: '🎲 平价桌游', boardgame_high: '👑 精品桌游',
    snacks: '🧋 饮品零食', merch: '🎁 周边商品',
  };
  const cells = CONFIG.categoryOrder.map((cat) => {
    const onShelf = onShelfOf(gs, cat);
    const back = backroomOfCat(gs, cat);
    const inTransit = CONFIG.skuOrder
      .filter((id) => CONFIG.skus[id].cat === cat)
      .reduce((sum, id) => sum + gs.skus[id].inTransit + gs.skus[id].inBox, 0);
    return `
      <div class="backroom-cell${onShelf === 0 && back === 0 ? ' empty' : ''}">
        <div class="title">${catNames[cat]}</div>
        <div class="qty">货架 ${onShelf} ｜ 后仓 ${back}</div>
        <div class="sub">在途/箱中 ${inTransit} ｜ 库存不限量（2026-09 取消上限）</div>
      </div>
    `;
  }).join('');
  panel.innerHTML = `
    <h2>📦 后仓与货架</h2>
    <div class="sub">只有货架上的货才可售；后仓的货需要走到对应货架按住 F 上架</div>
    <div class="backroom-grid">${cells}</div>
    <div class="report-footer"><button class="btn" data-k="close">关闭（Tab）</button></div>
  `;
  overlay.appendChild(panel);
  panel.querySelector('[data-k="close"]').addEventListener('click', () => handlers.onClose());
}

/**
 * 日结画面。
 * @param {HTMLElement} root
 * @param {object} gs GameState
 * @param {object} report DayReport
 * @param {{onNext: Function}} handlers
 */
export function showClosing(root, gs, report, handlers) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel';
  const fmt = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const milestones = [];
  if (report.rentDue) milestones.push(`📜 账单日：已扣租金 💰${report.rent}`);
  if (report.bought > 0) {
    milestones.push(`🛒 转化率 ${Math.round((report.bought / Math.max(1, report.footfall)) * 100)}%（${report.bought}/${report.footfall}）`);
  }
  const collected = gs.collectibles.filter((c) => c.owned).length;
  if (collected > 0) milestones.push(`🎁 收藏进度 ${collected}/${gs.collectibles.length}`);
  panel.innerHTML = `
    <h2>🌙 第 ${report.day} 天 · 打烊结算</h2>
    <div class="sub">现金流与口碑一览，规划明天吧！</div>
    <div class="report-grid">
      <div class="row"><span>🛒 销售收入</span><span class="num pos">+${report.revenue}</span></div>
      <div class="row"><span>🛋️ 体验费</span><span class="num pos">+${report.experienceIncome}</span></div>
      <div class="row"><span>📦 进货成本</span><span class="num neg">−${report.restockCost}</span></div>
      ${report.wages > 0 ? `<div class="row staff-row"><span>🤝 员工薪资</span><span class="num neg">−${report.wages}</span></div>` : ''}
      ${report.severance > 0 ? `<div class="row staff-row"><span>👋 遣散费</span><span class="num neg">−${report.severance}</span></div>` : ''}
      <div class="row"><span>📜 租金</span><span class="num neg">−${report.rent}</span></div>
      <div class="row"><span>💰 当日净利</span><span class="num ${report.net - report.rent >= 0 ? 'pos' : 'neg'}">${fmt(report.net - report.rent)}</span></div>
      <div class="row"><span>💼 结余现金</span><span class="num">${report.cash}</span></div>
      <div class="row"><span>👥 客流（买/流失）</span><span class="num">${report.footfall}（${report.bought}/${report.lost}）</span></div>
      <div class="row"><span>⭐ 声望</span><span class="num ${report.reputation - report.repBefore >= 0 ? 'pos' : 'neg'}">${report.repBefore} → ${report.reputation}（${fmt(report.reputation - report.repBefore)}）</span></div>
    </div>
    <ul class="report-milestones">${milestones.map((m) => `<li>${m}</li>`).join('')}</ul>
    <div class="report-footer"><button class="btn" data-k="next">🧹 打烊整理（理货 / 下单）<span class="kbd">Enter</span></button></div>
  `;
  overlay.appendChild(panel);
  panel.querySelector('[data-k="next"]').addEventListener('click', () => handlers.onNext());
}

/**
 * 破产画面。
 */
export function showGameOver(root, gs, handlers) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel endcard';
  panel.innerHTML = `
    <div class="big">💸</div>
    <h1>破产了……</h1>
    <p>${CONFIG.strings.gameoverText}<br/>坚持了 ${gs.day} 天 ｜ 最终声望 ${gs.reputation}</p>
    <div class="btns"><button class="btn danger" data-k="restart">🔄 重新开店</button></div>
  `;
  overlay.appendChild(panel);
  panel.querySelector('[data-k="restart"]').addEventListener('click', () => handlers.onRestart());
}

/**
 * 胜利画面（街区名店）。
 */
export function showVictory(root, gs, handlers) {
  const overlay = mountOverlay(root);
  const panel = document.createElement('div');
  panel.className = 'panel endcard';
  panel.innerHTML = `
    <div class="big">🏆</div>
    <h1>街区名店！</h1>
    <p>${CONFIG.strings.victoryText}<br/>用时 ${gs.day} 天 ｜ 现金 💰${gs.cash} ｜ 收藏 ${gs.collectibles.filter((c) => c.owned).length}/${gs.collectibles.length}</p>
    <div class="btns">
      <button class="btn" data-k="continue">🏠 继续自由经营</button>
      <button class="btn secondary" data-k="restart">🔄 再开一家</button>
    </div>
  `;
  overlay.appendChild(panel);
  panel.querySelector('[data-k="continue"]').addEventListener('click', () => handlers.onContinue());
  panel.querySelector('[data-k="restart"]').addEventListener('click', () => handlers.onRestart());
}
