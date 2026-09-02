# 桌游店物语 · Game Shop Simulator

3D 赛璐璐风桌游店模拟经营游戏（浏览器 demo，无构建纯静态）。

## 🎮 在线试玩

**https://xin1ya.github.io/Game-Shop-Simulator/**

打开即玩（PC 浏览器 + 键鼠；首次加载需联网拉取 three.js CDN）。

## 玩法速览

- **核心循环**：晨间准备（商城进货 / 定价 / 升级 / 员工 / 店铺扩张）→ 备货（搬快递箱、开箱、上架）→ 开门营业 105s（顾客浏览/体验/排队结账）→ 日结 → 打烊整理（理货 / 布局调整 / 下单）→ 新的一天
- **目标**：声望做到 100（名店）；现金为负即破产
- **操作**：
  - `WASD` 移动，`Shift` 加速，`V` 第一人称/俯瞰切换
  - **左键** = 放置/操作（开箱、上架、结账找零、点价签调价）
  - **右键** = 拾起（取货、抱箱、折叠纸箱、从货架拿货）
  - `M` 商城 · `C` 图鉴 · `X` 倍速 · `O` 提前开门 · `N` 打烊 · `B` 布局模式（打烊时拖放/旋转家具）
  - 找零结账是算术小游戏：左侧顾客购物清单，右侧输入应找金额

## 本地运行

任意静态服务器托管项目根目录即可（无构建步骤）：

```bash
node tools/e2e/serve.mjs 8321   # 或 python -m http.server 8321
# 打开 http://localhost:8321
```

## 测试

```bash
node --test tests/balance.test.js tests/checkout.test.js tests/collision.test.js \
  tests/economy.test.js tests/edge.test.js tests/firstPersonWorld.test.js \
  tests/interaction.test.js tests/layout.test.js tests/logistics.test.js \
  tests/migration.test.js tests/needs.test.js tests/simulation.test.js tests/staff.test.js
# 175 例全绿；冒烟：node .smoke.mjs
```

## 控制台调试指令

游戏内 F12 控制台：

```js
BGS.cheat.cash(5000)  // 加金币
BGS.cheat.rep(25)     // 加声望
```

## 一键部署（阿里云）

项目是纯静态站点（无构建），一条命令发布到阿里云：

```bash
# ① 首次：服务器上跑一次初始化（装 nginx + 站点配置）
scp tools/deploy/server-setup.sh root@<服务器IP>:/tmp/ && ssh root@<服务器IP> bash /tmp/server-setup.sh

# ② 编辑 tools/deploy/deploy.sh 配置区（IP/用户/目录），以后每次发布：
bash tools/deploy/deploy.sh
```

- 发布方式：打包 → 解压到 `releases/<时间戳>` → 原子切换 `current` 软链（保留最近 5 版可回滚）
- nginx 已配好 `.glb`/`.mjs` MIME、gzip、缓存策略；安全组放行 80（HTTPS 用 certbot 一条命令）
- 备用：https://xin1ya.github.io/Game-Shop-Simulator/（GitHub Pages，push main 自动更新）

## 技术栈

- three.js 0.160（CDN + import map，无打包器）
- 原生 ES Modules：`src/sim`（纯逻辑，Node 可测）/ `src/scene`（three 渲染）/ `src/ui`（DOM 面板）
- Blender 无头 GLB 资产管线（`tools/assetgen`，便携版 Blender）
- puppeteer e2e 探针（`tools/e2e`）
- 后续规划：迁移到专业游戏引擎，见 `docs/MIGRATION_ENGINE.md`
