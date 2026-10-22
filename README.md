# Local This-That Mario

[中文](./README.zh.md)

Real NES emulator → SMB1 RAM / structured state → local
[`flock-io/this-that-model-1.2`](https://huggingface.co/flock-io/this-that-model-1.2)
→ controller. The model scores seven declared actions in one forward pass,
without generating text. No screenshots, cloud inference, API keys, scripted
action overrides, or bundled Nintendo assets.

## Branches

This standalone repository was extracted from `imink/midscene`'s
`examples/local-jev-mario`.

- `gemma-baseline`: the previous working Gemma + Jev-compatible adapter.
- `this-that-local`: the native local decision-model integration described here.

Before switching branches, stop servers started **from this repository**.
The original worktree and its servers on 4174/8766/8765 are independent and
do not need to be stopped. Nothing is pushed automatically.

## Setup

Requires Node.js 24+, pnpm 9.3.0+, Python 3.12, uv, and your own lawfully
obtained Super Mario Bros `.nes` file. Apple Silicon uses MLX float16;
the checkpoint is approximately 3.76 GB, without quantization.

```bash
cd ~/code/local-jev-mario
git switch this-that-local
pnpm install --frozen-lockfile
uv sync --frozen --python 3.12
pnpm download:model
```

Dependencies live in `node_modules/` and `.venv/`; weights live in the ignored
`models/this-that-model-1.2/`. Setup downloads public packages and weights.
Gameplay loads only local files, with Hugging Face and Transformers forced
offline. It does not modify the existing Gemma environment.

If depot_tools shadows `pnpm`, use `corepack pnpm` or an official standalone
pnpm binary. The checked-in Python lockfile pins the tested dependencies;
the MLX stack matches the host's known-compatible versions rather than an
unverified newer release.

## Run

Terminal 1, from the repository:

```bash
pnpm model
```

After it prints `Ready`, terminal 2:

```bash
curl http://127.0.0.1:8767/health
MARIO_ROM="/absolute/path/to/your/game.nes" pnpm start
```

Open **http://127.0.0.1:4175** and click **启动 Agent**. Alternatively, omit
`MARIO_ROM`, select a local `.nes` in the page, and load it. Extract ZIPs
locally first. Browser uploads stay in memory; the server does not persist,
serve, or send the ROM to the model.

On the development machine only, the user-supplied ROM is privately available
at ignored `midscene_run/roms/user-supplied.nes`:

```bash
MARIO_ROM=midscene_run/roms/user-supplied.nes pnpm start
```

Neither the ROM nor model weights are committed. A missing ROM/checkpoint,
occupied port, unavailable model, or invalid answer is an explicit error.
There is **no Gemma fallback**. The retained `local-jev.mjs` is legacy code;
its replies are rejected by this branch's game policy.

## Decisions and probabilities

`local_this_that.py` imports the upstream `TypedDecider` and its typed
System One protocol parser. It is an HTTP bridge, not a replacement model.
The seven choices and their descriptions are passed in the original order.
Choice and binary jump usefulness are answered in a **single forward pass**.

The chosen native index maps directly to `noop`, `right`, `right_jump`,
`right_run`, `right_run_jump`, `jump`, or `left`. No option is filtered,
preselected, or replaced by game code. The model's full distribution is
validated and displayed. Its `confidence` means the **selected action's
probability**, not official Jev confidence or the probability of clearing
Mario. It has not been calibrated on this game. Noul is the model's
probability for the `yes` label; it never controls the game. Score is not
requested.

The classification temperature is 1.0, following the native API; this is
not Gemma's generation-temperature setting. Output tokens are genuinely
zero. Input token counts come from the actual native prompt builder.
Oversized state/prompt inputs fail explicitly rather than being truncated.

Before each decision, isolated emulator copies forecast all seven actions:
the next decision interval, holding the action for 60 frames, and whether
a fresh jump will be armed. If an action survives the first interval but
dies when held, all seven follow-ups are also checked for one interval;
`TRAP` means all those short-horizon follow-ups die. These are current-state
physics facts supplied to the model, not a search-selected controller.
Absence of a trap flag does not guarantee longer-term safety.
This branch sends those facts in a structured `outcomes` table alongside
the compact game state. The model applies the survival/progress priorities;
the application does not compute a winning action. An initial prose-input
trial stalled at x434; testing the same state with the structured table
produced the jump needed to clear the pipe.

## Game behavior

- Starts at world 1-1 through the normal START sequence, without RAM edits.
- Supports original mapper-0 iNES SMB1: 32 KiB PRG, 8 KiB CHR, no trainer,
  40976 bytes. World-layout telemetry and the supplied Europe Rev A have
  been exercised; ROM headers alone cannot identify arbitrary games or hacks.
- **JSNES uses NTSC timing. Europe Rev A runs compatibly, not with accurate
  50 Hz PAL timing.** The local framebuffer is displayed without audio.
- Defaults to 16 emulator frames per decision, not 16 decisions per second.
  Emulation pauses during inference. Holding A through landing does not
  rearm a new jump; the model must choose an action without A.
- Death, flagpole/clear, and the decision limit stop the agent. It never
  automatically restarts. Pause cancels and discards late answers.
- Cross-episode experience is **off by default**: no previous episode is
  read or saved. `USE_EXPERIENCE=1` explicitly enables bounded factual memory,
  not weight training; existing history is otherwise left untouched.

## Configuration and evidence

| Variable | Default |
| --- | --- |
| `GAME_PORT` | `4175` |
| `THIS_THAT_BASE_URL` | `http://127.0.0.1:8767` |
| `MARIO_ROM` | None; upload a local `.nes` |
| `FRAMES_PER_DECISION` | `16`, range 1–60 |
| `MAX_DECISIONS` | `3000` |
| `USE_EXPERIENCE` | `0` |

Change the model port with `pnpm model --port 8768`, then set
`THIS_THAT_BASE_URL=http://127.0.0.1:8768` for the game.
Both servers bind only `127.0.0.1`, check Host/Origin, and reject cross-site
requests. Runtime model URLs allow only numeric HTTP loopback addresses;
redirects, DNS hostnames, and credentials are rejected.

`midscene_run/logs/<run-id>.jsonl` records full telemetry, exact compact model
input and question descriptions, native model identity/distributions,
the applied action, subsequent coordinates, and errors. All runtime data
is Git-ignored. Model failures stop play rather than producing default actions.

```bash
pnpm run lint
pnpm test
pnpm run test:python
pnpm probe
MARIO_ROM=midscene_run/roms/user-supplied.nes SMOKE_DECISIONS=20 pnpm smoke
```

Unit tests need neither model weights nor Nintendo ROMs. They include a
small original 6502 fixture running in real JSNES. `probe` uses synthetic
RAM with the real model; `smoke` uses the user's real ROM and real model.
Neither a mock pass nor a short smoke proves level completion.

The **Gemma baseline**, not this model, previously cleared 1-1 without
experience in 138 decisions / 2194 frames, ending at x3161 with all three
lives. Its local evidence is
`midscene_run/logs/d10d0a8a-6dea-47d4-9463-345dd46eb890.jsonl`.
Do not attribute that result to This-That.

**Verified This-That run:** `59adc974-09de-4850-9c3e-0011cb220ccf` cleared
1-1 with the supplied Europe Rev A ROM, experience disabled, and 16-frame
decisions. It took **87 decisions, 1388 emulator frames, and 85.02 seconds**
from the first request to the final transition. Mean decision HTTP latency
was **511.8 ms**; all responses generated zero tokens. Final state:
`clear=true`, `dead=false`, `x=3161`, three lives remaining.

Every applied action matched the native model choice, and an independent
ROM replay reproduced all 87 player/episode transitions. Local evidence:
`midscene_run/logs/59adc974-09de-4850-9c3e-0011cb220ccf.jsonl` and
`midscene_run/verification/59adc974-09de-4850-9c3e-0011cb220ccf-audit.json`.
This is one verified successful run, not a guarantee of future completion
or a controlled benchmark against Gemma's different input/policy.

## Provenance and licensing

The project retains Midscene's MIT license. JSNES 2.1.0 is Apache-2.0;
its license ships with the installed dependency.
[FLock-io/this-that-model](https://github.com/FLock-io/this-that-model)
is MIT-licensed and pinned to
`6af11c63c8bb260aa4bed2b7717f33f25decd16e`.
The MIT checkpoint is explicitly version **1.2**, revision
`c4d1c30b8d512d278726de439b8cc81fccc70c8f`; the upstream API's default 1.0
is never used.

Architecture was inspired by
[fhshaik/typesafe-mario](https://github.com/fhshaik/typesafe-mario),
revision `ca22449ed187118d19326d1f54b01b6636578aa4`. That revision declared
no license: no source, prompts, tests, or game assets were copied from it.
SMB1 RAM-address facts were also checked against
[gym-super-mario-bros](https://github.com/Kautenja/gym-super-mario-bros/blob/master/gym_super_mario_bros/smb_env.py);
that dependency is not installed. Nintendo names and game resources belong
to their respective owners. This project supplies no ROM acquisition path.
