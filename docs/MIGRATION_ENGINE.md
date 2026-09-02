# 引擎迁移规划：Web 原型 → 专业游戏引擎

> 状态：规划（未启动）。本文件是迁移路线图，随原型迭代同步更新。
> 原则：**先在原型里把玩法验证透，再迁移；迁移以 sim 层为骨架，golden-master 测试对齐行为**。

## 1. 原型现状盘点（迁移友好度评估）

| 层 | 内容 | 迁移友好度 |
|----|------|-----------|
| `src/sim/` | 全部玩法逻辑：经济/顾客 AI/员工/物流/需求/布局/存档。**纯 ES Module，零 DOM 零 three 依赖** | ★★★★★ 可逐行移植为 C#/GDScript 纯类 |
| `src/rng.js` | 自研确定性 RNG（存档种子契约） | ★★★★★ 算法简单，逐行移植保证同种子同结果 |
| `src/config.js` | 全部数值/文案真值（13 SKU、经济系数、街道几何） | ★★★★★ 可直接转 JSON/资源表 |
| `assets/glb/` | 18 个 Blender 生成 GLB（SKU/纸箱/托盘/人物） | ★★★★☆ 引擎直接吃 GLB（Unity 需 glTF 插件/转 FBX；Godot 原生 glTF） |
| `tools/assetgen/` | Blender 无头建模脚本（参数化可重跑） | ★★★★★ 资产管线原样保留 |
| `src/scene/` | three.js 渲染层（赛璐璐 toon 材质/描边壳/灯光） | ★★☆☆☆ 需按引擎材质系统重做（效果有参照图） |
| `src/ui/` | DOM 面板（晨间/商城/找零/图鉴） | ★★☆☆☆ 需用引擎 UI 重做（结构简单） |
| `tests/` | 175 例 Node 单测（sim 层全覆盖 + 平衡 bot） | ★★★★☆ 用例即规格，可移植为引擎单测框架的 golden 用例 |

**结论**：玩法核心（sim + rng + config）与渲染/UI 严格分层，是最适合迁移的结构。sim 层约 5k 行，移植工作量集中且可机器校验。

## 2. 目标引擎选型

| 引擎 | 优势 | 代价 | 建议 |
|------|------|------|------|
| **Godot 4** | 开源免费；原生 glTF（资产零转换）；GDScript 与 JS 神似移植快；Web/桌面/移动全平台导出 | 团队生态小于 Unity；C# 支持但文档以 GDScript 为主 | **首选**（独立游戏体量、无授权费、资产管线顺） |
| Unity | 生态最大、教程多；C# 工程化好；WebGL 可导出 | glTF 需插件（glTFast）或转 FBX；WebGL 包体大、加载慢；个人版有 splash | 次选（团队已有 Unity 经验时） |
| Unreal | 画质上限高 | 对低模经营游戏严重过重；Web 支持差 | 不考虑 |

推荐 **Godot 4 + GDScript**（如团队 C# 更强则 Godot + C#，sim 层移植体验更好）。

## 3. 迁移分阶段（每阶段可独立验收）

### 阶段 0：冻结契约（1 天）
- 把 `src/config.js` 导出为 `config.json`（写个小脚本），作为引擎侧数值真值源。
- 从 tests 里提取 **golden-master 用例集**：固定种子 → 关键事件序列 + 每日结算快照（现金/声望/库存四态），存 JSON。这是行为对齐的裁判。

### 阶段 1：sim 层移植（3-5 天，核心）
- 逐文件移植 `src/sim/*.js` → Godot `sim/*.gd`（纯 RefCounted 类，不碰 Node）：
  economy / customers / needs / logistics / staff / day / layout / story / save / rng。
- **函数级一一对应**（同名同参同返回），先不重构不优化。
- 移植 tests 为 GUT（Godot Unit Test）用例；跑 golden-master：**同种子下每日快照必须与 Web 版逐分一致**（RNG 一致是硬指标）。
- 验收：175 例中的 sim 用例在 Godot 侧全绿 + golden 快照全等。

### 阶段 2：场景与交互（5-8 天）
- Godot 场景树重建：店铺（shop.js）/ 街道（street.js）/ 库房 / 货架陈列 / 角色（GLB 直接导入，动画 clip 名契约不变：idle/walk）。
- 赛璐璐观感：toon ramp shader（Godot 写 ShaderMaterial，3 阶）+ 描边壳（inverted hull，Godot 里同理 BackSide 外扩）。
- 第一人称控制器 + AABB slideMove（firstPerson.js 逻辑直接移植，Godot 里自己写位移解算，不用物理引擎，行为一致）。
- 验收：店内/街道可走动，碰撞/交互距离与原型一致（移植 firstPersonWorld 用例）。

### 阶段 3：UI 与流程（3-5 天）
- Control 节点重做：HUD / 晨间面板 / 商城 / 找零面板 / 图鉴 / 剧情弹窗（结构照抄，样式可顺手升级）。
- 阶段流转（MORNING→PREP→OPEN→CLOSING→EVENING）由 sim 层已移植的 day.gd 驱动，UI 只读状态。
- 验收：完整一天可玩通，与原型截图对照。

### 阶段 4：发布管线（1-2 天）
- Godot 导出 Web（HTML5）+ Windows 桌面包；itch.io 页面。
- 保留 Blender 资产管线：新增 SKU → 重跑 assetgen → 导入。

## 4. 风险与对策

1. **RNG 一致性**：golden 快照对不上 90% 是 RNG 移植错（运算符优先级/无符号右移）。对策：rng.gd 单独先移植先测，用 5 个种子各取前 100 个数与 JS 版比对。
2. **浮点漂移**：物理/计时用浮点累加，快照允许 ±1 现金/±0 库存的容差，声望必须精确。
3. **GLB 材质**：原型 toonify 在运行时替换材质——Godot 侧在导入后统一换 shader，材质名契约（glass/ems）沿用。
4. **范围蔓延**：迁移期冻结新功能（新需求先在 Web 原型验证，再随下一批移植）。

## 5. 不在迁移范围

- tools/e2e（puppeteer 探针）：Web 专用，引擎侧用 GUT + 截图对比替代。
- overview.md 迭代记录：迁移完成后由新仓库接手。
