const element = (id) => document.getElementById(id);
const context = element('screen').getContext('2d');
const labels = {
  missing_rom: '缺少 ROM：请加载自己合法持有的原版 SMB1 .nes 文件。',
  paused: '已暂停',
  thinking: 'Gemma 推理中（模拟器暂停）',
  dead: '角色死亡；请手动重新开始',
  clear: '到达终点；请手动重新开始',
  limit: '已达决策上限；请手动重新开始',
  error: 'Agent 出错，已停止',
};
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
function show(state) {
  element('status').textContent = labels[state.status] ?? state.status;
  element('count').textContent =
    `${state.decisions} / ${state.maxDecisions} · ${state.framesPerDecision} frames/decision`;
  element('action').textContent = state.decision?.action ?? '未提供';
  element('latency').textContent = state.decision
    ? `${Math.round(state.decision.latencyMs)} ms`
    : '未提供';
  const stats = state.decision?.inputStats;
  element('input-size').textContent = stats
    ? `${stats.inputTokens ?? '未知'} tokens · 状态 ${stats.fullStateChars} → ${stats.sentStateChars} 字符`
    : '未提供';
  element('model-input').textContent = state.decision?.modelInput
    ? JSON.stringify(
        {
          state: state.decision.modelInput,
          questions: state.decision.modelQuestions,
        },
        null,
        2,
      )
    : '尚未请求';
  element('jump').textContent =
    state.decision?.jumpNeeded?.toFixed(3) ?? '未提供';
  element('log').textContent = state.logFile ?? '未开始';
  element('learning').textContent = state.learning
    ? `${state.learning.episodes} 局 · ${state.learning.deaths} 次死亡 · 记忆内最远 x=${state.learning.bestX ?? '无'} · 可用相关记录 ${state.learning.nearbyEpisodes.length} 条`
    : state.experienceEnabled
      ? '尚无经验'
      : '已关闭：不读取或保存跨局经验';
  const player = state.state?.player;
  element('progress').textContent = player
    ? `${player.world}-${player.stage} · x=${player.x} · best=${state.state.episode.bestX} · time=${player.time}`
    : '未加载';
  element('telemetry').textContent = state.state
    ? JSON.stringify(state.state, null, 2)
    : '尚未加载 ROM';
  if (state.error) element('error').textContent = state.error;
  const playable =
    state.loaded && state.status === 'paused' && !state.busy && !state.running;
  for (const id of ['start', 'step']) element(id).disabled = !playable;
  element('pause').disabled = !state.busy && !state.running;
  element('restart').disabled = !state.loaded || state.busy || state.running;
  element('load').disabled = state.busy || state.running;
}
async function act(action) {
  element('error').textContent = '';
  try {
    await action();
  } catch (error) {
    element('error').textContent = error.message;
  }
}
for (const command of ['start', 'step', 'pause', 'restart']) {
  element(command).addEventListener('click', () =>
    act(async () => {
      element(command).disabled = true;
      show(
        await api('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        }),
      );
    }),
  );
}
element('load').addEventListener('click', () =>
  act(async () => {
    const file = element('rom').files[0];
    if (!file) throw new Error('请先选择自己合法持有的 .nes 文件。');
    if (file.size !== 40976)
      throw new Error('此适配器需要 40976 字节的原版 mapper-0 iNES 文件。');
    show(
      await api('/api/rom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      }),
    );
  }),
);
async function health() {
  element('health').textContent = '正在检查…';
  try {
    const data = await api('/api/health');
    element('health').textContent = `就绪 · ${data.engine} · ${data.model}`;
  } catch (error) {
    element('health').textContent = `服务未就绪：${error.message}`;
  }
}
element('check').addEventListener('click', health);
async function refresh() {
  try {
    const state = await api('/api/status');
    show(state);
    if (state.loaded) {
      const response = await fetch('/api/frame');
      if (!response.ok) throw new Error(`Frame HTTP ${response.status}`);
      const pixels = new Uint8ClampedArray(await response.arrayBuffer());
      if (pixels.length !== 256 * 240 * 4)
        throw new Error('Invalid NES framebuffer.');
      context.putImageData(new ImageData(pixels, 256, 240), 0, 0);
    }
    if (element('error').textContent.startsWith('连接/画面错误：'))
      element('error').textContent = '';
  } catch (error) {
    element('error').textContent = `连接/画面错误：${error.message}`;
  } finally {
    setTimeout(refresh, 500);
  }
}
health();
refresh();
