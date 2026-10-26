const element = (id) => document.getElementById(id);
const context = element('screen').getContext('2d');
let previousGameError = null;
let replay = null;
let replayHistory = null;
let replayBusy = false;
let playing = false;
let replayTimer;
let viewGeneration = 0;
let renderedDecision;
const labels = {
  missing_rom: '缺少 ROM：请加载自己合法持有的原版 SMB1 .nes 文件。',
  paused: '已暂停',
  thinking: '模型决策中（模拟器暂停）',
  dead: '角色死亡；请手动重新开始',
  clear: '已完成全部 32 关（8-4）；请手动重新开始',
  transitioning: '关卡/区域切换中：推进游戏自身演出，不调用模型',
  respawning: '死亡演出/复活中：自动使用剩余生命继续',
  game_over: '本局生命耗尽',
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
  const official = state.decisionBackend === 'jev-official';
  const title = official ? 'Official Jev Mario' : 'Local This-That Mario';
  document.title = title;
  element('title').textContent = title;
  element('backend').textContent = official
    ? `NES → RAM / JSON → 官方 Jev (${state.requestedModel}) → 手柄 · 游戏状态发送至 api.typesafe.ai · 不发送 ROM、截图或密钥到页面`
    : 'NES → RAM / JSON → 本地 this-that-model-1.2 → 手柄 · 不向模型发送截图 · 不生成文本';
  const decisionOfficial = state.decision
    ? state.decision.raw?.engine === 'jev-official'
    : official;
  element('confidence-label').textContent = decisionOfficial
    ? '官方 Jev confidence'
    : '本地 confidence（所选动作概率）';
  element('play-mode').textContent = state.continuousPlay
    ? '连续模式：自动切换关卡，死亡后使用剩余生命继续；生命耗尽后从 1-1 重开，不累计前局通关数。完成全部 32 关后停止。可随时暂停；错误和安全决策上限仍会显式停止。'
    : '单局模式：自动切换关卡；死亡、完成全部 32 关或达到决策上限后停止，不自动重开。';
  element('status').textContent = labels[state.status] ?? state.status;
  element('count').textContent =
    `${state.decisions} / ${state.maxDecisions} · ${state.state?.reaction_timing?.framesPerDecision ?? state.framesPerDecision} frames/decision`;
  element('action').textContent = state.decision?.action ?? '未提供';
  element('last-model').textContent = state.decision?.raw?.model ?? '未提供';
  element('decision-warning').textContent = state.decision?.responseWarning
    ? '官方返回的 Choice 与概率最大项不一致：保留并执行官方原始 Choice，不代选；详细记录已写入决策日志。'
    : '';
  element('latency').textContent = Number.isFinite(state.decision?.latencyMs)
    ? `${Math.round(state.decision.latencyMs)} ms`
    : '未提供';
  const stats = state.decision?.inputStats;
  element('input-size').textContent = stats
    ? `${stats.inputTokens ?? '未知'} tokens · 状态 ${stats.fullStateChars} → ${stats.sentStateChars} 字符`
    : '未提供';
  if (renderedDecision !== state.decision) {
    element('model-input').textContent = state.decision?.modelInput
      ? JSON.stringify(
          {
            state: state.decision.modelInput,
            questions: state.decision.modelQuestions ?? '未记录',
          },
          null,
          2,
        )
      : replay
        ? '历史记录未保存实际发送内容'
        : '尚未请求';
    element('raw-response').textContent = state.decision?.raw
      ? JSON.stringify(state.decision.raw, null, 2)
      : '尚无记录';
    renderedDecision = state.decision;
  }
  element('jump').textContent =
    state.decision?.jumpNeeded?.toFixed(3) ?? '未提供';
  element('confidence').textContent =
    state.decision?.confidence === null ||
    state.decision?.confidence === undefined
      ? '未提供'
      : `${(state.decision.confidence * 100).toFixed(1)}%`;
  const selectedProbability =
    state.decision?.probabilities?.[state.decision.action];
  element('selected-probability').textContent =
    selectedProbability === undefined
      ? '未提供'
      : `${(selectedProbability * 100).toFixed(1)}%`;
  element('probabilities').textContent = state.decision?.probabilities
    ? Object.entries(state.decision.probabilities)
        .map(
          ([action, probability]) =>
            `${action}: ${(probability * 100).toFixed(1)}%`,
        )
        .join('\n')
    : '未提供';
  element('log').textContent = state.logFile ?? '未开始';
  element('learning').textContent = state.learning
    ? `${state.learning.episodes} 局 · ${state.learning.deaths} 次死亡 · 记忆内最远 x=${state.learning.bestX ?? '无'} · 可用相关记录 ${state.learning.nearbyEpisodes.length} 条`
    : state.experienceEnabled
      ? '尚无经验'
      : '已关闭：不读取或保存跨局经验';
  const player = state.state?.player;
  const campaign = state.state?.campaign;
  element('campaign').textContent = campaign
    ? `目标：1-1 → 8-4 全部 32 关 · 已完成 ${campaign.completedLevels.length}/32 · 当前 ${campaign.currentLevel}`
    : '目标：完成 1-1 至 8-4 全部 32 关，不跳关';
  element('progress').textContent = player
    ? `${player.world}-${player.stage} · x=${player.x} · best=${state.state.episode.bestX} · time=${player.time}`
    : '未加载';
  element('telemetry').textContent = state.state
    ? JSON.stringify(state.state, null, 2)
    : '尚未加载 ROM';
  if (state.error) element('error').textContent = state.error;
  else if (
    previousGameError &&
    element('error').textContent === previousGameError
  )
    element('error').textContent = '';
  previousGameError = state.error;
  const playable =
    !replay &&
    !state.replayActive &&
    state.loaded &&
    ['paused', 'transitioning', 'respawning'].includes(state.status) &&
    !state.busy &&
    !state.running;
  for (const id of ['start', 'step']) element(id).disabled = !playable;
  element('pause').disabled = !state.busy && !state.running;
  element('restart').disabled =
    Boolean(replay || state.replayActive) ||
    !state.loaded ||
    state.busy ||
    state.running;
  element('load').disabled =
    Boolean(replay || state.replayActive) || state.busy || state.running;
  element('rom').disabled = element('load').disabled;
  element('check').disabled = Boolean(replay || state.replayActive);
  element('replay-open').disabled =
    Boolean(replay || replayBusy) ||
    !state.loaded ||
    !state.decisions ||
    state.busy ||
    state.running ||
    Boolean(state.pendingApplied);
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
    element('health').textContent =
      `就绪 · ${data.engine} · ${data.model} · ${data.device}`;
  } catch (error) {
    element('health').textContent = `服务未就绪：${error.message}`;
  }
}
element('check').addEventListener('click', health);
async function refresh() {
  const generation = viewGeneration;
  try {
    if (replay || replayBusy) return;
    const state = await api('/api/status');
    if (generation !== viewGeneration || replay || replayBusy) return;
    show(state);
    if (state.loaded) {
      const response = await fetch('/api/frame');
      if (!response.ok) throw new Error(`Frame HTTP ${response.status}`);
      const pixels = new Uint8ClampedArray(await response.arrayBuffer());
      if (generation !== viewGeneration || replay || replayBusy) return;
      if (pixels.length !== 256 * 240 * 4)
        throw new Error('Invalid NES framebuffer.');
      context.putImageData(new ImageData(pixels, 256, 240), 0, 0);
    }
    if (element('error').textContent.startsWith('连接/画面错误：'))
      element('error').textContent = '';
  } catch (error) {
    if (generation === viewGeneration && !replay && !replayBusy)
      element('error').textContent = `连接/画面错误：${error.message}`;
  } finally {
    setTimeout(refresh, 500);
  }
}

function replayButtons() {
  if (replay || replayBusy)
    for (const id of [
      'start',
      'step',
      'pause',
      'restart',
      'load',
      'rom',
      'check',
    ])
      element(id).disabled = true;
  element('replay-controls').hidden = !replay;
  element('history-input').hidden = !replay;
  element('replay-toggle').textContent = playing ? '暂停回放' : '继续回放';
  element('replay-toggle').disabled =
    !replay || replay.phase === 'complete' || (replayBusy && !playing);
  for (const id of ['replay-step', 'replay-close', 'replay-seek'])
    element(id).disabled =
      replayBusy ||
      !replay ||
      (id === 'replay-step' && (playing || replay.phase === 'complete'));
  element('replay-open').disabled = replayBusy || Boolean(replay);
}

async function showReplay(packet) {
  const image = Uint8Array.from(atob(packet.image), (char) =>
    char.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(
    new Blob([image], { type: 'image/png' }),
  );
  try {
    if (packet.history) replayHistory = packet.history;
    if (replayHistory?.index !== packet.decisionIndex)
      throw new Error('回放画面与历史决策不匹配，已停止。');
    replay = packet;
    const decision = replayHistory.decision;
    show({
      loaded: true,
      decisionBackend: decision.backend ?? decision.raw?.engine,
      requestedModel: decision.raw?.model,
      status: 'replay',
      decisions: packet.count,
      maxDecisions: packet.total,
      framesPerDecision:
        replayHistory.requestState.reaction_timing?.framesPerDecision,
      state: packet.state,
      decision,
      runId: packet.runId,
      logFile: `midscene_run/logs/${packet.runId}.jsonl`,
      experienceEnabled: false,
    });
    context.drawImage(bitmap, 0, 0);
    element('backend').textContent =
      '历史离线回放 · 独立模拟器 · 不调用 Jev / Agent · 不改变正式游戏或原始日志';
    element('status').textContent =
      packet.phase === 'complete'
        ? '回放完成；已停在历史终态，未开始新局。'
        : playing
          ? '正在回放历史记录'
          : '回放已暂停';
    const phase = {
      before: '动作前，等待回放',
      action: '动作执行中/执行后',
      automatic: '游戏自身自动过场（不调用模型）',
      after: '动作与相关过场结束',
      complete: '历史终态',
    }[packet.phase];
    element('replay-progress').textContent =
      `已执行 ${packet.count}/${packet.total} · 第 ${packet.decisionIndex + 1} 次决策（日志索引 ${packet.decisionIndex}） · 输入帧 ${packet.inputFrame} → 画面帧 ${packet.frame}/${packet.totalFrames} · ${phase}`;
    element('replay-position').max = packet.total;
    element('replay-source').textContent = JSON.stringify(
      {
        runId: packet.runId,
        logSHA256: packet.logSHA256,
        pixelSHA256: packet.pixelSHA256,
        frame: packet.frame,
        decisions: packet.count,
        reconstructions: packet.reconstructions,
      },
      null,
      2,
    );
    element('play-mode').textContent =
      '输入和问题来自该动作执行前的历史记录；画面展示其执行过程及后续自动过场。暂停后可完成当前决策、查看下一决策或定位任意已执行决策数。';
    element('replay-notice').textContent =
      `只重放实际执行的动作；未执行的失败/取消请求不进入播放序列。未记录的信息不推测，概率不是通关成功率，不展示或编造内部推理。${
        packet.reconstructions.length
          ? ` 本局包含重建转移：日志索引 ${packet.reconstructions.map((item) => item.index).join('、')} 的动作按已执行事实重放一次。重建不是原 live 快照，不能声称与丢失的 live 快照逐字节对照；本次通关包含维护暂停和局中策略修改。`
          : ''
      }`;
    if (packet.history)
      element('history-request').textContent = JSON.stringify(
        replayHistory.requestState,
        null,
        2,
      );
    if (packet.phase === 'complete') playing = false;
    replayButtons();
  } finally {
    bitmap.close();
  }
}

async function replayCommand(command, extra = {}) {
  if (replayBusy) throw new Error('上一回放操作尚未完成。');
  replayBusy = true;
  replayButtons();
  try {
    const data = await api('/api/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        token: replay?.token,
        knownDecision: replayHistory?.index,
        ...extra,
      }),
    });
    if (command === 'close') {
      replay = null;
      replayHistory = null;
      viewGeneration++;
    } else await showReplay(data);
  } catch (error) {
    stopPlayback();
    throw error;
  } finally {
    replayBusy = false;
    replayButtons();
  }
}

function stopPlayback() {
  playing = false;
  clearTimeout(replayTimer);
  replayButtons();
  if (replay && replay.phase !== 'complete')
    element('status').textContent = '回放已暂停（在途画面返回后停稳）';
}

async function playbackTick() {
  if (!playing || !replay) return;
  const started = performance.now();
  const before = replay.frame;
  const speed = Number(element('replay-speed').value);
  try {
    await replayCommand('tick', { frames: Math.min(60, 4 * speed) });
    if (playing)
      replayTimer = setTimeout(
        playbackTick,
        Math.max(
          0,
          ((replay.frame - before) * 1000) / (60 * speed) -
            (performance.now() - started),
        ),
      );
  } catch (error) {
    element('error').textContent = `回放错误：${error.message}`;
  }
}

element('replay-open').addEventListener('click', () =>
  act(async () => {
    viewGeneration++;
    replayHistory = null;
    playing = true;
    await replayCommand('open');
    replayTimer = setTimeout(playbackTick, 1200);
  }),
);
element('replay-toggle').addEventListener('click', () => {
  if (playing) stopPlayback();
  else {
    playing = true;
    replayButtons();
    if (!replayBusy) playbackTick();
  }
});
element('replay-step').addEventListener('click', () =>
  act(async () => {
    stopPlayback();
    await replayCommand('step');
  }),
);
element('replay-seek').addEventListener('click', () =>
  act(async () => {
    stopPlayback();
    const position = Number(element('replay-position').value);
    if (!Number.isInteger(position) || position < 0 || position > replay.total)
      throw new Error(`定位范围为 0 至 ${replay.total} 的整数。`);
    element('status').textContent = '正在从历史记录定位；正式游戏保持不变…';
    await replayCommand('seek', { position });
  }),
);
element('replay-close').addEventListener('click', () =>
  act(async () => {
    stopPlayback();
    await replayCommand('close');
  }),
);
element('replay-speed').addEventListener('click', () => {
  const button = element('replay-speed');
  button.value = { 1: '4', 4: '16', 16: '1' }[button.value];
  button.textContent = `速度：${button.value}×`;
});
refresh();
