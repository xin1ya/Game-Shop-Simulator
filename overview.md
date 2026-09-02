# 交付总览：3D 赛璐璐桌游店模拟经营游戏（Web 原型）

## TL;DR
完整走完「产品经理 → 架构师 → 工程师 → QA」标准 SOP，交付一款浏览器可玩的 3D 赛璐璐桌游店经营游戏；历经四次增量（第一人称 → 场景/物流/员工 → v3 自由货架/商城次日达/库房/找零租用 → 全街/店铺扩张/人物 GLB）后 **175/175 测试全绿，五种子通关 18-26 天全部进带（18-28 目标带）**（bot 完美上限，低于 18-28 目标带——真人远慢于 bot，保留观察）。

## 交付状态
| 阶段 | 产出 | 状态 |
|------|------|------|
| PRD | docs/PRD.md（19 条需求分级 + 数值框架） | ✅ |
| 架构 | docs/ARCHITECTURE.md + 3 份 Mermaid 图 | ✅ |
| 编码 | sim/scene/ui 三层 + Blender GLB 资产管线（tools/assetgen） | ✅ IS_PASS |
| QA | 175 例测试（含边界负向与布局守卫）、浏览器 e2e 截图终验 | ✅ 终验通过 |

## 玩法覆盖（对照原始需求）
- 核心循环：晨间决策（进货/定价/升级）→ 75 秒实时营业 → 日结 → 每 7 天租金账单
- 经济系统：定价 ±50% 影响购买概率、破产/胜利（声望 100）双结局、自由经营模式
- 顾客 AI：4 类顾客 × 8 状态状态机（浏览/体验/排队/结账/流失），点击可查看信息卡
- 常客故事线：3 位常客按声望解锁，文本弹窗剧情 + 一次性奖励
- 周边收藏：3 档稀有度、图鉴、传说周边客流加成
- 季节与事件：每 10 天换季影响热度 ±30%、季首 3 天活动周、5 种随机事件
- 店铺成长：体验区/货架/装修 3 条升级线 × 3 级
- 美术：MeshToonMaterial 3 阶赛璐璐 + inverted hull 描边、等距 45°、昼夜光照、程序化 Q 版小人 + emoji 气泡
- 存档：localStorage 自动存档（bgs_save_v1）

## 试玩方式
- 本地服务器：http://localhost:8321（已启动）；或任意静态服务器托管项目根目录后打开 index.html
- 需要联网加载 three@0.160.0（CDN，unpkg 主 / jsdelivr 备）

## 已知事项（非阻断）
1. WebGL 视觉效果未经人工目视验证——建议打开浏览器实际玩一天确认赛璐璐观感
2. ~~种子 1234 积极策略 16 天通关~~ → 2026-09 数值复评后 bot 18-26 天全部进带（footfall.base 5 + repDivisor 10）
3. Safari <16.4 不支持 import map；Node 24 下 `node --test tests/` 需用显式文件
4. buyCheap/buyPricey 同值使 cheapThreshold 成死区分；行走计时器为半死参数（均无功能影响）

## 迭代记录
- **2026-08-31 第一人称视角**（快速模式，团队 software-bgs-fp-camera）：营业阶段 Pointer Lock 鼠标环视 + WASD 走动（Shift 加速）+ 准星点击查看顾客 + AABB 碰撞（墙体/货架/体验桌/收银台），V 键随时切回等距俯瞰；新增 src/scene/firstPerson.js 与 17 例测试（碰撞 11 + FP 世界 6：出生点合法性/BFS 连通性/角落实死锁/布局漂移守卫），59/59 全绿。手感参数集中在 CONFIG.firstPerson（视高/速度/灵敏度/碰撞半径）。
- 已知限制：玩家与顾客无碰撞（设计取舍）；Chrome 下 ESC 后 1 秒内快速重进锁定有控制台 unhandled rejection 噪音（功能无碍）。

- **2026-08-31 大型增量：场景/物流/结账/员工扩展**（团队 software-bgs-expansion，标准增量 SOP）：
  - **新玩法闭环**：MORNING（SKU 下单/定价/升级/雇员工）→ **PREP 备货 90s**（货车到店卸箱→按住 F 开箱/取货/搬货上架，可提前开门）→ OPEN 营业 105s → CLOSING 日结；两阶段均支持 2 倍速
  - **物流闭环**：下单 → 货车 8s 到店卸快递箱 → 开箱(1.5s)/取货(0.6s) → 搬到对应品类货架上架(4.0s)；**货架初始全空，摆上才可见可售**；一箱 4 件 = 一取 = 补满一格
  - **商品**：4 品类 → **13 个 SKU**（进价 8-210/售价 16-380，2 款限定需声望 30/55 解锁）
  - **结账**：队列 5 人（队首耐心 20s），玩家站柜台按住 F 结账 2.0s/位（结账完成才计收入）；**A33 自助兜底**：队首等 ≥14s 转自助扫码 5s（收入保住、满意度 0）
  - **员工**：收银/导购/体验官/仓管 4 岗，可排班（不上班不付薪）、疲劳与离职；3D 可见走动（复用 Q 版小人）
  - **场景**：完整店铺（门头招牌/橱窗/玻璃门）+ 街道外景（人行道/车道/路灯/行道树/3 邻铺/货车），玩家可走出店门
  - **气泡**：顾客头顶需求气泡（找货❓/投诉😠/结账💳/讲解💬/推荐⭐，含 SKU 名+售价）；**第一人称须走到 2.5m 内才能响应**
  - **修复 2 个阻断级 bug**：① 货车卸箱数据结构不一致（boxes 存对象却被当 id 处理）导致订货永远卡在 inTransit 黑洞；② 货架格位取空后保留 sku 绑定导致该品类永远无法再上架
  - **测试**：79 → **129/129 全绿**（新增 logistics 11 / staff 9 / migration 13 / interaction 8 / needs 6 / balance 3）；含两个 bug 的回归守卫
  - **平衡**：5 种子通关 12-23 天（完美 bot 上限），footfall.base 调至 7（裁决 9 唯一旋钮）
  - **存档**：v1→v2 一次性迁移，旧档补默认值继续可玩
  - 已知限制：WebGL 视觉未经人工目视（建议实机玩一天）；通关天数实测偏完美 bot 上限，真人会更慢

- **2026-08-31 商品高精度模型 + 模型定位/碰撞专项排查**（blender-3d 管线）：
  - **13 个 SKU GLB 模型**（`tools/assetgen/`：common.py 公共助手 + products.py 建模 + check_products.py 契约断言 + preview_products.py 预览渲染，产物 `assets/glb/<sku>.glb`，344–1292 tris/个）：每 SKU 独立剪影设计（猫耳盒/放大镜/宝石簇/神庙/火箭/幼龙/珍珠奶茶/手冲咖啡/能量棒/骰子钥匙扣/贴纸包/金属徽章/骰塔），正面朝 -Y、底面 z=0、每材质一网格收敛 draw call。运行时 `src/scene/productAssets.js` 双路径：GLB 命中 → toonify（继承 color/transparent/emissive，glass/ems 角色不描边）+ 克隆共享几何；未就绪/缺失 → 回退原程序化模型，加载完成自动重建替换。
  - **定位错乱修复**：① 货架商品悬浮 0.14（SLOT_OFFSETS dy 0.58 基准 ≠ 层板顶 0.44）且货架升级放大后 2/3 层商品埋进层板——格位改为 `(0.44+row×0.55)×shelfVisualScale(level)` 并与 shop.js/碰撞共用缩放真值，升级后既有商品自动重排；② 快递箱盖平放只盖半箱 → 改绕后缘铰链开合；③ 玻璃门常关但人穿门 → 接近时双扇外滑（纯视觉，碰撞不变），顺带修正右门把手朝外的不对称；④ **既存 bug：任何 rebuild（买升级）后新屋顶 visible=true，等距俯瞰下屋顶盖住整个店内**——populate 延续 rebuild 前显隐 + onUpgrade 后补 updateFpOverlay。
  - **碰撞箱校准**（CONFIG.firstPerson，全部与实建几何逐一核对，半宽=视觉 AABB 实测值，玩家半径由 slideMove 另膨胀）：货架 hx 1.0→0.75 / hz 0.6→0.375 且随升级放大 hx（buildObstacles 新增 shelfLevel 参数）；体验桌 1.28/0.82→1.23/0.75；收银台 1.08/0.48→1.0/0.4；盆栽 0.34→0.40（叶球 r=0.4 在身体区间内）；临街墙 hz=0.1 保持（B4 红线 maxZ≤5 锁死，注释说明）。
  - **验证**：`node --test` 130/130 全绿；check_products.py 契约全过；preview 26 张逐张目检；`tools/e2e/shot-shelf.mjs`（puppeteer-core + 本机 Chrome，服务器内嵌）浏览器终验——GLB 上架 26 实例、坐板高度数值断言（×1.3 升级态 0.572/1.287/2.002 全中）、箱盖开盖、滑门 doorOpenT 0↔0.996、rebuild 后店内完整。
  - 已知限制：`window.BGS` 调试句柄为 e2e 专用；回收商人仅账单日到店。

- **2026-08-31 v3 大扩展：自由货架 / 商城次日达 / 手持与库房 / 找零与租用**（10 项需求，151/151 全绿，平衡 18-24 天进带）：
  - **货架自由放置**（需求 1）：36 格去品类绑定改全局格池（slotsOfShelf/slotsAll/shelfIndexOfSku），补货按货架序号落格、满架不外溢；顾客浏览目标 = 目标 SKU 所在货架。
  - **分类型陈列 + 体积**（需求 2）：SKU 增 `slotCap`（桌游 4 / 钥匙扣 8 / 骰塔 2 …）；周边 = 梯形敞开置物盒（merch_bin.glb）+ min(qty,3) 个 0.5× 小样占一格；货架每格挂价格标签 sprite（emoji+售价，桌游加租价行，超指导 1.25× 红色）。
  - **手持物品**（需求 3）：session.carry 双手机制——取货入手、上架从手、空手约束、打烊自动入库兜底；FP 相机右下 / iso 店长手上挂 GLB 克隆（carryView.js），HUD `.fp-carry` 提示。
  - **找零小游戏**（需求 4）：F 结账开面板（左购物清单 / 右应收·实收·数字键盘），答对即完成（走 playerPayDone 结算点），答错该客满意度封顶 0，放弃回退 2.0s 计时；顾客离队自动关面板；收银员/自助通道不变。
  - **桌游租用**（需求 5）：boardgame 品类按顾客类型概率分流租用 → 带 SKU 入座按时收租金（rentFeeOf=售价×12% 下限 5）→ 玩完归还上架；租金与体验费互斥，单列 rentalIncome 进日结 net。
  - **商城页**（需求 7）：showMall 全屏卡片网格（Blender 渲染静态图 assets/img/sku/*.png + 进价/指导/在库四态 + 整箱 stepper + 现金校验），下单即时扣款；晨间面板进货区改为商城入口 + 在途摘要。
  - **次日达 + 真实纸箱 + 物理堆叠**（需求 8）：Delivery 增 arriveDay（晨单次日 PREP 发车，closeOutDay 保留未到期单）；crate.glb 五面敞口纸箱（内腔 + 外撇盖片，SEALED 盖板 / OPEN 掀盖见小样 / EMPTY 空箱留置）；箱体 {x,z,y,vy,settled} 轴对齐重力沉降堆叠 + 玩家推箱（pushBox 撞墙/撞箱即停、推出支撑即坠落）。
  - **空箱处理 + 周回收商**（需求 9）：空箱 F 折叠 → 纸板入纸板堆（stockroom.cardboard，上限 50）；垃圾桶一键清空空箱；每账单日回收商人站店门口（♻️ NPC），售卖全部纸板 2/件。
  - **真实库房**（需求 10）：左墙开门洞（z -1.6~-0.4，员工门改铰链内开）+ 库房场景（三面墙/双面货架/后仓存货小样/纸板堆/垃圾桶，stockroom.js 随库存同步）；FP bounds.minX 放宽 -9.95 + 左墙/库房/街道障碍显式化（B4 红线改写：z>5 只允许左角立面）；入库（手上→后仓）/取货（面板选 SKU 上手）交互。
  - **存档 v3**：CONFIG.version=3；v2 档经通用合并兜底（stockroom/rentalIncome 默认），mergeLogistics 补老档箱子物理字段；migration.test 增 v2→v3 用例。
  - **测试**：+21 例（checkout 7 / logistics 物理与空箱 5 / firstPersonWorld 库房连通 2 / interaction 手持链路改写 / migration v3）；130 → 151 全绿。
  - e2e：shot-mall（商城下单次日达断言）/ shot-w3（箱堆/库房/手持/回收商）/ shot-w4（找零全链路成交 +68）/ shot-shelf（货架陈列回归）。

- **2026-09-01 试玩反馈修正**（152/152 全绿）：
  - **快递箱没换上 GLB**：旧箱实体建箱时资产未就绪 → 永久停留在回退方盒——street.js 加懒换装（资产就绪后摘除回退盒换真箱，回退件打 `fallbackCrate` 标记）。
  - **手持改双手抱起**：FP 挂点 (0.30,-0.26,-0.5)→(0,-0.3,-0.52) 正对镜头；iso 挂点移到店长胸前正前方。
  - **互动即时化**：CONFIG.interaction.instantHold=true —— beginHold 校验通过即完成（unbox/pick 一次 tick 到位），不再占交互槽、无进度条；**手动结账只保留找零小游戏**（beginHold('pay') 恒拒，放弃/计时兜底通道删除）；测试改写为即时语义。
  - **门楣横梁 z-fight**：横梁 z 4.9 → 5.2（出前墙外侧面，不再与墙体共面）。
  - **建筑红线**：config.street 增 `facadeLine=5.05`（本店前墙外侧）与 `roadFarLine=14.0`；邻铺立面全部对齐红线（z 6.8→6.45 立面齐平、门/招牌/遮阳棚移到 -z 立面侧、棚挑出 ≤1.0），对面便利店对齐道路边线（13.6→15.4）；firstPersonWorld 增 E2 红线守卫测试（解析 street.js 常量表断言立面贴合）。

- **2026-09-01 实体固定标签**：店铺名/价格类标签从 Sprite（永远面向镜头）全部改为**固定安装的平面标牌**（scene.js 新 `makeLabelPlane`，Mesh+PlaneGeometry 贴表面、不随镜头转）——货架价格标签贴层板前沿微上仰、快递箱侧标贴箱体正面、邻铺招牌贴 -z 立面、回收商头牌朝店门、库房门牌贴门板、库房小样标签朝 +x。顾客头顶心情/需求气泡属游戏 UI，保留 billboard 不在此列。152/152 全绿。

- **2026-09-01 操作与场景反馈大修正**（156/156 全绿）：
  - **准星左右键交互**（F 保留为左键别名）：左键 = 放置/操作/服务（开箱/上架/入库/丢弃/回收/结账/回应/放箱/开关门），右键 = 拾起（取货/折叠/库房取货/抱起整箱）；resolveTarget 增 btn 分班过滤（BTN_CLASS），HUD 双键提示条。
  - **快递箱完整开启动画**：crate.glb 重构为铰链层级（FlapN/S/E/W 盖片挂在箱顶缘空节点，rest=闭合盖顶，check 断言节点名）；运行时 openT 驱动——胶带盖板先掀起淡出、盖片 N→S→E→W 错峰外翻 135°、开大半后见内容物。
  - **纸板亲手入库**：折叠空箱 → 折叠纸壳入双手（carry type=cardboard），抱到库房左键入纸板堆；整箱搬运：右键抱起 SEALED 箱（摘下世界）、库房左键放下（钳制进库房范围落定），库房内照常开箱取货。
  - **库房门牌固定到门框墙**（不随门扇摆动）+ **手动开关门**（左键 doorToggle，关门时门洞有碰撞板——buildObstacles 增 staffDoorOpen 参数，开关即时重建）。
  - **打烊整理阶段（EVENING）**：日结报告 → 「🧹 打烊整理」进 EVENING（清场顾客/队列/需求/行人，无客流无员工，箱物理+交互继续），HUD 增「🛒 商城下单」「🌙 打烊休息」——不自动进下一天，整理完手动休息。
  - **按键补全**：Space/Enter=剧情继续，Esc=关面板/卡片（找零面板自理 Enter/Esc），Enter=当前面板主按钮，X=倍速，C=图鉴。
  - **街道整改**：邻铺主体退红线后（立面齐平 5.05、不占人行道），加背景排屋（打印店/书店/便利店/药店），对面排屋贴道路边线 14；卡车朝向修复（rotation.y=π/2 横停 → 0 顺向）+ 停靠点上马路（z 7.2→9.5）；补环境行人（确定性 5 名沿 sidewalkLane 往返，不占 rng 流）。
  - **商品尺寸**：桌游/饮品陈列缩小到 0.4×（参考骰子小件立放）；周边 9 件/格（置物盒 3×3 小样）；手持商品渲染为置物盒盛放（托盘+小样）。
  - **店铺扩张占位**：晨间升级区加「🏗️ 店铺扩张（收购邻铺 · 向后扩展 · 向上加层）——敬请期待」行（后续迭代钩子）。
  - e2e：shot-round3（卡车/街道/抱箱进库房/整理阶段）+ shot-open（盖片角度采样断言）+ probe 数值验证。

- **2026-09-01 收货堆叠 / 键名标注 / 完整街道 / 店铺扩张 / 人物 GLB**（159→160 全绿）：
  - **箱标签固定 + 3×3×3 堆叠区**：快递箱物品标签贴箱体正面（不随盖板摘除）；到货落点改为门右 3×3×3 堆叠区（x 7.2-8.6 / z 5.4-6.6，不挡入口）——修复同单箱全落一列的真 bug（chooseDropColumn 按 maxTop 算层数、下单时箱 y=0 恒为 1 列，改按箱数计层且 makeBox 收 pendingBoxes）；logistics 增「收货堆叠」回归用例。
  - **按钮键名标注**：`.kbd` 键帽样式加到标题/晨间/商城/日结/找零/剧情按钮——M=商城、N=打烊休息、X=倍速、C=图鉴、Space/Enter=剧情继续、Esc=关面板全接（main.js keydown）。
  - **完整街道**：红绿灯（灯杆 x7.0 z10.2，绿 7s/红 5s 确定性相位）+ 3 车 2 道（红灯停斑马线前）+ 2 名过街行人（红灯过街）+ 5 名环境行人；行走域 maxX 12 / maxZ 13.7 全街可步行；花店/咖啡馆/灯杆入 streetObstacles、farWallObstacle z14.05。
  - **店铺扩张落地**：`buyExpansion(gs,id)` 三级一次性购买——stockroom_plus 纸板上限 ×2（cardboardCapOf 动态读）、wing_right 右墙开洞常通 + 翼房（buildWingRoom 三面墙）+ 2 体验位、loft 阁楼视觉 + 声望 +10；晨间面板三级行替换占位，onExpansion 重建场景/障碍/行走域；checkout 增 3 扩张用例。
  - **精美人物 GLB**：`assets/glb/player.glb`（14 蒙皮件、7 骨、idle/walk 双 clip，tools/assetgen/player.py 管线全过契约）；character.js `buildManagerCharacter` 双路径（GLTFLoader + SkeletonUtils.clone + AnimationMixer，缺资产回退程序化），syncManagerVisual 按移动切 walk/idle；标题页附 player.glb 下载链接。
  - **终验修复两处**：① 翼房体验桌位置池原按「前 N 个」取——新档收购后 3 桌全落主区、翼房空房；改为「主区 min(1+experienceLevel,4) + 翼房 2」拼接选取，buildObstacles 同步拆分语义（tableCount=主区桌数、wingRight 独立追加 2 桌+翼房墙），positions.mainTableCount 为三处调用唯一真值；② shot-final 收购因现金不足静默失败（6000 > 2496）——脚本补现金并断言返回值。

- **2026-09-01 追加批：取消库存上限 / 库房从简 / 全品类托盘**（160/160 全绿）：
  - **在库 10 上限取消**：inventoryCapOf 恒 Infinity；balance bot 改现金预算下单（注意：restock 超现金整单拒绝，bot 曾因此每日零到货）。
  - **库房置物架全取消**：stockroom.js 只剩房间 + 垃圾桶 + 纸板堆，未拆封快递箱直接抱进库房落地存放；config 移除 2 个 rack 障碍。
  - **全品类专属托盘陈列**：TRAY_OF 映射（boardgame→game_tray.glb / snacks→drink_tray.glb / merch→merch_bin.glb），托盘内小样数 = min(qty,9) 与该槽位数量一致；game_tray/drink_tray 两个新 GLB 过契约（18 资产全绿）。
  - **库房门牌双面可读**：makeLabelPlane 增 doubleSide 选项（门牌不再随朝向消失）。

- **2026-09-01 试玩反馈修正②：箱堆分布 / 抽箱沉降 / 交互限距**（161/161 全绿）：
  - **收货不再一柱擎天**：chooseDropColumn 由「单列堆满 3 层再开新列、全满回退首列无限向上」改为**最矮列优先**（平铺一层再自然叠高，超 27 箱也均匀上涨）；12 箱实测 9 列平铺（3 列两层）。
  - **抽箱自动沉降**：stepBoxPhysics 每 tick 复查已落定箱的支撑面——搬走/折叠/丢弃下层箱后上层自动唤醒落到新支撑（此前 settled 箱永不复查，悬空永续）；回归用例：抽走下箱后上层 y 0.56→0 落定。
  - **放置/交互不再隔空**（「所有物品可以放置在任何地方」）：iso 俯瞰原免距离（裁决 4）——resolveTarget 的 inRange 与 beginHold 闸门、canPlayerRespond 三处统一改为 fp 2.5 / iso 3.2（CONFIG.firstPerson.interactRangeIso 新字段），店长须走到目标旁才能开箱/上架/入库/放箱/响应气泡；needs/interaction 旧对照断言改写，抱箱/折叠用例改为「走到箱旁 → 走到库房」分段位姿。
  - **库房放箱防穿模**：placeCarriedBox 落点改为 supportFloor（同位已有箱自动叠顶），不再 y=0 硬落定穿进旧箱。

- **2026-09-01 试玩反馈修正③：自由放箱 / 到货分时段 / 轮廓线描边**（163/163 全绿）：
  - **放箱不限库房**：placeBox 从库房锚点改为「原地放下」（候选锚点 = 玩家准星前方，免距离校验、fp 朝向锥兼容），placeCarriedBox 钳制店内范围（含库房；收购翼房后含翼房；店外放下自动钳回店内），同位有箱照旧叠顶。
  - **到货分时段**：delivery 增 `arrivePhase`——早上（MORNING）下单 → 当晚 EVENING 打烊时货车送到（startEveningSession 发车 + eveningTruck 提示）；晚上（EVENING）下单 → 次日 PREP 早上到（原路径）。startDeliveries(gs, phase) 按时段过滤（缺省 null=全发，测试/工具用）；mergeLogistics 老档订单补 arrivePhase='PREP'；晨间/商城面板文案按阶段动态（「今晚打烊时送达 / 明早备货时送达」）；balance bot 补 EVENING 发车+到货步骤；「次日达」用例重写为 3 条时段契约。
  - **描边改轮廓线描边法**：删除全部 inverted hull 加面壳（addOutline 函数及 7 文件约 20 处调用尽数移除，draw call 减半、蒙皮件免绑骨壳、薄片/曲面反包黑块问题根除）；新增 `src/scene/outlinePass.js`——EffectComposer + 带 DepthTexture 的 RT（samples=4）+ 自写 ShaderPass：四邻域深度差分检轮廓、透视/正交双公式（uIsOrtho）、距离自适应阈值、描边色沿用 0x3a2410；main.js 渲染入口改 outline.render(scene, activeCamera)，resize 同步。
  - e2e：shot-outline.mjs 双视角终验（fp 透视 + iso 正交轮廓线均清晰，阴影/同色墙无污染），probe-dropzone 三条回归（平铺/沉降/iso 限距）保持绿。
  - **同日回退**：轮廓线后处理方案按用户决定回退——addOutline（inverted hull）及全部调用点恢复原状，outlinePass.js 删除，渲染入口回到 renderer.render；放箱自由化与到货分时段两条需求保留不受影响。163/163 复跑全绿。
  - **折叠纸壳一次最多拿 10 张**（164/164）：flattenBox/beginHold/resolveTarget 三处放宽——手上已是纸壳且 <10 张时可继续折叠叠加（手上拿商品/整箱仍拒折），stash/日结入库按 carry.n 累加（原逻辑已兼容），CONFIG.stockroom.cardboardCarryCap=10；新增用例覆盖「连折 10 张 → 满拒 → 一次入库 +10 → 拿商品仍拒」。

- **2026-09-01 街道补齐 / 价签调价 / 货架拿货 / 布局模式**（170/170 全绿）：
  - **店铺侧人行道铺满全街**：人行道/路缘石 x 24→44（覆盖两端邻铺门前），车道 30→46 对齐；新增对面人行道+路缘石（z∈[14,15]，宽度 farSidewalkW=1.0 入 config），对面便利店/药店主体后移贴新外沿（立面 14→15）；E2 红线守卫同步改判「对面立面 = roadFarLine + farSidewalkW」。
  - **价签调价**：货架价格标签恢复 raycast（makeLabelPlane 默认禁拾取，价签单独恢复 Mesh.prototype.raycast）+ userData.priceTag/shelfSlot 打标；左键（fp 准星 / iso 点选）命中价签 → showPricePanel 调价面板（数字输入 + ±1/±10 步进，Enter/Esc，setSkuPrice 钳指导价 ±50%）；pickShelfSpot 支持 prefer 穿透（同一射线上商品/价签先后命中，左键优先价签、右键优先商品）。
  - **右键拿起货架物品重新放置**：takeSlotToHands(gs, session, slotIdx) 整格入双手（取空解绑、四态守恒、手上非空拒绝），货架商品 display 打 userData.shelfSlot，右键 raycast 命中即拿；重新放置复用既有 restock 上架链路。
  - **布局模式（仅 EVENING 打烊后）**：HUD「🧱 布局 B」开关（开启态高亮）；右键拾起货架/体验桌/收银台（userData.layoutKind 打标）→ 构件跟随指针地面交点（0.2m 网格吸附、fp 限距 7m、拖动中冻结店长与相机）→ 左键放下写 gs.customLayout + 重建场景与碰撞 + 存档，右键取消回位；离开 EVENING 自动关闭。新模块 `src/sim/layout.js`：layoutOf（默认 CONFIG + 稀疏覆盖）/ moveLayoutPiece（店内钳制，翼房收购后东扩）/ shelfAnchorOf；shop.js populate 读有效布局（收银交互点/队列跟随），buildObstacles 增 layout 参数，interaction.js 货架锚点动态化；存档浅合并自动兼容。新增 tests/layout.test.js 5 例（默认推导/钳制/锚点/障碍跟随/存读档）。
  - e2e：probe-layout（右键拾起 → 拖动 → 放下，customLayout 写入 + 交互点跟随）/ probe-pricetag（价签投影点击 → 面板调价 16→24 clamp 生效 → 右键拿货 carry 正确）；shot-street 全街人行道目检。
  - 排障记录：iso 切视角会用 fp 位置覆盖 managerPos（探针设位须在按 V 之后）；BGS 调试句柄增 layoutMode/layoutDrag 只读 getter。

- **2026-09-01 顶栏精简 / 街道收窄校准 / 数值复评 / 门牌真固定**（170/170 全绿）：
  - **顶栏优化**：按钮去 emoji 精简文字并全部带键名 chip——图鉴 C / 倍速 X / 提前开门 O（新键位）/ 商城 M / 打烊 N / 布局 B；倍速按钮 innerHTML 更新不覆盖 kbd。
  - **库房门牌真固定**：shop.js 的 textPlane 一直是 Sprite（billboard 永远面向镜头，此前"双面可读"修复没打中真身）——改走 makeLabelPlane（Mesh+PlaneGeometry），与 street.js 版一致，doubleSide 透传。
  - **人行道收窄一半 + 全街校准**：★根因修复——全街步行曾把 `config.street.blockZ`（可行走外沿）改 13.7，而 street.js 把它当「人行道外沿」用，人行道被拉到 z∈[5,13.7] 把车行道整个吞掉（车在人行道上跑、斑马线脱节）；现 street.js 改用独立真值 `sidewalkW=1.5`（人行道 z∈[5,6.5]），马路 z∈[6.5,12.5]、车行道线 8.0/11.0、斑马线中心 9.5、红绿灯 z 9.7、过街行人 5.75↔13.0、对面人行道 z∈[12.5,13.5]、对面建筑立面 13.5、farWall 13.55、可行走外沿 blockZ 13.2、dropZone/doorBoxSlots 内收不超 6.5；碰撞/行走域测试常量同步。
  - **数值体系复评**（tools/analyze-balance.mjs 逐日采集 5 种子）：归因——通关过快（12-17 天）主因是**声望增速 ~6.3/天**且全部来自「成交即 +1」+ 客流随声望正反馈滚雪球；footfall.base 7→6 几乎无效（后期客流大头是声望项，转化率反向补偿）。定稿 **footfall.base 7→5 + repDivisor 11→10**（增强正反馈收敛种子方差）：bot 通关 18/20/24/26/26 全部进 18-28 目标带，均值 22.8 天；经济面观察——毛利转正、租金为主要刚性支出、租用/体验费为合理补充、经济与胜利（声望 100）仍弱耦合但不进一步动结构。
  - e2e：shot-street 全街收窄目检（车不上人行道、斑马线/红绿灯对齐）；balance.test 无警告（全进带）。

- **2026-09-01 备货下单 / 晨间面板 / 街道加宽 / 员工 AI 寻路 / 货架跟随修复**（173/173 全绿）：
  - **PREP 备货阶段可下单**：placeOrder 到货判定改「EVENING 下单 → 次日早到；其余（MORNING/PREP）→ 当晚到」；商城按钮扩展为 PREP/EVENING 均显示（M 键同步），商城页到货文案按阶段动态；时段契约新增 PREP 用例。
  - **晨间面板三列重构**：左列 进货（商城入口+在途）+ 店铺扩张（从升级区拆出独立 renderExpansion）｜中列 定价滑杆｜右列 升级+员工；CSS grid 1fr/1.4fr/1fr + 窄屏退化单列；扩张行名称横排修正（flex-wrap）。
  - **街道再校准**：人行道 ×1.5 → 2.25（z∈[5,7.25]）、马路 ×1.25 → 7.5（z∈[7.25,14.75]）、两侧人行道等宽 2.25、对面建筑立面 17、行走外沿 blockZ 16.7、远墙 17.05；★**斑马线朝向修正**——白条长边改沿 x（平行于道路/人行道方向）沿 z 排 6 条（原垂直于道路，反了）；车行道线 9.2/12.8、红绿灯 z 11、过街行人 6.1↔15.9、停车线不变。
  - **员工 AI 行为 + 寻路优化**：director 顾客/员工移动从直线插值改为 slideMove 避障（每帧按当前布局 buildObstacles，NPC 半径 0.25，滑墙绕行货架/桌/墙，布局拖动即时生效）；新增 sim 纯函数 `staffTargetOf`（staff.js）——仓管有箱链路任务走向目标箱、导购走向认领需求的顾客、收银守台、体验官守体验位，director 委托调用；staff.test 新增 2 例走位目标用例。
  - **货架移动后商品不跟随修复**：syncShelves 的 holder 位置从「创建时固定」改为每帧对齐最新交互点（布局拖动货架时商品/价签同步跟随，放下即锁定）。
  - 排障记录：e2e 全挂的根因是 panels.js 扩张区拆分时 renderUpgrades 丢了闭合 `}`（后续 export 落进函数体）——node --check 未报、浏览器 V8 报 SyntaxError: Unexpected token 'export'，教训：浏览器才是模块语法终审；另 jsdelivr 当时不可达，index.html 的 CDN probe 从 HEAD no-cors 改 GET（HEAD 在部分网络下挂起）+ 超时 4s→8s。
  - e2e：probe-staff（四岗在位 + 全街 OPEN 目检）/ shot-final（晨间三列）/ shot-street（斑马线平行 + 双侧等宽人行道）。
  - **员工「固定在原吧台」根因修复**：director 的顾客离店清理循环 `if (!alive.has(id))` 没跳过员工 key（'staff-N' 字符串），员工实体每帧被删、下帧在出生点（恰好是吧台旁）重建——员工从未真正走位。删除循环跳过 staff key 后走位即刻恢复；顺手把员工出生点从收银台（障碍内，会被 slideMove 挤出）改到店门口，并给 slideMove 包一层「卡死检测 + 沿墙侧移绕行」（目标在障碍边缘另一侧时分轴滑动会死锁）。e2e 回归：probe-staff-fix 断言拖走收银台后收银员实体跟随新位。

- **2026-09-01 收货 bug 修复 / 布局构件旋转**（175/175 全绿）：
  - **★早上下单打烊时不到货（用户实测 bug）**：`closeOutBoxes` 的订单保留条件 `arriveDay > 今天` 把「当天 EVENING 到」的 ORDERED 单误删——日结清场时单没了，EVENING 发车无单可发（货款两失、inTransit 残留）。过滤改为：未到期（次日+）保留 + 当天到期中 arrivePhase='EVENING' 的保留；新增全链路回归用例（MORNING 下单 → closeOutBoxes → 订单保留 → startEveningSession 发车 → 卸箱）。
  - **布局模式构件旋转**：拖动中按 **R** 旋转 90° 步进（0/90/180/270 取模）；customLayout 条目带 rot 字段（老档缺省 0 兼容）；layoutOf 输出 rot，shop.js populate 构件 rotation.y、交互锚点/收银队列/体验位按 rotOffset 随朝向旋转；buildObstacles 在 rot 90/270 时互换 hx/hz（货架仍带升级缩放）；shelf.js 陈列 holder 每帧同步位置+朝向（拖转货架商品跟随）；HUD 提示加「R 旋转」。layout.test 增旋转用例（存取/换轴/锚点/归模/保留朝向）。
  - e2e：probe-layout 扩展（拾起 → R 旋转 → 放下 → 断言 rot=90 且交互点随朝向）；probe-staff-fix（收银员跟随）保持绿。

## 团队
software-boardgame-shop：许清楚（PM）/ 高见远（架构）/ 寇豆码（工程）/ 严过关（QA），主理人齐活林编排；第一人称迭代由寇豆码 + 严过关快速模式完成。
