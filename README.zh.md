# 本地 This-That Mario

[English](./README.md)

真实 NES 模拟器 → SMB1 RAM / 结构化状态 → 本地
[`flock-io/this-that-model-1.2`](https://huggingface.co/flock-io/this-that-model-1.2)
→ 手柄。模型一次前向计算为七个动作打分，不生成文本。
不发送截图、不调用云端推理、不需要 API Key、不由脚本代选动作，也不包含 Nintendo 素材。

## 两个分支

独立仓库从 `imink/midscene` 的 `examples/local-jev-mario` 提取：

- `gemma-baseline`：保存之前可运行的 Gemma + Jev 兼容适配器。
- `this-that-local`：本文档对应的原生本地决策模型。

切换分支前，先停止**从本仓库启动**的服务。原工作区和其 4174/8766/8765
服务独立保留，不需要停止。不会自动推送远端。

## 安装

需要 Node.js 24+、pnpm 9.3.0+、Python 3.12、uv，以及自己合法持有的
Super Mario Bros `.nes` 文件。Apple Silicon 使用 MLX float16，
模型权重约 3.76 GB，不进行量化。

```bash
cd ~/code/local-jev-mario
git switch this-that-local
pnpm install --frozen-lockfile
uv sync --frozen --python 3.12
pnpm download:model
```

依赖位于 `node_modules/` 和独立 `.venv/`；模型位于被 Git 忽略的
`models/this-that-model-1.2/`。只有安装阶段下载公开依赖和权重；
游戏期间只加载本地文件，并强制 Hugging Face / Transformers 离线。
不修改已有 Gemma 的 Python 环境。

若 `pnpm` 被 depot_tools 覆盖，可使用 `corepack pnpm` 或官方独立可执行文件。
Python 锁文件固定实际验证的依赖，MLX 版本采用本机已知兼容版本，
不会直接升级到尚未验证的新版本。

## 启动

终端一，在仓库目录启动模型：

```bash
pnpm model
```

看到 `Ready` 后，终端二：

```bash
curl http://127.0.0.1:8767/health
MARIO_ROM="/自己合法持有的游戏绝对路径/game.nes" pnpm start
```

打开 **http://127.0.0.1:4175**，点击「启动 Agent」。
也可以省略 `MARIO_ROM`，在页面选择并加载 `.nes`。ZIP 请先在本地解压。
页面上传的 ROM 仅在内存加载，不保存、不由 API 返回，也不传给模型。

仅在本开发机器上，用户提供的 ROM 已私下保存在被忽略的
`midscene_run/roms/user-supplied.nes`，可直接使用：

```bash
MARIO_ROM=midscene_run/roms/user-supplied.nes pnpm start
```

ROM 和模型权重都不进入 Git。缺少 ROM/权重、端口被占用、模型不可用或回答无效
都会明确报错。**没有 Gemma 回退**：保留的 `local-jev.mjs` 是旧适配器，
本分支的游戏会拒绝把其回答当成 This-That 决策。

## 动作和概率的含义

`local_this_that.py` 调用上游原版 `TypedDecider` 和 System One 协议解析器，
只是 HTTP 桥接层，不是另造一个模型。七个选项及其说明按原顺序传入；
动作 Choice 和跳跃用途的二选一问题通过**一次前向计算**同时回答。

模型返回的原生索引直接对应 `noop`、`right`、`right_jump`、`right_run`、
`right_run_jump`、`jump`、`left`。代码不会筛除、预选或替换任何动作。
页面展示经过校验的完整模型概率分布。此模型的 `confidence` 是
**所选动作的概率**，不是官方 Jev 的置信度定义，也不是马里奥通关率；
尚未在本游戏上做概率校准。Noul 是 `yes` 标签的概率，仅显示，不控制游戏。
没有请求危险度 Score。

使用原生分类 API 默认的温度 1.0，不是 Gemma 的文本采样温度。
生成 token 数确实为零；输入 token 数来自实际原生提示词构造器。
状态或提示词超过限制会明确报错，不悄悄截断。

每次决策前，隔离的模拟器副本为七个动作分别预测：下一决策间隔、
持续持有该动作 60 帧的结果，以及下一次能否重新起跳。
若当前间隔存活但持续持有会死亡，还会检查下一间隔的全部七种后续动作；
这些后续动作全部死亡时标为 `TRAP`。这是当前状态的物理事实，不是搜索程序替模型选动作。
没有 `TRAP` 标记不代表更远未来安全；预测副本不推进或回退真实游戏。
本分支把这些事实放进结构化 `outcomes` 表，与精简游戏状态一起发送。
生存/前进优先级由模型执行，应用不计算最终获选动作。
最初的长句输入试跑曾卡在 x434；对同一状态改用结构化表后，
模型能够选出越过水管所需的跳跃。

## 游戏行为

- 通过正常 START 流程从 1-1 开始，不修改 RAM，不注入存档。
- 支持原版 mapper-0 iNES SMB1：32 KiB PRG、8 KiB CHR、无 trainer，
  共 40976 字节。遥测采用 World 布局，用户的 Europe Rev A 已运行过；
  仅凭文件头不能识别其他游戏或改版。
- **JSNES 使用 NTSC 时钟，欧洲版是兼容运行，不是精确的 50 Hz PAL 模拟。**
  页面显示本地 NES framebuffer，无声音。
- 默认每 16 个模拟帧决策一次，不是每秒推理 16 次。推理期间游戏暂停。
  落地后继续按住 A 不能重新起跳，必须由模型选择不含 A 的动作松键。
- 死亡、旗杆/终点或达到决策上限后停止，不自动重开。暂停会取消请求并丢弃迟到回答。
- **默认关闭跨局经验**：不读取、不保存之前的局数。只有 `USE_EXPERIENCE=1`
  才显式启用有界事实记忆，不是权重训练；否则已有历史不变。

## 配置与证据

| 环境变量 | 默认值 |
| --- | --- |
| `GAME_PORT` | `4175` |
| `THIS_THAT_BASE_URL` | `http://127.0.0.1:8767` |
| `MARIO_ROM` | 无；页面选择 `.nes` |
| `FRAMES_PER_DECISION` | `16`，允许 1–60 |
| `MAX_DECISIONS` | `3000` |
| `USE_EXPERIENCE` | `0` |

更改模型端口：`pnpm model --port 8768`，游戏端对应设置
`THIS_THAT_BASE_URL=http://127.0.0.1:8768`。
两个服务都仅绑定 `127.0.0.1`，校验 Host/Origin 并拒绝跨站请求。
运行时模型地址仅允许数字 HTTP 回环地址；禁止重定向、DNS 域名和 URL 内凭据。

`midscene_run/logs/<run-id>.jsonl` 保存完整遥测、实际精简输入和问题说明、
模型身份/原生分布、执行动作、后续坐标及错误。所有运行产物均被 Git 忽略。
模型失败会停止游戏，不会变成默认动作。

```bash
pnpm run lint
pnpm test
pnpm run test:python
pnpm probe
MARIO_ROM=midscene_run/roms/user-supplied.nes SMOKE_DECISIONS=20 pnpm smoke
```

单元测试不需要模型权重或 Nintendo ROM，包含在真实 JSNES 中执行的原创极小 6502 程序。
`probe` 用合成 RAM 测试真实模型；`smoke` 才使用用户 ROM 和真实模型。
mock 通过或短程 smoke 都不等同于通关。

此前是 **Gemma 基线**完成了无跨局经验的 1-1：138 次决策、2194 帧，
终态 x3161、全部 3 条生命仍在。本地证据：
`midscene_run/logs/d10d0a8a-6dea-47d4-9463-345dd46eb890.jsonl`。
不能把这次结果归为 This-That 的成绩。

**This-That 的真实通关记录：**`59adc974-09de-4850-9c3e-0011cb220ccf`，
使用用户提供的 Europe Rev A ROM，关闭跨局经验，每次推进 16 帧。
从首次请求到终态，共 **87 次决策、1388 个模拟帧、85.02 秒**；
决策 HTTP 平均延迟 **511.8 ms**，所有回答生成 token 数为零。
终态 `clear=true`、`dead=false`、`x=3161`，仍有 3 条生命。

每个执行动作都与原生模型选择一致，独立 ROM 重放复核了全部 87 次玩家/局内状态变化。
本地证据为
`midscene_run/logs/59adc974-09de-4850-9c3e-0011cb220ccf.jsonl` 和
`midscene_run/verification/59adc974-09de-4850-9c3e-0011cb220ccf-audit.json`。
这是一轮已经验证的成功记录，不保证以后每局都能通关，也不是与不同输入/策略的
Gemma 进行的严格受控模型性能比较。

## 来源与授权

保留 Midscene 的 MIT 许可证。JSNES 2.1.0 使用 Apache-2.0，
许可证随依赖安装。
[FLock-io/this-that-model](https://github.com/FLock-io/this-that-model)
为 MIT 授权，代码固定为
`6af11c63c8bb260aa4bed2b7717f33f25decd16e`。
MIT 权重明确使用 **1.2**，版本
`c4d1c30b8d512d278726de439b8cc81fccc70c8f`；
不会误用上游 API 的默认 1.0。

架构参考 [fhshaik/typesafe-mario](https://github.com/fhshaik/typesafe-mario)，
检查版本 `ca22449ed187118d19326d1f54b01b6636578aa4` 未声明许可证，
因此没有复制其源码、提示词、测试或游戏素材。RAM 地址事实也对照了
[gym-super-mario-bros](https://github.com/Kautenja/gym-super-mario-bros/blob/master/gym_super_mario_bros/smb_env.py)，
但没有安装该依赖。Nintendo 名称和游戏资源归各自权利人；本项目不提供 ROM 获取途径。
