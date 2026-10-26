# Jev Mario

**[在线体验](https://jev-mario.zoink.site)** · [English](./README.md)

在真实 NES 模拟器中，由 AI 选择手柄动作，并支持查看完整决策回放：
**NES → 结构化游戏状态 → Jev Choice → 手柄**。

## 在线游玩

点击 **加载 ROM**，再选择 **开始游戏** 或 **回放全局**。
Cloudflare 站点完全在浏览器中运行，不调用实时 AI 模型。

- 回放 **32 关、6275 个决策**，同步查看当时的输入与回答。
- 支持暂停、逐决策，以及 **0.5× / 1× / 4× / 16×** 速度。
- 支持中英文切换；宽屏左右展示游戏与日志，窗口缩至 1100px 以下自动切换单列。
- 手动操作：点击画面，方向键移动、**Z/空格**跳、**X**跑。
  失焦自动暂停手动游戏，声音已关闭。

## 本地运行

需要 **Node.js 24+**、**pnpm 9.3.0+** 和合法持有的 SMB1 `.nes` 文件。

```bash
pnpm install --frozen-lockfile
```

**本地模型**：还需要 Apple Silicon、Python 3.12 和 `uv`。
使用 [FLock This-That 1.2](https://huggingface.co/flock-io/this-that-model-1.2)，
模型权重约 3.76 GB。

```bash
uv sync --frozen --python 3.12
pnpm download:model
pnpm model
```

模型就绪后，在另一个终端运行：

```bash
MARIO_ROM="/游戏的绝对路径/game.nes" pnpm start
```

打开 **http://127.0.0.1:4175**，点击 **启动 Agent**。
也可省略 `MARIO_ROM`，在页面中加载本地 `.nes`。

**官方 Jev API**：无需 Python 或本地模型。创建含 `TYPESAFE_API_KEY` 的
私有 `.env` 文件，然后运行：

```bash
DECISION_BACKEND=jev-official TYPESAFE_ENV_FILE=.env \
MARIO_ROM="/游戏的绝对路径/game.nes" pnpm start
```

官方模式会向 TypeSafe 发送结构化游戏状态，并可能产生 API 费用。
两种后端都不向模型发送截图或 ROM。请勿提交密钥。

## 构建静态站点

需要原始已审计通关日志及匹配的 ROM，两者均不包含在 Git 中。
仅克隆仓库不能重建线上回放。公开托管 ROM 需要分发授权，仅拥有副本并不够。

```bash
MARIO_ROM_DISTRIBUTION_AUTHORIZED=true \
MARIO_PUBLIC_ROM="/路径/authorized.nes" \
MARIO_REPLAY_LOG="/路径/audited-campaign.jsonl" pnpm build:static
pnpm preview:static
```

预览地址：**http://127.0.0.1:4180**。取得对应 Cloudflare 授权后，
`pnpm deploy:pages` 会发布到配置中的 `jev-mario` Pages 项目。
仓库默认分支和 Pages 生产分支均为 `main`。
构建仅导出白名单游戏字段和静态资源，不复制密钥、原始日志或快照。
备用的本地 ROM 导入只在浏览器中读取，不上传。

## 说明

历史通关局包含维护暂停和策略修改，不是无干预基准，也不保证未来每局通关。
日志索引 3944 对应的原 live 快照丢失后采用了确定性重建。
回放核验物理状态变化与终态画面哈希；展示的历史记录不代表模型内部推理。

开发检查：`pnpm test`、`pnpm run lint`；Python 后端另运行 `pnpm test:python`。

## 致谢

保留 Midscene 的 [MIT 许可证](./LICENSE)。
[JSNES](https://github.com/bfirsh/jsnes) 使用 Apache-2.0，
[This-That](https://github.com/FLock-io/this-that-model) 使用 MIT。
架构参考 [typesafe-mario](https://github.com/fhshaik/typesafe-mario)，
未复制该项目的源码或游戏素材。Nintendo 名称和游戏资源归各自权利人所有。
