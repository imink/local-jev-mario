# 本地 Jev Mario

[English](./README.md)

真实 NES 模拟器 → SMB1 RAM → 对象化 JSON → 本地 Jev 兼容接口 → Gemma → 手柄。
不使用 Midscene 视觉能力，不给模型截图，不需要云端 API Key，也不包含任何 Nintendo ROM、图片或音乐。

此独立仓库从 `imink/midscene` 的 `examples/local-jev-mario` 提取。
`gemma-baseline` 分支保存已运行成功的 Gemma/Jev 实现；其他模型在独立分支接入。

## 启动

需要 Node.js 24+、pnpm 9.3.0+ 和自己合法取得的原版 Super Mario Bros `.nes` 文件。
本示例使用独立的 pnpm workspace，不需要构建 Midscene。

```bash
cd ~/code/local-jev-mario
pnpm install --frozen-lockfile
pnpm start
```

打开 **http://127.0.0.1:4174**，选择本地 `.nes` 文件，点击「加载 ROM」，然后「单步决策」或「启动 Agent」。
ZIP 请先在本地解压，页面加载的是 `.nes`，不是 ZIP。ROM 仅在服务进程内存中加载；
不会保存上传文件、传给模型或从 API 返回。也可以启动时加载：

```bash
MARIO_ROM="/absolute/path/to/Super Mario Bros.nes" pnpm start
```

本次用户提供的欧洲版附件已解压到本工作区被 Git 忽略的
`midscene_run/roms/user-supplied.nes`（此文件**不属于源码分发**）。在这个工作区可以运行：

```bash
MARIO_ROM=midscene_run/roms/user-supplied.nes pnpm start
```

端口 4174 避开已有的 4173；遇到端口占用会报错，不会停止其他进程。
若 PATH 中 `pnpm` 被 depot_tools 覆盖，可使用 `corepack pnpm`。
如果 Corepack 的下载也受本机网络配置影响，应使用 pnpm 官方发行的 9.3.0+ 可执行文件，而不是修改共享 Python 或模型环境。

## 本地模型服务

默认复用 `http://127.0.0.1:8766/v1/systemone`，先检查：

```bash
curl http://127.0.0.1:8766/health
pnpm probe
```

`probe` 发送**合成 RAM 状态**验证真实 Jev/Gemma 的协议，不能证明真实游戏效果。
要验证用户 ROM → RAM → 真实模型 → NES 动作：

```bash
MARIO_ROM="/absolute/path/to/game.nes" pnpm smoke
# 可选：SMOKE_DECISIONS=20；默认只执行 3 次，绝不保证通关。
```

只有现有 Jev **没有运行**时才需启动本示例自带的兼容适配器：

```bash
GEMMA_BASE_URL=http://127.0.0.1:8765/v1 pnpm jev
```

适配器会从 `/models` 读取唯一已加载的模型 ID；多模型时需设置准确的 `GEMMA_MODEL`。
请求参数固定为 `temperature: 0`、`enable_thinking: false`、`stream: false`、`max_tokens: 768`，
使用 JSON schema 并校验返回类型。`JEV_PORT` 可换成未占用端口；游戏端相应设置 `JEV_BASE_URL`。
不要为本示例重复加载已经运行的 Gemma。若确实尚未运行，可在已有的、安装了 MLX-VLM 的环境中启动：

```bash
HF_HUB_OFFLINE=1 /path/to/venv/bin/python -m mlx_vlm.server \
  --model /absolute/path/to/local-model --host 127.0.0.1 --port 8765 --max-tokens 768
```

这里的 Jev 是**类型化协议适配层**，并非另一个模型，也不是官方 TypeSafe/Jev SDK。
真正推理的是 Gemma。兼容协议只返回 Choice 和 Noul：动作概率、置信度和 Score 显示「未提供」，
不伪造数值，不把 Noul 当成校准后的成功概率。

## 游戏行为与兼容范围

- 以 world 1-1 开局。加载/重新开始只执行启动画面所需的 START，不修改 RAM 或注入存档。
- 支持 mapper 0、32 KiB PRG、8 KiB CHR、无 trainer 的 iNES 1.0（40976 字节）。
  遥测针对原版 SMB1 布局；World 版为目标布局，用户提供的 Europe Rev A 已进行真实模型控制验证。
  **JSNES 使用 NTSC 时钟，欧洲版属于兼容运行，不是精确的 50 Hz PAL 模拟。**
  文件头不能可靠识别游戏/区域；其他游戏、改版和组合卡即使头部相同，也不在支持范围。
- 7 个动作：`noop`、`right`、`right_jump`、`right_run`、`right_run_jump`、`jump`、`left`。
  每个动作持有 `FRAMES_PER_DECISION` 帧，默认 16，范围 1–60。这是模拟帧间隔，不是每秒推理次数。
  推理期间模拟器完全暂停，响应延迟不增加游戏内反应帧。
- Choice 直接控制动作。没有硬编码救场、自动跳跃或自动松开 A 的模拟帧；
  连续两次跳跃需要模型先选择不含 A 的动作。Noul 只用于显示。
- RAM 状态包括玩家、轨迹、可见敌人及投影、合并后的地形矩形/可能缺口、
  最近地面预览、反应时序、上一动作和局内进度。不发送原始 tile grid。
  坐标单位为像素，Y 向下；小 Mario 的上边界按 32 像素 RAM 锚点修正。
  地形只信任可见区域；非零碰撞块视为潜在实体，敌人匀速投影不是保证。
  `imminentCollision` 是由相对速度、16 像素水平碰撞宽度及「下一动作帧数 + 16 帧起跳准备」
  推导的碰撞提醒，不是模型 Score。提示词要求优先避险，但代码不会强制替换模型动作。
- 每次决策还收到隔离模拟器副本计算的 7 个动作物理预测：`next` 对应当前 16 帧，
  `held` 对应持续按同一动作 60 帧，均为 `[前进位移,y,运动阶段]`；
  每项同时说明下一决策时能否重新起跳。
  预测不推进或回退真实游戏，不替模型选动作，不读取之前的局数。
  预测结果逐项写进 Choice 的选项说明，所有 7 个选项都保留，包括可能死亡的选项；
  代码不筛选或替换模型的选择。
  若当前动作暂时存活但持续持有会死亡，再从下一决策点测试全部 7 种后续动作。
  若它们都在下一间隔内死亡，将该选项标为 `TRAP`，让模型看到短期前进后的不可挽回风险。
  没有此标记不代表更远未来安全。
  长期预测假设中间不换动作，并非对后续不同决策序列的保证。
- 死亡、旗杆/终点或 `MAX_DECISIONS`（默认 3000）后停止，不自动重开。
  暂停会取消当前请求，并丢弃迟到的模型回答；重新开始是新 run。
  模型、解析、ROM、日志写入错误会明确显示并停止，不替换成假成功或默认动作。
- 画面由 NES framebuffer 在本地 Canvas 显示；无声音。
  页面截图仅用于开发者验证 UI，不会发送给 Jev/Gemma。

## 日志、配置与隔离

### 精简模型输入

完整遥测仍在本地保留，已有跨局记录不会删除；仅发送精简投影给模型：去掉分数、UUID、
重复说明等控制无关数据，地形矩形用 `[左,上,右,下]` 表示，去重当前地形与地面预览。
保留所有当前可见敌人/地形、未知值、升降速度、撞顶/落地/松键状态及 16 帧动作间隔。
启用跨局经验时，从相关记录中选最近的 1 条失败和 1 条进展，在当前位置附近各取最多 4 段，
另保留实际结束动作，避免把途中片段误读为死亡原因。
连续同动作的平地移动/原地卡住会合并并保留次数；撞顶、落地和换键不合并。
截断明确标记省略步数，部分进展不会改写成通关；原始经验文件不裁剪。

页面显示服务实际返回的输入 tokens、状态压缩前后字符数，以及最近实际发送的精简状态。
JSONL 的 request 保留完整遥测，choice 中的 `modelInput` 和 `modelQuestions`
记录实际精简状态与问题（包括各选项的物理预测）。
此优化不改变模型、采样参数、16 帧决策间隔或推理时暂停的控制方式。

### 跨局经验

**默认关闭**：每局独立推理，不读取或保存跨局经验；已有记录保持不变。
`USE_EXPERIENCE=1` 可显式开启以下行为，`USE_EXPERIENCE=0` 保持关闭。

开启后，每次死亡、到达终点、决策上限或手动重开，保存最近最多 12 次实际动作及位移、
撞顶/落地/持续按跳等事实到 `midscene_run/experience/<ROM SHA-256>/frames-<间隔>/`。
重开及重启服务不会丢失已保存经验。模型读取最近 64 局的统计，并在接近失败区域时
检索最多 2 条失败序列及 1 条更远进展序列，再按上述规则精简发送，提示其改变起跳位置、速度或松键时机。
未到终点的进展记录不会标记为通关；取消推理不会凭空产生动作经验。

这是**持久化上下文记忆，不是模型权重训练**；最终动作仍由 Gemma 的 Choice 决定。
不保证每局都会改善，不自动重开。8 帧和 16 帧经验严格隔离，旧版 JSONL 不自动导入。
升降状态使用 RAM 垂直速度，而不是把“跳跃中”都标成“上升”。
存储损坏或写入失败会明确报错并停止，不静默丢弃学习记录。
要从零开始推理，使用默认的 `USE_EXPERIENCE=0`，无需删除历史文件。

`midscene_run/logs/<run-id>.jsonl` 保存 ROM 的 SHA-256（不保存内容）、每次输入、
模型原始回答、动作、真实推进帧数、后续状态、错误/取消记录。
适配器日志在 `midscene_run/jev/`，合成状态探针在 `midscene_run/probes/`。
这些目录全部被 Git 忽略；不要提交或分发自己的 ROM。

| 环境变量 | 默认值 |
| --- | --- |
| `GAME_PORT` | `4174` |
| `MARIO_ROM` | 无；在页面选择 `.nes` |
| `JEV_BASE_URL` | `http://127.0.0.1:8766` |
| `FRAMES_PER_DECISION` | `16` |
| `MAX_DECISIONS` | `3000` |
| `USE_EXPERIENCE` | `0`；`1` 显式启用跨局记忆 |
| `JEV_PORT`（自带适配器） | `8766` |
| `GEMMA_BASE_URL`（自带适配器） | `http://127.0.0.1:8765/v1` |
| `GEMMA_MODEL`（自带适配器） | `/models` 中唯一模型 |

服务器只绑定 `127.0.0.1`，拒绝异源写请求、错误 Host、跨站子资源读取。
所有运行时模型请求仅允许数字回环地址 `127.0.0.1` / `[::1]`，禁用重定向。
为避免 DNS 重绑定，不接受 `localhost` 或自定义域名作为模型地址。
软件依赖安装需要包源网络，但运行时不连接云端。
现有适配器是用户信任的本地服务；它的上游配置仍由该服务自身负责。

## 验证

```bash
# 示例内，无模型/ROM 依赖
pnpm test

# 仓库根目录
pnpm test
pnpm run lint
```

测试覆盖 RAM/地形解析、动作协议、本地地址约束、HTTP 桥接、取消/并发、错误、
终局与日志，以及真实 JSNES 执行原创的极小 6502 测试程序。
测试程序不含 Nintendo 代码或素材，不等同于真实马里奥验证。
`pnpm smoke` 才是用户 ROM + 真实本地模型的端到端检查，日志给出实际动作与位移；
通过短程 smoke 不代表模型能通关。

本工作区已用用户提供的 Europe Rev A ROM、本地 Jev/Gemma、关闭跨局经验、
16 帧间隔实际完成一次 **1-1 到达旗杆**：138 次模型决策、2194 个游戏帧，
终态 `clear=true`、`x=3161`，未死亡且仍有 3 条生命。
完整日志为 `midscene_run/logs/d10d0a8a-6dea-47d4-9463-345dd46eb890.jsonl`
（仅本地运行产物，不随源码分发）。每个实际动作均与原始 Choice 相同；
逐步独立重放也复核了所有坐标及终点状态。此结果不保证每次推理都能复现通关。

## 来源与授权

设计参考 [fhshaik/typesafe-mario](https://github.com/fhshaik/typesafe-mario)，
检查的版本为 `ca22449ed187118d19326d1f54b01b6636578aa4`。
该版本没有声明许可证，**未复制其源代码、提示词或测试**；本实现独立编写，仅参考架构和 RAM 地址事实。
还对照了 [gym-super-mario-bros 的 RAM 地址说明](https://github.com/Kautenja/gym-super-mario-bros/blob/master/gym_super_mario_bros/smb_env.py)，没有安装其可能附带游戏资源的依赖。

NES 引擎使用 [JSNES 2.1.0](https://github.com/bfirsh/jsnes/tree/v2.1.0)，Apache-2.0 授权；
许可证随 npm 依赖安装，未复制其源码到本示例。新代码遵循本仓库许可证。
Super Mario Bros 名称及游戏资源归各自权利人；本项目不提供取得 ROM 的途径。
