# Local Jev Mario

[中文](./README.zh.md)

A real NES emulator → SMB1 RAM → object-centric JSON → local Jev-compatible
endpoint → Gemma → controller loop. No Midscene vision, model screenshots,
cloud API keys, bundled Nintendo ROMs, artwork or music.

This standalone repository was extracted from `imink/midscene`'s
`examples/local-jev-mario`. Branch `gemma-baseline` preserves the working
Gemma/Jev implementation; model integrations live on separate branches.

## Run

Use Node.js 24+, pnpm 9.3.0+ and your own lawfully obtained Super Mario Bros
`.nes` file. This example has an isolated pnpm workspace; no Midscene build is required.

```bash
cd ~/code/local-jev-mario
pnpm install --frozen-lockfile
pnpm start
```

Open **http://127.0.0.1:4174**, select your `.nes`, load it, then choose a single
decision or start the agent. Extract ZIP archives locally first. Browser uploads
stay in process memory: the server neither persists nor serves the ROM, and the
model receives only structured state. Alternatively:

```bash
MARIO_ROM="/absolute/path/to/Super Mario Bros.nes" pnpm start
```

In the development worktree, the user-supplied Europe Rev A attachment was
extracted to the Git-ignored `midscene_run/roms/user-supplied.nes`.
That file is **not part of the source distribution**. In that worktree:

```bash
MARIO_ROM=midscene_run/roms/user-supplied.nes pnpm start
```

The default port avoids the existing service on 4173. A port conflict fails
explicitly and never stops another process. If depot_tools shadows `pnpm`, use
`corepack pnpm`. If Corepack downloads fail under local network settings, use
an official pnpm 9.3.0+ executable rather than changing shared Python/model environments.

## Local inference

The default reuses `http://127.0.0.1:8766/v1/systemone`:

```bash
curl http://127.0.0.1:8766/health
pnpm probe
```

`probe` submits **synthetic RAM state** to real Jev/Gemma. It verifies the
protocol, not gameplay. To verify your ROM → RAM → real model → emulator:

```bash
MARIO_ROM="/absolute/path/to/game.nes" pnpm smoke
# Optional SMOKE_DECISIONS=20; default 3. Completion is never guaranteed.
```

Only if no existing Jev server is running, start the included compatible adapter:

```bash
GEMMA_BASE_URL=http://127.0.0.1:8765/v1 pnpm jev
```

It discovers the single loaded model through `/models`. Set `GEMMA_MODEL` to an
exact loaded ID if there are multiple models. Requests use `temperature: 0`,
`enable_thinking: false`, `stream: false`, `max_tokens: 768`, a strict JSON
schema, and validated answers. To use another free adapter port, set `JEV_PORT`
and point the game at it using `JEV_BASE_URL`.

Do not load a second Gemma instance if one is already running. If needed, start
your existing MLX-VLM installation with a locally available model:

```bash
HF_HUB_OFFLINE=1 /path/to/venv/bin/python -m mlx_vlm.server \
  --model /absolute/path/to/local-model --host 127.0.0.1 --port 8765 --max-tokens 768
```

Jev here is a **typed protocol adapter**, not a second model or the official
TypeSafe/Jev SDK. Gemma performs inference. The compatible protocol supplies
Choice and Noul, not action probabilities, confidence or Score. Those fields
are shown as unavailable; Noul is a belief, not a calibrated probability.

## Behavior and compatibility

- Starts world 1-1 by pressing START; no RAM patches or injected save states.
- Requires mapper-0 iNES 1.0, 32 KiB PRG, 8 KiB CHR, no trainer (40976 bytes).
  The parser targets the original SMB1 layout. World is the target layout;
  the user-supplied Europe Rev A ROM has been exercised with real model decisions.
  **JSNES uses NTSC timing: European ROMs run in compatibility mode, not
  cycle-accurate 50 Hz PAL emulation.** The header cannot reliably identify the
  game or region; other games, ROM hacks and multicarts are unsupported.
- Seven actions: `noop`, `right`, `right_jump`, `right_run`,
  `right_run_jump`, `jump`, `left`. Each holds the selected buttons for
  `FRAMES_PER_DECISION` frames (default 16, range 1–60). This is an emulator-frame
  interval, not inference requests per second.
- Emulation freezes during inference. Wall-clock latency contributes zero
  reaction frames. Choice directly determines the macro; there are no recovery
  overrides, forced jumps or automatic A-release frames. A new takeoff requires
  the model to choose a non-A action first. Noul is display-only.
- State contains player, trajectory, visible enemies and projections, merged
  terrain rectangles/possible gaps, last grounded preview, reaction timing,
  previous control and episode progress. Raw tile grids are not model inputs.
  Coordinates are pixels, positive Y down. Small Mario's top is corrected from
  the game's 32-pixel anchor. Only visible geometry is trusted; nonzero collision
  tiles are potential solids and constant-velocity enemy projections are estimates.
  `imminentCollision` is a geometric warning using relative velocity, a 16-pixel
  horizontal collision width and the next macro plus 16 preparation frames;
  it is not a model Score. The prompt prioritizes avoidance, but code never
  substitutes a different action for the model's Choice.
- Each decision also receives seven current-state physics forecasts from an
  isolated emulator copy. `next` predicts the selected 16-frame interval;
  `held` predicts holding the same buttons for 60 frames.
  Entries are `[forward displacement, y, phase]`; each option also states
  whether a new jump will be armed after Next. No forecast
  advances/rewinds the live emulator, selects an action, or uses prior episodes.
  Forecasts are bound to their corresponding Choice descriptions. All seven
  options remain available, including predicted deaths; no choice is filtered
  or overridden.
  If Next survives but Held dies, each possible follow-up is simulated from
  Next. The option is marked `TRAP` when all seven follow-ups die within another
  interval. Absence of this warning does not guarantee safety beyond the horizon.
  Longer predictions assume no replanning; they are not guarantees about a
  future sequence of different model choices.
- Death, flag/completion or `MAX_DECISIONS` (default 3000) ends the run. No
  automatic restart. Pause aborts pending inference and discards late answers;
  restart creates a new run. Model, parse, ROM and log failures are explicit and
  stop execution without fallback actions.
- NES framebuffer is rendered locally on Canvas, without audio. Developer UI
  screenshots are not sent to Jev/Gemma.

## Logs, configuration and isolation

### Compact model input

Full telemetry remains local and existing episode records are not deleted. Only a compact projection is
sent: omit scores, UUIDs and repeated descriptions; encode terrain rectangles
as `[left,top,right,bottom]` and deduplicate current/grounded-preview geometry.
Retain all current visible enemies/surfaces, unknown values, vertical motion,
head-bump/landing/button-release facts and the 16-frame action interval.
When experience is enabled, choose the nearest relevant failure and one progress record, each limited to
four nearby segments plus the actual ending action, so intermediate excerpts
are not mistaken for the cause of a later death. Consecutive same-action level movement/stalls are merged
with counts; bumps, landings and button changes remain separate. Excerpts state
how many decisions were omitted; partial progress never becomes completion.
Stored experience files are not trimmed.

The dashboard shows actual service-reported input tokens, before/after state
character counts and the latest compact input. JSONL request events retain full
telemetry; choice events include the exact projected `modelInput` and
`modelQuestions`, including the per-option physics forecasts. This changes
neither the model/sampling settings nor fixed cadence or paused-inference control.

### Cross-episode experience

**Disabled by default:** each episode runs independently without reading or
writing cross-episode memory. Existing files are left untouched.
Set `USE_EXPERIENCE=1` to opt into the behavior below; `USE_EXPERIENCE=0`
keeps it disabled.

Death, completion, decision limits and manual restart persist up to 12 recent
actual actions with positions, head bumps, landings and held-jump facts in
`midscene_run/experience/<ROM SHA-256>/frames-<interval>/`. Saved experience survives
both episode and server restarts. Statistics use the latest 64 episodes; near a
previous failure retrieval offers up to two failed sequences and one sequence
with further progress, compacted as described above before sending to the model
to inform different takeoff timing, speed or button release.
Partial progress is never labeled completion; cancelled inference invents no actions.

This is **persistent context memory, not weight training**. Gemma's Choice still
determines every action. Improvement is not guaranteed and restart remains manual.
8-frame and 16-frame experiences are isolated; older JSONL logs are not auto-imported.
Jump direction now uses RAM vertical speed rather than labeling all jumping as rising.
Corrupt memory or failed writes explicitly stop the run when memory is enabled.
Use the default `USE_EXPERIENCE=0` for independent episodes without deleting files.

`midscene_run/logs/<run-id>.jsonl` records the ROM SHA-256 (not its bytes),
decision inputs, raw model answers, actions, actual advanced frames, resulting
states, errors and cancellations. Adapter logs are in `midscene_run/jev/`;
synthetic probes are in `midscene_run/probes/`. All are ignored by Git.
Never commit or redistribute your ROM.

| Variable | Default |
| --- | --- |
| `GAME_PORT` | `4174` |
| `MARIO_ROM` | Unset; select a `.nes` in the page |
| `JEV_BASE_URL` | `http://127.0.0.1:8766` |
| `FRAMES_PER_DECISION` | `16` |
| `MAX_DECISIONS` | `3000` |
| `USE_EXPERIENCE` | `0`; `1` explicitly enables episode memory |
| `JEV_PORT` (included adapter) | `8766` |
| `GEMMA_BASE_URL` (included adapter) | `http://127.0.0.1:8765/v1` |
| `GEMMA_MODEL` (included adapter) | Single model from `/models` |

Servers bind only to `127.0.0.1`, reject wrong Host headers, cross-origin writes
and cross-site subresource reads. Model requests allow only numeric HTTP loopback
addresses (`127.0.0.1` / `[::1]`), with redirects disabled. `localhost` and custom
hostnames are deliberately rejected to avoid DNS rebinding.
Package installation needs a registry; runtime does not need a cloud service.
An existing adapter is a trusted local service and remains responsible for its
own upstream configuration.

## Verification

```bash
# Inside the example: no model or Nintendo ROM required
pnpm test

# From repository root
pnpm test
pnpm run lint
```

Tests cover RAM/terrain, typed protocol, loopback enforcement, HTTP bridge,
cancellation/concurrency, errors, terminal handling, logs, and actual JSNES
execution of an original tiny 6502 homebrew fixture. That program contains no
Nintendo code/assets and is not evidence of Mario gameplay.
`pnpm smoke` is the user-ROM + real-local-model check, with observed moves and
progress recorded to JSONL. A short smoke run does not establish level completion.

This worktree has completed one real **world 1-1 flagpole run** with the supplied
Europe Rev A ROM, local Jev/Gemma, experience disabled and 16-frame decisions:
138 model decisions, 2194 live emulator frames, `clear=true`, `x=3161`, no deaths
and all three lives remaining. The local-only evidence is
`midscene_run/logs/d10d0a8a-6dea-47d4-9463-345dd46eb890.jsonl` (not distributed).
Every applied action matched the raw model Choice; independent step-by-step ROM
replay also matched all positions and the terminal state. This does not guarantee
that every future model run will clear the level.

## Attribution and licensing

Architecture inspired by [fhshaik/typesafe-mario](https://github.com/fhshaik/typesafe-mario),
examined at `ca22449ed187118d19326d1f54b01b6636578aa4`. That revision declares
no license, so **none of its code, prompts or tests were copied**. This is an
independent implementation informed by its architecture and factual RAM addresses.
RAM facts were also checked against
[gym-super-mario-bros](https://github.com/Kautenja/gym-super-mario-bros/blob/master/gym_super_mario_bros/smb_env.py);
its game-resource-bearing dependencies were not installed.

[JSNES 2.1.0](https://github.com/bfirsh/jsnes/tree/v2.1.0) is Apache-2.0 licensed;
its license is installed with the npm dependency. Its source is not vendored here.
New example code follows this repository's license. Super Mario Bros and game
assets belong to their respective rights holders; this project provides no ROM source.
