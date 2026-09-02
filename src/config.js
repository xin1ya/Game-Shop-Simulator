/**
 * config.js — 全游戏唯一数值/文案配置源。
 *
 * 所有可调数值（商品价格、概率系数、季节热度表、事件表、升级表、
 * 常客定义、收藏定义、SKU 主表、物流 / 货架 / 结账 / 员工 / 气泡参数、
 * 文案）集中在 CONFIG 常量；sim 代码内禁止裸数字。
 * 本模块为纯数据，禁止 import DOM / window / three。
 *
 * v2 新增：skus(13) / categoryDefaultSku / logistics / shelf / checkout /
 * time / employees / needs / street / interaction / layout / shelfDisplay。
 *
 * ★ 交互距离唯一真值：CONFIG.firstPerson.interactRange = 2.5（裁决 8）。
 *   开箱 / 取货 / 货架补货 / 收银结账 / 气泡响应 五处一律读取该字段。
 *
 * @module config
 */

/**
 * 营业时长（秒）—— 单一真值（裁决 6：75 → 105）。
 * 被 CONFIG.openDuration 与 CONFIG.time.openDuration 共用，禁止再写字面量。
 */
const OPEN_DURATION = 105;

export const CONFIG = {
  version: 3,
  saveKey: 'bgs_save_v2',
  legacySaveKey: 'bgs_save_v1', // v1 存档 key（兼容读取 + 一次性迁移，读后保留不删）

  // ---- 时间与节奏 ----
  tick: 0.1,             // 逻辑步长（秒）
  openDuration: OPEN_DURATION, // 营业阶段时长（秒，裁决 6：75 → 105）
  maxOnScreen: 12,       // 同屏顾客上限

  // ---- 初始状态 ----
  initialCash: 4000,
  initialReputation: 0,
  reputationGoal: 100,
  initialInventory: { boardgame_low: 5, boardgame_high: 2, snacks: 8, merch: 3 },

  // ---- 商品（品类级，v1 遗留；玩法真值为 skus / skuPrices）----
  categoryOrder: ['boardgame_low', 'boardgame_high', 'snacks', 'merch'],
  products: {
    boardgame_low: { id: 'boardgame_low', name: '平价桌游', emoji: '🎲', cost: 45, guidePrice: 75, baseHeat: 0.85 },
    boardgame_high: { id: 'boardgame_high', name: '精品桌游', emoji: '👑', cost: 160, guidePrice: 280, baseHeat: 0.6 },
    snacks: { id: 'snacks', name: '饮品零食', emoji: '🧋', cost: 10, guidePrice: 18, baseHeat: 0.9 },
    merch: { id: 'merch', name: '周边商品', emoji: '🎁', cost: 30, guidePrice: 55, baseHeat: 0.7 },
  },

  // ---- SKU 主表（13 个，PRD §2.4.2 定稿；v3 增 slotCap = 每格堆叠上限（按实际体积））----
  skuOrder: [
    'cat_cafe', 'undercover', 'gem_trader',
    'civ_rise', 'deep_space', 'dragon_exp',
    'boba_tea', 'hand_brew', 'energy_bar',
    'dice_keychain', 'sticker_pack', 'metal_badge', 'dice_tower',
  ],
  skus: {
    cat_cafe: { id: 'cat_cafe', name: '猫咖物语', emoji: '🎲', cat: 'boardgame_low', cost: 38, guidePrice: 68, rarity: 'common', unlockRep: 0, slotCap: 4, appeal: { student: 1.3, casual: 1.1 } },
    undercover: { id: 'undercover', name: '谁是卧底·派对版', emoji: '🕵️', cat: 'boardgame_low', cost: 32, guidePrice: 55, rarity: 'common', unlockRep: 0, slotCap: 4, appeal: { student: 1.3, casual: 1.2 } },
    gem_trader: { id: 'gem_trader', name: '宝石商人·简装', emoji: '💎', cat: 'boardgame_low', cost: 52, guidePrice: 92, rarity: 'common', unlockRep: 0, slotCap: 4, appeal: { student: 1.1, core: 1.2 } },
    civ_rise: { id: 'civ_rise', name: '文明兴衰·典藏', emoji: '🏛️', cat: 'boardgame_high', cost: 175, guidePrice: 310, rarity: 'premium', unlockRep: 0, slotCap: 4, appeal: { core: 1.4, collector: 1.2 } },
    deep_space: { id: 'deep_space', name: '深空远征', emoji: '🚀', cat: 'boardgame_high', cost: 210, guidePrice: 380, rarity: 'premium', unlockRep: 0, slotCap: 4, appeal: { core: 1.4 } },
    dragon_exp: { id: 'dragon_exp', name: '龙与地下城·扩展包', emoji: '🐉', cat: 'boardgame_high', cost: 145, guidePrice: 250, rarity: 'common', unlockRep: 0, slotCap: 4, appeal: { core: 1.3, collector: 1.2 } },
    boba_tea: { id: 'boba_tea', name: '珍珠奶茶', emoji: '🧋', cat: 'snacks', cost: 8, guidePrice: 16, rarity: 'common', unlockRep: 0, slotCap: 4, appeal: { student: 1.3, casual: 1.2, core: 1.1 } },
    hand_brew: { id: 'hand_brew', name: '手冲咖啡', emoji: '☕', cat: 'snacks', cost: 12, guidePrice: 22, rarity: 'common', unlockRep: 0, slotCap: 4, appeal: { core: 1.3, casual: 1.1 } },
    energy_bar: { id: 'energy_bar', name: '桌游夜能量棒', emoji: '🍫', cat: 'snacks', cost: 14, guidePrice: 26, rarity: 'common', unlockRep: 0, slotCap: 6, appeal: { student: 1.3, core: 1.2 } },
    dice_keychain: { id: 'dice_keychain', name: '骰子钥匙扣', emoji: '🔑', cat: 'merch', cost: 18, guidePrice: 34, rarity: 'common', unlockRep: 0, slotCap: 9, appeal: { casual: 1.2, student: 1.1 } },
    sticker_pack: { id: 'sticker_pack', name: '主题贴纸包', emoji: '🎨', cat: 'merch', cost: 12, guidePrice: 24, rarity: 'common', unlockRep: 0, slotCap: 9, appeal: { student: 1.3, casual: 1.2 } },
    metal_badge: { id: 'metal_badge', name: '金属徽章·限定', emoji: '🏅', cat: 'merch', cost: 55, guidePrice: 98, rarity: 'premium', unlockRep: 30, slotCap: 9, appeal: { collector: 1.6, core: 1.2 } },
    dice_tower: { id: 'dice_tower', name: '限定骰塔', emoji: '🗼', cat: 'merch', cost: 120, guidePrice: 210, rarity: 'limited', unlockRep: 55, slotCap: 9, appeal: { collector: 1.6 } },
  },
  // 存档迁移 v1→v2：旧品类库存归入该 SKU
  categoryDefaultSku: {
    boardgame_low: 'cat_cafe',
    boardgame_high: 'civ_rise',
    snacks: 'boba_tea',
    merch: 'dice_keychain',
  },
  skuRarityNames: { common: '普通', premium: '精选', limited: '限定' },

  // ---- 顾客类型 ----
  customerTypeOrder: ['student', 'core', 'collector', 'casual'],
  customerTypes: {
    student: {
      id: 'student', name: '学生党', emoji: '🎒',
      pref: { boardgame_low: 0.5, boardgame_high: 0.1, snacks: 0.3, merch: 0.1 },
      budget: [20, 80], patience: [30, 50],
    },
    core: {
      id: 'core', name: '核心玩家', emoji: '🎧',
      pref: { boardgame_low: 0.3, boardgame_high: 0.5, snacks: 0.1, merch: 0.1 },
      budget: [100, 300], patience: [40, 60],
    },
    collector: {
      id: 'collector', name: '收藏家', emoji: '🎩',
      pref: { boardgame_low: 0.05, boardgame_high: 0.3, snacks: 0.05, merch: 0.6 },
      budget: [150, 500], patience: [35, 55],
    },
    casual: {
      id: 'casual', name: '路人', emoji: '🚶',
      pref: { boardgame_low: 0.3, boardgame_high: 0.1, snacks: 0.4, merch: 0.2 },
      budget: [30, 100], patience: [30, 45],
    },
  },
  // 基础生成权重；高声望会按比例提升 core/collector 权重
  spawnWeights: { student: 0.35, core: 0.2, collector: 0.15, casual: 0.3 },
  repSpawnBoostDivisor: 50, // 高消费顾客权重倍率 = 1 + reputation / 50

  // ---- 经济公式系数 ----
  economy: {
    pBase: 0.45,            // 购买倾向基数（QA R1：0.55→0.45，压转化率拉长通关）
    pPrefScale: 0.35,       // 偏好加成系数
    priceDownFactor: 0.4,   // 低于指导价时每 -100% 概率 +0.4
    priceUpFactor: 0.8,     // 高于指导价时每 +100% 概率 -0.8（每 10% → -8%）
    decorStep: 0.05,        // 装修每级满意度加成
    expBuyBonus: 1.2,       // 体验后二次购买判定加成
    budgetPenalty: 0.15,    // 超预算时概率倍率
    pMin: 0.02,
    pMax: 0.97,
    priceClampMin: 0.5,     // 调价下限（×指导价）
    priceClampMax: 1.5,     // 调价上限（×指导价）
    cheapThreshold: 1.1,    // 价格 ≤ 指导价 × 1.1 视为实惠
  },

  // ---- 满意度 → 声望（QA Round 1 调参：购买 +2 → +1，拉长通关至 18~25 天） ----
  satisfaction: {
    buyCheap: 1,   // 购买且价格实惠
    buyPricey: 1,  // 购买但偏贵
    experienceOk: 0, // 体验满意未购买
    angry: -1,     // 耐心耗尽 / 买不到怒流失
  },

  // ---- 客流 ----
  footfall: {
    base: 5,               // 裁决 9 唯一旋钮：2026-09 数值复评定稿 7→5（repDivisor 11→10 收方差），bot 18-26 天进带
    repDivisor: 10,        // 2026-09 数值复评：11→10 增强声望正反馈收敛种子方差（配合 base 5 全部进带）
    activityMult: 1.25,    // 活动周加成
    legendMult: 1.1,       // 持有任一传说周边加成
  },

  // ---- 租金 ----
  rent: { intervalDays: 7, byLevel: [400, 600, 800] }, // 按最高升级线等级 1/2/3

  // ---- 库存 ----
  inventory: { capBase: 10, capPerShelfLevel: 5 }, // 每品类上限 = 10 + 5×(shelfLevel-1)

  // ---- 体验区 ----
  experience: {
    slotBase: 1,           // 体验位 = 1 + experienceLevel
    feeBase: 8,            // 体验费 = 8 + 4×level
    feePerLevel: 4,
    durationMin: 15,
    durationMax: 30,
  },

  // ---- 店铺扩张（2026-09 实现：三级独立购买项，解锁真实区域/上限） ----
  expansion: {
    levels: [
      { id: 'stockroom_plus', name: '库房扩容', emoji: '📦', cost: 2000, desc: '纸板堆叠上限 50 → 100' },
      { id: 'wing_right', name: '收购右邻铺', emoji: '🏪', cost: 6000, desc: '打通右墙，翼房体验区 +2 体验位' },
      { id: 'loft', name: '向上加层', emoji: '🏗️', cost: 12000, desc: '阁楼（名店象征），声望 +10' },
    ],
  },

  // ---- 升级 ----
  upgrades: {
    lines: ['experience', 'shelf', 'decor'],
    names: { experience: '体验区扩建', shelf: '货架扩容', decor: '装修档次' },
    emojis: { experience: '🛋️', shelf: '🗄️', decor: '✨' },
    maxLevel: 3,
    costs: { 2: 1500, 3: 3500 }, // 1→2 级 / 2→3 级
  },

  // ---- 顾客 AI 行为参数（秒 / 概率） ----
  customer: {
    browseMin: 3,
    browseMax: 6,
    walkEnter: 2,
    walkToExp: 1.5,
    walkToCheckout: 1.5,
    walkLeave: 2.5,
    payTime: 2,             // ★ 已弃用：真值为 CONFIG.checkout.playerPayTime（保留仅为 v1 兼容）
    expTryChance: 0.5,      // 偏好未满足时尝试体验区概率
    leaveAngryChance: 0.88, // QA R1：0.6→0.88，买不到时怒流失概率（声望流失主力）
    walkSpeed: 1.8,         // 顾客店内移动速度（单位/秒，仅用于 sim 侧坐标与 2.5 距离闸门）
  },

  // ---- 季节（每 10 游戏日轮换；季首日起 3 天活动周） ----
  seasons: {
    order: ['spring', 'summer', 'autumn', 'winter'],
    names: { spring: '春', summer: '夏', autumn: '秋', winter: '冬' },
    emojis: { spring: '🌸', summer: '☀️', autumn: '🍂', winter: '❄️' },
    lengthDays: 10,
    activityDays: 3,
    heat: {
      spring: { boardgame_low: 0.3, boardgame_high: -0.3, snacks: 0, merch: 0.3 },
      summer: { boardgame_low: 0, boardgame_high: 0, snacks: 0.3, merch: -0.3 },
      autumn: { boardgame_low: 0, boardgame_high: 0.3, snacks: -0.3, merch: 0 },
      winter: { boardgame_low: -0.3, boardgame_high: 0.3, snacks: 0.3, merch: 0 },
    },
  },

  // ---- 随机事件（开门时按权重抽取；none 不占事件槽） ----
  events: [
    { id: 'influencer', name: '网红探店', emoji: '📸', desc: '一位探店博主今天要来！预计客流 +90%。', weight: 8, footfallMult: 1.9 },
    { id: 'market', name: '街区集市', emoji: '🎪', desc: '楼下集市带来不少顺路客人，客流 +50%。', weight: 12, footfallMult: 1.5 },
    { id: 'quiet', name: '冷清雨天', emoji: '🌧️', desc: '外面下起小雨，今天客流只有六成。', weight: 12, footfallMult: 0.6 },
    { id: 'delivery_delay', name: '快递延迟', emoji: '📦', desc: '物流爆仓，今天的货车会晚到一会儿（ETA 延长）。', weight: 8, missRatio: 0.5 },
    { id: 'regular_praise', name: '口碑相传', emoji: '💬', desc: '老主顾在论坛上夸了你的店，声望 +1。', weight: 10, repBonus: 1 },
  ],
  eventNoneWeight: 50,

  // ---- 常客（声望达到门槛解锁首次到访；到访且满意推进剧情） ----
  regulars: [
    {
      id: 'xiaoman', name: '小满', type: 'student', unlockRep: 15, visitChance: 0.5,
      reward: { cash: 300, rep: 0 },
      stories: [
        '【小满】“老板，期末周终于结束了……我想找一款能和室友一起玩的桌游，预算不多，有推荐吗？”',
        '【小满】“上次那款游戏，我们宿舍玩了一整晚！今天我把朋友也带来了。”',
        '【小满】“我考上研究生啦！离开前想再来一次。这点心意你收下，谢谢这家店陪我度过最难的日子。”',
      ],
    },
    {
      id: 'laozhou', name: '老周', type: 'core', unlockRep: 35, visitChance: 0.5,
      reward: { cash: 0, rep: 4 },
      stories: [
        '【老周】“嗯……你这儿有《文明兴衰》的扩展吗？我找遍全城了。”（他推了推眼镜）',
        '【老周】“你进货的眼光不错。我组了个硬核局，每周四来你体验区开桌，没问题吧？”',
        '【老周】“这家店有我年轻时的影子。我把你推荐给桌游圈的朋友们——名店，实至名归。”',
      ],
    },
    {
      id: 'baili', name: '白梨', type: 'collector', unlockRep: 60, visitChance: 0.5,
      reward: { cash: 800, rep: 0 },
      stories: [
        '【白梨】“打扰了……听说这里有限定周边？我的收藏柜，还空着一格。”',
        '【白梨】“这枚徽章我找了三座城市。你的店，总有意想不到的惊喜。”',
        '【白梨】“我的收藏柜终于满了。作为谢礼请收下这个——愿你的小店成为传说。”',
      ],
    },
  ],

  // ---- 周边收藏（merch 进货时按单位独立 roll 掉落） ----
  collectibles: [
    { id: 'dice_keychain', name: '骰子钥匙扣', rarity: 'normal' },
    { id: 'sticker_pack', name: '主题贴纸', rarity: 'normal' },
    { id: 'card_sleeve', name: '卡牌卡套', rarity: 'normal' },
    { id: 'metal_badge', name: '金属徽章', rarity: 'rare' },
    { id: 'dice_tower', name: '限定骰塔', rarity: 'rare' },
    { id: 'signed_poster', name: '签名海报', rarity: 'rare' },
    { id: 'golden_dice', name: '黄金骰子', rarity: 'legendary' },
    { id: 'first_edition', name: '绝版初版桌游', rarity: 'legendary' },
  ],
  drops: {
    legendaryChance: 0.015,
    rareChance: 0.06,
    normalChance: 0.2,
    rareRepBonus: 1, // QA R1：2→1，获得稀有周边时声望 +1
  },
  rarityNames: { normal: '普通', rare: '稀有', legendary: '传说' },
  rarityEmojis: { normal: '⚪', rare: '🔵', legendary: '🟡' },

  // ======================= 以下为 v2 增量 =======================

  // ---- 物流（PRD §2.7）----
  logistics: {
    orderStep: 4,             // 下单步进（件）= 一箱
    boxCapacity: 4,           // 每箱件数 = restockPerAction = stackCapL1，一箱正好补满一格
    truckEta: 8,              // 下单 → 货车到店（秒，PREP 阶段计时）
    delayEventExtra: 12,      // 事件「快递延迟」额外延迟（秒）
    unboxTime: 1.5,           // 开箱耗时（秒）
    pickTime: 0.6,            // 取货耗时（秒，一次取空整箱进后仓）
    restockTime: 4.0,         // 后仓 → 货架 补货耗时（秒 / 次）—— 仓管员 ×0.375 → 1.5s
    restockPerAction: 4,      // 一次补货动作补的件数
    maxBoxesAtDoor: 8,        // 门口箱子堆积上限
    doorSlowMult: 0.7,        // 超上限时经过门口的速度倍率
    autoStockTime: 15,        // 「一键理货」固定耗时（秒）
    autoStockEfficiency: 0.6, // 「一键理货」效率（相对手动）
    autoStockDefaultOn: false, // ★ 虚拟搬运工默认关闭（UI）；headless 测试显式置 true
    // v3 纸箱物理（需求 8）：箱体半宽 / 重力加速度 / 落地反弹无（落定即稳）
    boxHalf: 0.28,            // 箱体半宽（0.56 见方）
    boxGravity: 6.0,          // 重力（单位/秒²）
    boxDropHeight: 1.4,       // 卸箱初始高度（从货车厢落出）
  },

  // ---- 货架（PRD §2.7）----
  shelf: {
    slotsPerShelf: 9,           // 每货架格位（3 层 × 3 列）
    stackCapByLevel: [4, 6, 8], // 货架升级 1/2/3 级 → 每格堆叠上限
    displayCap: 12,             // shelf.js 可见度分母：陈列 ≥12 件时 9 格全显示
    minDisplayedSku: 4,         // 陈列 SKU 数阈值
    sparseDisplayMult: 0.85,    // 陈列 SKU < 4 时购买概率倍率
    multiSlotBonus: 0.15,       // 同 SKU 每多占 1 格的选中权重加成
    multiSlotBonusCap: 1.5,     // 权重加成上限
    substituteChance: 0.45,     // 目标 SKU 无陈列时接受同品类替代品的概率
    startEmpty: true,           // A11：新开局货架为空
    startBackroom: true,        // U1：初始 18 件归入后仓（不劣化、且天然教学）
  },

  // ---- v3 桌游租用（需求 5：boardgame 品类可租可买） ----
  rental: {
    feeRatio: 0.12,        // 租金 = 售价 × 比率（最低 minFee）
    minFee: 5,
    // 各顾客类型选择「租用」的概率（命中购买判定后二次分流）
    rentChanceByType: { student: 0.35, core: 0.25, collector: 0.08, casual: 0.18 },
  },

  // ---- 收银队列（PRD §2.7）----
  checkout: {
    queueCapacity: 5,           // 队列容量（第 6 位不进队，平静离店，满意度 0）
    playerPayTime: 2.0,         // 玩家手动结账（秒/位）—— 沿用旧 payTime
    queuePatienceHead: 20,      // 队首排队耐心（秒）
    queuePatienceTail: 14,      // 第 2 位起排队耐心（秒）
    parallelSlots: 1,           // 默认并行收银位
    cashierParallelSlots: 2,    // 收银员在岗时（消费 B02）
    queueAlertLen: 3,           // 「结账 💳」气泡触发：队列长度阈值
    queueAlertWait: 6,          // 「结账 💳」气泡触发：队首等待秒数阈值

    // ⬇️ A33 自助结账兜底 —— ★ 主理人已批准（P0，🔒 锁死：禁止上调该秒数）
    // 触发：队首等待 ≥ 14s（= queuePatienceHead × 0.7，留 6s 缓冲）且收银员不在岗
    // 正常手动 2.0s/位时队首等待约 2~4s，永远不会触发（有测试守卫）
    selfServiceAfter: 14,       // 队首等待超过该秒数 → 转自助扫码（禁止上调）
    selfServicePayTime: 5.0,    // 自助结账耗时（秒）
    selfServiceSatisfaction: 0, // 自助结账满意度（不奖不罚；对比手动 +1、怒走 −1）
  },

  // ---- 阶段时长与倍速（PRD §2.7 / 裁决 5·6）----
  time: {
    prepDuration: 90,           // PREP 备货阶段时长（秒）
    openDuration: OPEN_DURATION, // 营业时长（秒）
    speedOptions: [1, 2],       // PREP 与 OPEN 均支持 2 倍速（A31）
  },

  // ---- 员工（PRD §3.5）----
  employees: {
    maxCount: 4,
    roleOrder: ['cashier', 'guide', 'host', 'stocker'],
    roles: {
      cashier: { name: '收银员', emoji: '💵', signBonus: 250, dailyWage: 45, payTimeMult: 0.6, parallelSlots: 2 },
      guide: { name: '导购员', emoji: '🙋', signBonus: 300, dailyWage: 55, respondInterval: 12, respondSuccess: 0.8 },
      host: { name: '体验官', emoji: '🎲', signBonus: 350, dailyWage: 70, expDurationMult: 0.8, expBuyBonus: 1.1 },
      stocker: { name: '仓管员', emoji: '📦', signBonus: 250, dailyWage: 50, restockTimeMult: 0.375, autoRestockPerDay: 1 },
    },
    stars: { effect: [1.0, 1.25, 1.5], wage: [1.0, 1.4, 1.9], weights: [0.55, 0.33, 0.12] },
    fatigue: { workGain: 25, restRecover: 40, penaltyAt: 70, penaltyMult: 0.7, severeAt: 90, severeMult: 0.5 },
    quit: { normalChance: 0.02, severeChance: 0.20, unpaidChance: 0.35 },
    severanceDays: 1,           // 解雇遣散费 = 1 天日薪
    namePool: ['小林', '阿哲', '佳明', '思思', '老陈', '阿岚', '小柯', '圆圆', '大熊', '阿琪'],
  },

  // ---- 顾客需求气泡（PRD §3.5）----
  needs: {
    scanInterval: 0.5,       // 扫描间隔（秒）
    maxOnScreen: 3,          // 同屏气泡上限
    playerCooldown: 3,       // 玩家全局响应冷却（秒）
    repeatCooldown: 6,       // 同一顾客同类型冷却（秒）
    // ⚠️ 裁决 8：第一人称响应距离一律读 CONFIG.firstPerson.interactRange，
    //    此处**不再**定义 fpRespondRange，防止两处 2.5 漂移。
    types: {
      findItem: { emoji: '❓', label: '找货', priority: 3, ttl: 8, satisfaction: 1, buyMult: 1.3 },
      complain: { emoji: '😠', label: '投诉', priority: 5, ttl: 5, satisfaction: 0, patienceRefill: 0.6, cost: 5 },
      checkout: { emoji: '💳', label: '结账', priority: 4, ttl: 6, satisfaction: 1, playerPayTime: 1.5, trigger: { queueLen: 3, waitTime: 6 } },
      explain: { emoji: '💬', label: '讲解', priority: 2, ttl: 8, patienceBonus: 8, trigger: { waitTime: 3 } },
      recommend: { emoji: '⭐', label: '推荐', priority: 1, ttl: 5, rerollPurchase: true },
    },
    kindOrder: ['recommend', 'explain', 'findItem', 'checkout', 'complain'], // 紧急度升序
  },

  // ---- 街道（场景工程师 T07 定稿值；street.js 降级 fallback 与本表一致）----
  street: {
    sidewalkW: 2.25,         // 本店侧人行道宽（z∈[5,7.25]；2026-09 由原 1.5 再 ×1.5）
    blockZ: 16.7,            // 街道可行走外沿（对面人行道 z∈[14.75,17] 内 0.3）
    farSidewalkW: 2.25,      // 对面人行道宽度（与本店侧等宽；对面建筑立面贴 17）
    truckStop: { x: 8.5, z: 9.5 },     // 货车停靠点（车道上，不占人行道；与门口箱落点分离）
    facadeZ: 4.8,            // 店面装饰所在 z
    sidewalkLane: { z: 6.125 },        // 人行道行走线（z∈[5,7.25] 中线）
    pedestrians: { min: 4, max: 8, speed: 0.9 },
    doorBoxSlots: [          // （旧 8 槽，保留为缺省回退；实际收货用 dropZone 列式堆叠）
      { x: 4.4, z: 5.4 }, { x: 5.2, z: 5.4 }, { x: 6.0, z: 5.4 }, { x: 6.8, z: 5.4 },
      { x: 4.0, z: 5.9 }, { x: 4.8, z: 5.9 }, { x: 5.6, z: 5.9 }, { x: 6.4, z: 5.9 },
    ],
    // ★ 收货堆叠区（2026-09）：门洞右侧 3×3 列 × 3 层（3³=27 容量），平铺优先再叠层。
    // 位置约束：x≥7.2，不挡店铺入口（门洞 x∈[4.9,6.7] 走廊保持净空）；
    // z ≤ 6.2+箱半宽 0.28 = 6.48，在人行道内（外沿 7.25）。
    dropZone: {
      layers: 3,
      columns: [
        { x: 7.2, z: 5.3 }, { x: 7.9, z: 5.3 }, { x: 8.6, z: 5.3 },
        { x: 7.2, z: 5.75 }, { x: 7.9, z: 5.75 }, { x: 8.6, z: 5.75 },
        { x: 7.2, z: 6.2 }, { x: 7.9, z: 6.2 }, { x: 8.6, z: 6.2 },
      ],
    },
    boxSlowThreshold: 8,     // 门口箱子数超过该值 → 玩家经过门口减速（firstPerson 消费）
    // —— 附加（sim / 视觉共用）——
    road: { x: [-12, 12], z: [7.25, 14.75] },
    facade: { z: [5, 7], name: '桌游店' },
    facadeLine: 5.05,      // 建筑红线：临街主体立面统一 z=5.05（本店前墙外侧）
    roadFarLine: 14.75,    // 道路外边线 = 对面人行道内沿（马路 z∈[7.25,14.75]，宽 7.5）
  },

  // ---- 玩家交互（PRD §5.4 / 裁决 8）----
  interaction: {
    aimConeCos: 0.35,      // 第一人称准星朝向锥阈值（dot ≥ 该值）
    holdGraceSec: 0.15,    // 松手容忍（秒；UI 可选）
    kinds: ['unbox', 'pick', 'restock', 'pay', 'respond',
      'stash', 'takeout', 'flatten', 'trash', 'recycle',
      'carryBox', 'placeBox', 'doorToggle'], // 2026-09 新增 3 类（抱箱/放箱/开关门）
    labels: {
      unbox: '开箱', pick: '取货', restock: '上架', pay: '结账', respond: '回应',
      stash: '入库', takeout: '取货', flatten: '折叠', trash: '丢弃', recycle: '卖纸板',
      carryBox: '抱起整箱', placeBox: '放下箱子', doorOpen: '开门', doorClose: '关门',
    },
    // v3 新交互耗时（秒）
    stashTime: 1.0,        // 手上货物入后仓
    flattenTime: 0.8,      // 折叠空箱 → 纸板
    trashTime: 0.5,        // 垃圾桶丢弃全部空箱
    recycleTime: 0.8,      // 回收商人售卖纸板
    // ★ 即时交互（2026-09 玩家反馈）：取消按住进度条——beginHold 校验通过即完成。
    // 结账无手动计时通道（仅找零小游戏面板，见 main.js openChangePanel）。
    instantHold: true,
  },

  // ---- v3 库房/废品（需求 9/10）----
  stockroom: {
    cardboardPrice: 2,     // 纸板回收单价（金币/张）
    cardboardCap: 50,      // 纸板堆叠上限（库房容量）
    cardboardCarryCap: 10, // 手上折叠纸壳一次最多拿 10 张（2026-09 反馈）
  },

  // ---- 店内布局锚点（sim 侧坐标真值；scene/shop.js 常量请与之对齐）----
  layout: {
    door: { x: 5.8, z: 4.4 },
    exit: { x: 5.8, z: 5.8 },
    browseCenter: { x: 0, z: 0.4 },
    // v3：货架去品类化 —— 浏览/补货锚点按货架序号（0~3，x 与 shop.js SHELF_X 对齐）
    shelfAnchors: [
      { x: -4.8, z: -2.1 }, { x: -1.6, z: -2.1 },
      { x: 1.6, z: -2.1 }, { x: 4.8, z: -2.1 },
    ],
    experience: [
      { x: 3.6, z: -0.6 }, { x: 5.2, z: -0.6 }, { x: 3.6, z: 1.6 }, { x: 5.2, z: 1.6 },
      // 收购右邻铺（wing_right）翼房体验位
      { x: 8.6, z: -0.6 }, { x: 10.2, z: -0.6 },
    ],
    checkout: { x: -4.6, z: 2.6 },
    queue: [
      { x: -4.6, z: 1.7 }, { x: -4.6, z: 1.15 },
      { x: -4.6, z: 0.6 }, { x: -4.6, z: 0.05 }, { x: -4.6, z: -0.5 },
    ],
    // v3 库房（需求 10）：左墙（x=-6.9）开门洞 z∈[-1.6,-0.4]，库房 x∈[-10.4,-7.2] z∈[-4.2,2.2]
    stockroom: { x: -8.6, z: -1 },      // 库房交互锚点（入库/取货）
    trashBin: { x: -9.75, z: 1.55 },    // 垃圾桶（丢空箱）
    recyclerPoint: { x: 7.6, z: 6.3 },  // 废品回收商人站位（每周账单日来店门口）
    staffDoor: { x: -6.9, z: -1 },      // 库房门（手动开关交互点）
  },

  // ---- 货架陈列（scene/shelf.js 消费）----
  shelfDisplay: {
    maxVisiblePerShelf: 9,   // = CONFIG.shelf.slotsPerShelf
    displayCap: 12,          // = CONFIG.shelf.displayCap
  },

  // ---- 第一人称视角（营业阶段店内漫游）----
  firstPerson: {
    fov: 68,               // 透视相机视场角（度）
    eyeHeight: 1.55,       // 视平线高度（世界单位，店铺比例尺）
    moveSpeed: 2.4,        // 行走速度（单位/秒）
    sprintMult: 1.7,       // Shift 加速倍率
    mouseSensitivity: 0.0023, // 鼠标灵敏度（弧度/像素）
    pitchClampDeg: 80,     // 俯仰钳制 ±80°
    playerRadius: 0.28,    // 碰撞半径
    bobAmplitude: 0.028,   // 头部摆动幅度（要小）
    bobFrequency: 8.5,     // 头部摆动荡频（弧度/秒）
    interactRange: 2.5,    // ★ 五类交互的唯一距离真值（裁决 8）
    interactRangeIso: 3.2, // 等距俯瞰（操纵店长）交互距离：略宽于 fp，不再无限隔空
    spawn: { x: 0, z: 3.6, yaw: 0 }, // 出生点（面朝店内 -z 方向）
    // 可行走范围（中心点钳制；v3 库房开放 minX=-9.95；2026-09 全街 maxX=12 人行道全宽）
    bounds: { minX: -9.95, maxX: 12.0, minZ: -4.0, maxZ: 4.55 },
    // 静态障碍 AABB（中心 + 半宽，与 shop.js 实建几何逐一核对——半宽 = 视觉 AABB 实测半宽，
    // 玩家半径由 slideMove 另行膨胀，此处不含半径余量）。
    // 货架实测：层板半宽 0.75 / 半深 0.375（立柱 ±0.71 被层板包住）；升级放大由
    // buildObstacles 按 shelfLevel × shelfVisualScale 处理（z 不放大）。
    shelfObstacles: [
      { x: -4.8, z: -3.2, hx: 0.75, hz: 0.375 },
      { x: -1.6, z: -3.2, hx: 0.75, hz: 0.375 },
      { x: 1.6, z: -3.2, hx: 0.75, hz: 0.375 },
      { x: 4.8, z: -3.2, hx: 0.75, hz: 0.375 },
    ],
    // 体验桌（含椅子）：实测 x ±1.225（椅子 ±1.0+0.225）/ z ±0.75（圆桌盘半径）
    tableObstacles: [
      { x: 3.6, z: -0.6, hx: 1.23, hz: 0.75 },
      { x: 5.2, z: -0.6, hx: 1.23, hz: 0.75 },
      { x: 3.6, z: 1.6, hx: 1.23, hz: 0.75 },
      { x: 5.2, z: 1.6, hx: 1.23, hz: 0.75 },
      // 翼房体验桌（wing_right 收购后启用）
      { x: 8.6, z: -0.6, hx: 1.23, hz: 0.75 },
      { x: 10.2, z: -0.6, hx: 1.23, hz: 0.75 },
    ],
    // 收银台实测：柜台 2.0×0.8 → x ±1.0 / z ±0.4（收银机 x∈[0.15,0.65] 被包住）
    checkoutObstacle: { x: -4.6, z: 2.6, hx: 1.0, hz: 0.4 },
    // 盆栽：第 1 个常驻，第 2 个装修 ≥2 级才存在。
    // 实测半径 = 叶球 0.4（y 0.3~1.1，在玩家身体区间内；花盆仅 0.28）。
    plantObstacles: [
      { x: -6.2, z: -4.2, hx: 0.4, hz: 0.4 },
      { x: 6.3, z: -4.2, hx: 0.4, hz: 0.4 },
    ],
    // ★ 临街墙壁 + 窗户碰撞箱：frontWall z=4.9，门洞开在
    // x∈[4.9, 6.7]（DOOR_POS 5.8 ± 0.9）。墙视觉半深 0.15（z∈[4.75,5.05]），
    // 但 hz 锁死 0.1 → maxZ=5.0，恰不超 B4 红线（室外 z>5 零障碍，测试守卫）；
    // 半径膨胀后有效边界 [4.52,5.28] 完整包住墙体，视觉无可见穿插。
    frontWallObstacles: [
      { x: -1.05, z: 4.9, hx: 5.95, hz: 0.1 }, // 门洞左段（含窗）：x∈[-7, 4.9]
      { x: 6.85, z: 4.9, hx: 0.15, hz: 0.1 },  // 门洞右段：x∈[6.7, 7.0]
    ],
    // ★ v3 库房（需求 10）：左墙（x=-6.9）开门洞 z∈[-1.6,-0.4]（员工通道门变真实通道）。
    // bounds.minX 放宽到 -9.95 后，左墙必须显式成障碍（此前由 bounds 隐含阻挡）。
    leftWallObstacles: [
      { x: -6.9, z: -3.3, hx: 0.15, hz: 1.7 }, // z∈[-5,-1.6]（门洞以北）
      { x: -6.9, z: 2.3, hx: 0.15, hz: 2.7 },  // z∈[-0.4,5]（门洞以南）
    ],
    // 库房实体障碍：三面外墙 + 垃圾桶（2026-09 取消置物架，库房直接放箱子；均 x<-7）
    stockroomObstacles: [
      { x: -10.4, z: -1, hx: 0.15, hz: 3.35 },   // 西墙
      { x: -8.75, z: -4.2, hx: 1.8, hz: 0.15 },  // 北墙
      { x: -8.75, z: 2.2, hx: 1.8, hz: 0.15 },   // 南墙
      { x: -9.75, z: 1.55, hx: 0.28, hz: 0.28 }, // 垃圾桶
    ],
    // bounds.minX 放宽后，街道左角障碍（咖啡馆/行道树）x<-7 显式存在
    streetObstacles: [
      { x: -10.5, z: 3.65, hx: 2.75, hz: 1.45 },  // 邻铺「咖啡馆」（红线后主体，不占人行道）
      { x: -7.2, z: 7.5, hx: 0.2, hz: 0.2 },     // 左侧行道树树干
      { x: 7.0, z: 10.2, hx: 0.18, hz: 0.18 },   // 红绿灯杆（斑马线东侧）
      { x: 10.8, z: 3.65, hx: 2.5, hz: 1.4 },    // 邻铺「花店」（红线后主体，不占人行道）
    ],
    // ★ 店内右墙（x=6.9，z -5.2~5.0）：maxX 扩到 12 后必须显式阻挡（收购翼房时被分段替代）
    shopRightWallObstacle: { x: 6.9, z: -0.1, hx: 0.15, hz: 5.1 },
    // ★ 收购右邻铺（wing_right）：右墙开门洞 z∈[-1.6,-0.4] 常开 + 翼房三面墙
    rightWallObstacles: [
      { x: 6.9, z: -3.3, hx: 0.15, hz: 1.7 },  // z∈[-5,-1.6]
      { x: 6.9, z: 2.3, hx: 0.15, hz: 2.7 },   // z∈[-0.4,5]
    ],
    wingObstacles: [
      { x: 11.6, z: -1, hx: 0.15, hz: 3.35 },   // 翼房东墙
      { x: 9.35, z: -4.2, hx: 2.4, hz: 0.15 },  // 翼房北墙
      { x: 9.35, z: 2.2, hx: 2.4, hz: 0.15 },   // 翼房南墙
    ],
    // 远侧立面墙（街道步行外沿 z≈14；白名单障碍）
    farWallObstacle: { x: 0, z: 17.05, hx: 24, hz: 0.15 },
  },

  // ---- 文案模板（{xxx} 为占位符，由代码替换） ----
  strings: {
    activityWeek: '🎉 活动周开启！本季前 {days} 天客流与收益加成 ×1.25。',
    seasonBanner: '{emoji} 季节更替：现在是{name}季。',
    unlockRegular: '✨ 新常客「{name}」听闻你的店，开始光顾了！',
    dropAnnounce: '{emoji} 进货彩蛋：获得{rarity}周边「{name}」！',
    regularReward: '🎁 「{name}」的故事完结了！获得奖励：{reward}',
    victoryText: '🏆 声望达到 100！你的店成为了远近闻名的「街区名店」！',
    gameoverText: '💸 账单日资金为负，店铺资金链断裂，不得不关门大吉……',
    eventTitle: '📢 今日事件',
    fpEnterHint: '🖱️ 点击画面进入第一人称（WASD 移动 · Shift 加速 · V 切换俯瞰 · ESC 退出）',
    fpIsoHint: '🗺️ 全局俯瞰模式（按 V 返回第一人称）',
    prepStart: '🚚 货车已出发，ETA {eta} 秒。趁这段时间把门口的箱子搬进后仓吧！',
    prepNoTruckToday: '📦 今晨没有货车到店。今早订的货今晚打烊时送达——理货上架现有库存吧！',
    openEarly: '🔔 提前开门！没搬完的箱子会留在营业中继续处理。',
    staffHired: '🤝 「{name}」（{role} {stars}★）已入职，签约金 -{bonus}。',
    staffFired: '👋 「{name}」已离职，遣散费 -{cost}。',
    staffQuit: '😢 「{name}」决定离开，明天起不再到岗（签约金沉没）。',
    selfServiceDone: '📱 一位等太久的顾客选择了自助扫码结账。',
    recyclerArrive: '♻️ 回收商人今天路过店门口！库房里的纸板可以卖给他（门口 ♻️ 处）。',
    recycleDone: '♻️ 纸板全部售出，收入 💰 {income}。',
    stashDone: '📦 手上货物已入库房。',
    eveningTruck: '🚚 今早订的货送到了！货车正在门口卸箱，搬完记得处理空箱。',
    eveningHint: '🧹 打烊整理：可以理货上架 / 店内归置 / 商城下单（明早到）。准备好后点「🌙 打烊休息」。',
  },
};
