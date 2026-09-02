/**
 * hud.js — 顶部 HUD（日期/季节/资金/声望条/当日客流）+ 加速按钮 + 图鉴按钮。
 * v2 新增：PREP 状态条 / 队列牌 / 交互提示 / 环形进度条 / 需求气泡列表 / 手持提示。
 *
 * 只读 GameState；玩家意图通过 handlers 回调派发。
 *
 * @module ui/hud
 */

import { CONFIG } from '../config.js';

export class Hud {
  /**
   * @param {HTMLElement} root hud 容器
   * @param {{onToggleSpeed: Function, onOpenCodex: Function, onRespondNeed?: Function}} handlers
   */
  constructor(root, handlers) {
    this.handlers = handlers;
    this.root = root;
    this.bar = document.createElement('div');
    this.bar.className = 'hud-bar';
    this.bar.innerHTML = `
      <span class="hud-item" data-k="date"></span>
      <span class="hud-item" data-k="cash"></span>
      <span class="hud-item" data-k="rep">
        ⭐ <span class="hud-rep-bar"><span class="hud-rep-fill"></span></span>
        <span data-k="repnum"></span><span class="hud-rep-pending" data-k="reppending"></span>
      </span>
      <span class="hud-item" data-k="foot"></span>
      <span class="hud-item" data-k="clock"></span>
      <button class="hud-btn" data-k="codex">图鉴 <span class="kbd">C</span></button>
      <button class="hud-btn" data-k="speed">倍速 ×1 <span class="kbd">X</span></button>
    `;
    root.appendChild(this.bar);
    this.$ = (k) => this.bar.querySelector(`[data-k="${k}"]`);
    this.repFill = this.bar.querySelector('.hud-rep-fill');
    this.$('codex').addEventListener('click', () => handlers.onOpenCodex());
    this.$('speed').addEventListener('click', () => handlers.onToggleSpeed());

    // 第一人称：屏幕中心准星 + 底部操作提示（默认隐藏）
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'fp-crosshair';
    this.crosshair.style.display = 'none';
    root.appendChild(this.crosshair);
    this.hint = document.createElement('div');
    this.hint.className = 'fp-hint';
    this.hint.style.display = 'none';
    root.appendChild(this.hint);

    // ---- v2 新增 HUD 元素 ----
    // 交互提示条（准星上方「按住 F 开箱 🎁 · 1.2m」）
    this.interactEl = document.createElement('div');
    this.interactEl.className = 'fp-interact';
    this.interactEl.style.display = 'none';
    root.appendChild(this.interactEl);

    // 环形进度条（按住 F 进行中）
    this.progressEl = document.createElement('div');
    this.progressEl.className = 'fp-progress';
    this.progressEl.style.display = 'none';
    this.progressEl.innerHTML = `
      <svg viewBox="0 0 64 64">
        <circle class="track" cx="32" cy="32" r="27"></circle>
        <circle class="fill" cx="32" cy="32" r="27"></circle>
      </svg>
      <div class="label"></div>
    `;
    root.appendChild(this.progressEl);
    this.progressFill = this.progressEl.querySelector('.fill');
    this.progressLabel = this.progressEl.querySelector('.label');
    this.progressCircumference = 2 * Math.PI * 27;

    // 队列牌（🧍×3/5）
    this.queueBadge = document.createElement('div');
    this.queueBadge.className = 'queue-badge';
    this.queueBadge.style.display = 'none';
    root.appendChild(this.queueBadge);

    // v3 手持物品提示（需求 3；样式类 .fp-carry 早已存在于 CSS）
    this.carryEl = document.createElement('div');
    this.carryEl.className = 'fp-carry';
    this.carryEl.style.display = 'none';
    root.appendChild(this.carryEl);

    // PREP 状态条（货车 ETA / 箱数 / 倒计时）
    this.prepStatus = document.createElement('div');
    this.prepStatus.className = 'prep-status';
    this.prepStatus.style.display = 'none';
    root.appendChild(this.prepStatus);

    // 需求气泡列表（右侧）
    this.needList = document.createElement('div');
    this.needList.className = 'need-list';
    this.needList.style.display = 'none';
    root.appendChild(this.needList);

    // 距离过远提示
    this.farHint = document.createElement('div');
    this.farHint.className = 'fp-far-hint';
    this.farHint.style.display = 'none';
    root.appendChild(this.farHint);
  }

  /**
   * 显示 / 隐藏第一人称准星。
   * @param {boolean} visible
   */
  setCrosshair(visible) {
    this.crosshair.style.display = visible ? 'block' : 'none';
  }

  /**
   * 显示 / 隐藏第一人称操作提示（text 为 null 时隐藏）。
   * @param {string|null} text
   */
  setHint(text) {
    if (text) {
      this.hint.textContent = text;
      this.hint.style.display = 'block';
    } else {
      this.hint.style.display = 'none';
    }
  }

  /**
   * 交互提示条（2026-09 双键）：{lmb, rmb} 各为 resolveTarget 结果或 null。
   * 左键 = 放置/操作/服务；右键 = 拾起。等距模式左键提示显示为 F（左键留给点选顾客）。
   * @param {{lmb: object|null, rmb: object|null}|null} target
   * @param {boolean} isFp 第一人称（显示距离）；等距不显示距离
   */
  setInteract(target, isFp) {
    if (!target || (!target.lmb && !target.rmb)) {
      this.interactEl.style.display = 'none';
      return;
    }
    const parts = [];
    const fmt = (t, keyName) => {
      const dist = isFp ? `<span class="dist ${t.inRange ? '' : 'far'}">${t.distance.toFixed(1)}m</span>` : '';
      return `${keyName} ${t.label}${dist}`;
    };
    if (target.lmb) parts.push(fmt(target.lmb, isFp ? '👈左键' : '👈F'));
    if (target.rmb) parts.push(fmt(target.rmb, '👉右键'));
    this.interactEl.innerHTML = parts.join(' ｜ ');
    this.interactEl.style.display = 'block';
  }

  /**
   * 环形进度条：holdProgress(session) 的结果。
   * @param {{active: boolean, label: string|null, ratio: number}} prog
   */
  setProgress(prog) {
    if (!prog || !prog.active) {
      this.progressEl.style.display = 'none';
      return;
    }
    this.progressEl.style.display = 'block';
    this.progressLabel.textContent = prog.label || '';
    const offset = this.progressCircumference * (1 - Math.min(1, Math.max(0, prog.ratio)));
    this.progressFill.style.strokeDasharray = `${this.progressCircumference}`;
    this.progressFill.style.strokeDashoffset = `${offset}`;
  }

  /**
   * 需求气泡列表。
   * @param {Array} items needDisplay 结果数组（含 id/kind/emoji/text/urgent/cooling/distText）
   */
  setNeeds(items) {
    if (!items || items.length === 0) {
      this.needList.style.display = 'none';
      return;
    }
    this.needList.style.display = 'flex';
    this.needList.innerHTML = '';
    for (const n of items) {
      const el = document.createElement('div');
      el.className = `need-item${n.urgent ? ' urgent' : ''}${n.cooling ? ' cooling' : ''}`;
      el.innerHTML = `
        <span class="emoji">${n.emoji}</span>
        <div class="body">
          <div>${n.text}</div>
          ${n.skuLine ? `<div class="sku-line">${n.skuLine}</div>` : ''}
          ${n.distText ? `<div class="dist-hint">${n.distText}</div>` : ''}
          <div class="ttl-bar"><div class="ttl-fill" style="width:${Math.round(n.ttlRatio * 100)}%"></div></div>
        </div>
      `;
      if (this.handlers.onRespondNeed && !n.cooling) {
        el.addEventListener('click', () => this.handlers.onRespondNeed(n.id));
      }
      this.needList.appendChild(el);
    }
  }

  /** 距离过远提示（短暂显示由调用方节流）。 */
  setFarHint(text) {
    if (text) {
      this.farHint.textContent = text;
      this.farHint.style.display = 'block';
    } else {
      this.farHint.style.display = 'none';
    }
  }

  /** v3 手持物品提示（双手模型：{type:'item',skuId,qty}|{type:'box'}|{type:'cardboard',n}）。 */
  setCarry(carry) {
    if (!carry) {
      this.carryEl.style.display = 'none';
      return;
    }
    let text = '🤲 手上：';
    if (carry.type === 'box') {
      const sku = CONFIG.skus[carry.box.sku];
      text += `📦 快递箱（${sku ? `${sku.emoji} ${sku.name}` : ''}未拆封 ×${carry.box.qty}）`;
    } else if (carry.type === 'cardboard') {
      text += `🟫 折叠纸壳 ×${carry.n}（拿去库房入库）`;
    } else {
      const sku = CONFIG.skus[carry.skuId];
      text += `${sku ? `${sku.emoji} ${sku.name}` : carry.skuId} ×${carry.qty}`;
    }
    this.carryEl.textContent = text;
    this.carryEl.style.display = '';
  }

  /**
   * 刷新 HUD。
   * @param {object} gs GameState
   * @param {object|null} session DaySession（PREP/OPEN 均传入；非会话阶段传 null）
   */
  update(gs, session) {
    const sCfg = CONFIG.seasons;
    this.$('date').textContent =
      `📅 第 ${gs.day} 天 ${sCfg.emojis[gs.season]}${sCfg.names[gs.season]}季`
      + (gs.activityDaysLeft > 0 ? ' 🎉活动周' : '');
    this.$('cash').textContent = `💰 ${gs.cash}`;
    const repPct = Math.min(100, (gs.reputation / CONFIG.reputationGoal) * 100);
    this.repFill.style.width = `${repPct}%`;
    this.$('repnum').textContent = `${gs.reputation}/${CONFIG.reputationGoal}`;
    const pending = gs.today.satisfactionSum;
    this.$('reppending').textContent = pending !== 0 ? ` (${pending > 0 ? '+' : ''}${pending})` : '';
    this.$('foot').textContent = `👥 ${gs.today.footfall}`;

    // 时钟：PREP 显示备货倒计时；OPEN 显示营业倒计时；EVENING 显示整理提示
    if (session && gs.phase === 'PREP') {
      const remain = Math.max(0, Math.ceil(CONFIG.time.prepDuration - session.prepClock));
      this.$('clock').textContent = `📦 备货 ${remain}s`;
    } else if (session && gs.phase === 'OPEN') {
      const remain = Math.max(0, Math.ceil(CONFIG.openDuration - session.clock));
      this.$('clock').textContent = `⏱️ ${remain}s`;
    } else if (session && gs.phase === 'EVENING') {
      this.$('clock').textContent = '🧹 打烊整理';
    } else {
      this.$('clock').textContent = '';
    }

    // 倍速按钮：PREP 与 OPEN 均可用（A31）
    const speedBtn = this.$('speed');
    if (session && (gs.phase === 'OPEN' || gs.phase === 'PREP')) {
      speedBtn.disabled = false;
      speedBtn.innerHTML = `倍速 ×${session.speed} <span class="kbd">X</span>`;
    } else {
      speedBtn.disabled = true;
      speedBtn.innerHTML = '倍速 ×1 <span class="kbd">X</span>';
    }

    // 队列牌：仅 OPEN 且有队列时
    if (session && gs.phase === 'OPEN' && session.queue && session.queue.length > 0) {
      const n = session.queue.length;
      const cap = CONFIG.checkout.queueCapacity;
      this.queueBadge.style.display = 'block';
      this.queueBadge.classList.toggle('alert', n >= CONFIG.checkout.queueAlertLen);
      this.queueBadge.textContent = `🧍 ×${n}/${cap} 等待结账`;
    } else {
      this.queueBadge.style.display = 'none';
    }

    // PREP 状态条
    if (session && gs.phase === 'PREP') {
      const inTransit = gs.logistics.deliveries.filter((d) => d.state === 'IN_TRANSIT');
      const eta = inTransit.length > 0 ? Math.ceil(inTransit[0].eta) : null;
      const boxes = gs.logistics.boxes.length;
      const chips = [];
      if (eta !== null) chips.push(`🚚 货车 ETA ${eta}s`);
      if (boxes > 0) chips.push(`📦 门口箱子 ×${boxes}`);
      this.prepStatus.innerHTML = chips
        .map((t) => `<span class="prep-chip">${t}</span>`).join('');
      this.prepStatus.style.display = chips.length > 0 ? 'flex' : 'none';
    } else {
      this.prepStatus.style.display = 'none';
    }
  }
}
