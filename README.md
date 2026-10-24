# MOSS AI App

**MOSS 移动端产品工程**（uni-app / Vue3 / Vite）。2026-10-24 自 `dsh-link-suite/app/` 独立而来，用于承载移动端的持续功能扩展——DSH Link 远程模块是它的第一个能力域，后续新功能直接在本工程内生长，不再受 DSH Link 套件边界约束。

> 独立后与 `dsh-link-suite` 的关系：**协议契约仍是同一条**（`@dsh-link/protocol`，57 个方法），但源码已内嵌为本工程的 `protocol/` 目录，两工程互不依赖路径。协议需要双端同步时，改动要同时落到 `dsh-link-suite/shared/protocol` 与本工程 `protocol/`（见下文「协议包」）。

## 这是什么

| 部分 | 说明 |
|---|---|
| `src/` | 应用本体：4 个页面（首页/会话/对话/我的）+ MOSS 皮肤 × 明暗 |
| `protocol/` | 内嵌协议包 `@dsh-link/protocol`：帧格式、方法名、错误码、锁屏策略，零运行时依赖 |
| `tools/moss-render/` | 渲染与截图工具（WebP 动画资产、UI 截图 harness、图标渲染） |
| `resources/` | 图标等静态资源 |
| `dist/` | 构建产物（`build/h5` 是 H5 发布物，不入库） |

## 快速开始

```bash
npm install          # 首次
npm run dev:h5       # H5 开发（浏览器）
npm run build:h5     # H5 构建 → dist/build/h5
npm run typecheck    # vue-tsc 全量类型检查
npm run typecheck:protocol   # 协议包类型检查
npm run test:protocol        # 协议包单测（frame/qr/pairing）
```

其它端：`npm run dev:mp-weixin`（微信小程序）、`npm run dev:app`（App 端）。

## 目录结构

```
moss-ai-app/
├── src/
│   ├── pages/            # index（设备）/ sessions（会话）/ chat（对话）/ me（设置）
│   ├── components/       # MossMarkdown、MossGenui、MossFileView、MossSheet、PageShell + moss/ 视觉件
│   ├── core/             # transport（WSS 通道）/ link（重连）/ store / markdown / genui / attach / demo / haptic / press
│   ├── static/           # 图标与 moss 动画资产
│   ├── manifest.json     # 各端配置（含 Android/iOS 权限声明）
│   └── pages.json        # 路由与全局样式（全 custom 导航）
├── protocol/             # 内嵌协议包（@dsh-link/protocol）
├── tools/moss-render/    # 资产渲染 / UI 截图 / H5 预览服务
└── vite.config.ts        # @ → src、@dsh-link/protocol → protocol/src
```

## 协议包（`protocol/`）

- 导入名保持 `@dsh-link/protocol`（它就是 dsh-link 的线上契约，改名没有收益），由 `vite.config.ts` / `tsconfig.json` 的别名映射到 `protocol/src/index.ts`——**直接吃源码**，改协议不需要先构建。
- 本目录是 `dsh-link-suite/shared/protocol` 的快照 + 后续独立演进。若要与宿主插件保持兼容：
  1. 双侧同步修改（方法名/帧格式/错误码/锁屏策略）；
  2. 两侧各自跑 `npm run test:protocol`；
  3. 真机联调前先核对 `METHODS` 列表是否一致。
- **只加新功能、不动远程链路时，不需要碰 protocol/**。

## 加新功能时从哪入手

| 想加什么 | 放哪 |
|---|---|
| 新页面 | `src/pages/<name>/`，在 `src/pages.json` 注册（沿用 `navigationStyle: custom`） |
| 新业务逻辑 | `src/core/` 新模块，状态进 `src/core/store.ts` |
| 新视觉组件 | `src/components/`（通用）或 `src/components/moss/`（MOSS 皮肤件） |
| 新远程能力 | 先在 `protocol/` 加方法契约，再改 `src/core/transport.ts` 分发 |

## 已知注意事项

- **局域网直连权限**：`src/manifest.json` 目前只声明了 `INTERNET / ACCESS_NETWORK_STATE / CAMERA`。iOS 直连局域网还需 `NSLocalNetworkUsageDescription`（不声明时系统**静默失败**、只有无错误超时）；Android 侧也缺若干声明。详见 `dsh-link-suite/docs/09-网络访问机制.md` 的清单。
- **渲染工具的本机依赖**：`tools/moss-render/*.mjs` 里写死了 `/Applications/Google Chrome.app/...` 与本工程的绝对路径，换机器要改。
- **`.hbuilderx/`** 是 HBuilderX 的运行配置，仅本机使用。

## 迁移遗留与已知问题（2026-10-24 盘点）

| 事项 | 状态 |
|---|---|
| **git 历史** | 迁移前的 43 个逐文件提交保存在 **`legacy-history`** 分支（自 dsh-link-suite 用 `git subtree split` 拆出）；`main` 是独立快照，两者内容连续但历史不合并。查旧 blame：`git log legacy-history -- src/...` |
| **CI** | 迁移当天已补 `.github/workflows/ci.yml`（npm ci + typecheck + 协议自测 + H5 构建）；在补之前新仓库一度没有 CI |
| **锁文件** | 迁移时改名导致 package-lock 根 name 停在 `@dsh-link/app`，已同步为 `moss-ai-app`（`npm ci` 不受影响，纯元数据） |
| **tools/moss-render 的 mock 数据** | `ui-harness.mjs` / `shot-files.mjs` 里 `app/src/core/upload.ts` 等是截图 fixture 的假路径，不是真实引用；仅观感问题 |
| **assets3d 符号链接** | `tools/moss-render/assets3d` 指向 `dsh-pet-liang/assets3d` 的**绝对路径**链接，换机器/移动目录需重建 |
| **跨仓工具** | dsh-link-suite 的 `npm run shots:app` 会来本工程取 `dist/build/h5`，两工程需同级放在工作区根 |

## 历史

- 2026-10-24：从 `dsh-link-suite/app/` 独立为 `moss-ai-app/`，内嵌协议包、修正 moss-render 路径、更新两侧文档。
- 2026-10-24：修复会话内 dsh-ui 卡片不渲染（genui 子集对齐 dsh-genui 0.14.0：容器展平 / 缺 type 推断 / 围栏语言规范化）；补 CI、同步锁文件、历史存入 `legacy-history` 分支。
- 更早的迭代记录见 `dsh-link-suite/docs/`（02 技术方案、07 详细设计、13 验收状态）与 `dsh-link-suite/docs/screenshots/`；逐文件历史在 `legacy-history` 分支。
