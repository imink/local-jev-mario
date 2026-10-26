export const messages = {
  'zh-CN': {
    title: 'Jev Mario · 回放与游玩',
    introduction:
      '6275 个真实 Jev 动作，从 1-1 到 8-4。这里展示历史决策，不提供实时 AI 服务。',
    instructions:
      '点击“加载 ROM”从 Cloudflare 下载游戏，再点击“开始游戏”。游戏在当前浏览器中运行。',
    loadROM: '加载 ROM',
    start: '开始游戏',
    replay: '回放全局（从 1-1）',
    pause: '暂停',
    resume: '继续',
    step: '逐决策',
    speed: '回放速度 {speed}×',
    localImport: '备用：导入本地 ROM',
    localFile: '本地 .nes 文件',
    localPrivacy: '本地文件仅在当前标签页中读取，不上传。',
    initial: '先点击“加载 ROM”，再点击“开始游戏”或“回放”。',
    canvas:
      '马里奥游戏。手动操作：方向键移动，Z 或空格跳，X 跑，Enter 开始，右 Shift 选择。',
    manualHelp:
      '手动：点击画面，方向键移动，Z/空格跳，X 跑，Enter 开始，右 Shift 选择。离开、隐藏或失焦时释放按键并暂停。声音已关闭。',
    noDecision: '无历史决策',
    decision: '输入帧 {frame} · Choice {choice} · {latency} ms',
    decisionHelp:
      '输入属于动作前；画面显示当前动作或自动过场。只展示保存过的输入与回答，不代表模型内部推理。缺失的概率或 Score 不会补造；原始记录保持原文。',
    notLoaded: '未加载',
    input: '实际模型输入',
    questions: '实际问题',
    answers: '原始回答字段',
    provenance: '审计来源、ROM 哈希与限制',
    audit:
      '3944 原 live 快照丢失后的确定性重建不是原 live 字节对照。原正式局有维护暂停与策略修改，并非无干预实验。结束停在原生胜利触发帧。',
    license: 'Apache-2.0 许可证',
    hosting: '无实时 AI 接口或应用追踪。由 Cloudflare 托管。',
    stopped: '停止：{error}',
    complete: '完整回放已核验：6275 动作 / 32 关 / 终态像素一致。',
    replayStarted: '回放从 1-1 开始；可暂停阅读决策。',
    manualStarted: '点击画面后用方向键移动、Z/空格跳、X 跑。失焦自动暂停。',
    loadingHosted: '正在从 Cloudflare 加载 ROM…',
    loadingLocal: '正在读取本地 ROM…',
    loadedHosted:
      'ROM 已从 Cloudflare 加载并核验。点击“开始游戏”或“回放”。SHA-256：{hash}',
    loadedLocal:
      'ROM 已从本地加载，不上传。点击“开始游戏”或“回放”。SHA-256：{hash}',
  },
  en: {
    title: 'Jev Mario · Replay & Play',
    introduction:
      '6275 recorded Jev actions, from 1-1 to 8-4. Recorded decisions, not a live AI service.',
    instructions:
      'Click Load ROM to download the game from Cloudflare, then Start game. Gameplay runs in this browser.',
    loadROM: 'Load ROM',
    start: 'Start game',
    replay: 'Replay full campaign',
    pause: 'Pause',
    resume: 'Resume',
    step: 'Next decision',
    speed: 'Replay speed {speed}×',
    localImport: 'Import local ROM instead',
    localFile: 'Local .nes file',
    localPrivacy: 'Local files are read in this tab and never uploaded.',
    initial: 'Click Load ROM, then Start game or Replay.',
    canvas:
      'Mario game. Manual: arrow keys move, Z or Space jump, X run, Enter start, right Shift select.',
    manualHelp:
      'Manual: focus the canvas. Arrows move, Z/Space jumps, X runs, Enter starts, right Shift selects. Blur, hiding or leaving releases all controls and pauses. Audio is disabled.',
    noDecision: 'No historical decision',
    decision: 'Input frame {frame} · Choice {choice} · {latency} ms',
    decisionHelp:
      'Input precedes the action; the screen shows the current action or automatic transition. Only saved input and answers are shown, not internal reasoning. Missing probabilities or Scores were not provided. Original records are not translated.',
    notLoaded: 'Not loaded',
    input: 'Recorded model input',
    questions: 'Recorded questions',
    answers: 'Recorded answer fields',
    provenance: 'Provenance, ROM hash and limitations',
    audit:
      'The original live snapshot at decision 3944 was lost. Its deterministic reconstruction is not an original-live byte comparison. The campaign included maintenance pauses and policy changes, not an unattended experiment. Replay stops at the native victory trigger.',
    license: 'Apache-2.0 license',
    hosting: 'No live AI endpoint or app tracking. Hosted by Cloudflare.',
    stopped: 'Stopped: {error}',
    complete:
      'Audited victory verified: 6275 actions / 32 stages / matching final pixels.',
    replayStarted: 'Replay starts at 1-1. Pause to read decisions.',
    manualStarted:
      'Focus the canvas; arrows move, Z/Space jumps, X runs. Blur pauses the game.',
    loadingHosted: 'Loading ROM from Cloudflare…',
    loadingLocal: 'Reading local ROM…',
    loadedHosted:
      'ROM loaded from Cloudflare and verified. Click Start game or Replay. SHA-256: {hash}',
    loadedLocal:
      'ROM loaded locally, not uploaded. Click Start game or Replay. SHA-256: {hash}',
  },
};

export function translate(language, key, values = {}) {
  const template = messages[language]?.[key];
  if (typeof template !== 'string')
    throw new Error(`Missing UI translation: ${language}/${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name))
      throw new Error(`Missing UI translation value: ${key}/${name}`);
    return String(values[name]);
  });
}
