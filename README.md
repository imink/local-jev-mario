# Jev Mario: local or official API

[中文](./README.zh.md)

Real NES emulator → SMB1 RAM / structured state → local
[`flock-io/this-that-model-1.2`](https://huggingface.co/flock-io/this-that-model-1.2)
→ controller. The model scores nine declared actions in one forward pass,
without generating text. This remains the default, local-only backend.
An explicit `jev-official` backend uses TypeSafe's hosted Jev decision model.
Neither mode sends screenshots or ROM data, overrides model actions, or bundles
Nintendo assets in the repository. Official mode sends structured game state to TypeSafe and
requires an API key.

## Browser-only Cloudflare site

The separate static edition is published with Cloudflare Pages at
**https://jev-mario.pages.dev**. The user-corrected custom-domain target is
**https://jev-mario.zoink.site**; its DNS and certificate must be active before
that hostname is considered deployed.
It does not connect to the local Node game or expose a live Jev endpoint.
The private GitHub repository does not need to become public.

Click **Load ROM** to download the hosted game from Cloudflare, then click
**Start game** for manual play or **Replay** for the recorded campaign.
Loading does not start a game automatically. Both controls stay disabled until
the ROM passes format and SHA-256 checks; failed downloads remain explicit errors.
The publisher confirmed public hosting/distribution authorization for this ROM.
Each build requires an explicit authorization flag and a private source file;
the ROM is deployed to Cloudflare but is not committed to Git.
The optional **Import local ROM instead** reads a lawfully obtained `.nes` with
`File.arrayBuffer()` in this tab only, without uploading it. The app has no model
request, account, cookie, or analytics. Cloudflare receives ordinary site and ROM
download requests and may retain infrastructure logs.
The recorded campaign requires the exact Europe
Rev A SHA-256 shown in the provenance panel. Other supported SMB1 revisions can
be used for manual play. JSNES uses NTSC timing; sound is disabled.

- Replay starts at 1-1 and includes all **6275 actual Choices and 486 automatic
  transitions**, ending at frame 113645 after all 32 stages. Pause/resume,
  next-decision, and 0.5×/1×/4×/16× are available; achievable speed depends on the device.
- Use the language button at the top right to switch between Chinese and English.
  It updates interface labels and status messages without resetting the game,
  replay position or speed. Original decision records remain untranslated.
- The actual saved model input, questions, and answer fields are shown, not
  invented internal reasoning. Missing confidence/Score stays missing.
- Manual mode starts an independent game. Focus the canvas: arrows move,
  Z/Space jumps, X runs, Enter is Start, right Shift is Select. Losing focus,
  hiding or leaving the page releases buttons and pauses manual play.
- Physical state is checked at every replay boundary, with a SHA-256 check of
  the final framebuffer. The lost original live snapshot at index 3944 and its
  deterministic reconstruction are explicitly disclosed. The original campaign
  included maintenance and policy changes; this is not a new unattended AI run.

Only Node 24+ and pnpm are needed to build this edition; no Python/model setup:

```bash
pnpm install --frozen-lockfile
MARIO_ROM_DISTRIBUTION_AUTHORIZED=true \
MARIO_PUBLIC_ROM=midscene_run/roms/user-supplied.nes \
MARIO_REPLAY_LOG=midscene_run/logs/0e61deb0-42bd-4d6d-b554-87c6fa187020.jsonl pnpm build:static
pnpm preview:static
```

The local preview is **http://127.0.0.1:4180**, separate from the frozen game on
4175. The source campaign remains private and must be available locally to
build; a fresh clone alone does not include it. Missing or changed campaign
data is an explicit build error, not an empty replay. The authorized ROM source
is also required. Owning a game copy alone does not grant public distribution rights.

`scripts/public-history.mjs` exports a fixed whitelist of gameplay fields,
instructions, and answer values after checking the original log hash. Unknown
input fields, nonempty memory, sensitive strings, and mismatched Choices fail
the build. Requests, headers, credentials, account metadata, raw logs,
screenshots, and NES snapshots are not copied. The authorized ROM is separately
validated against the campaign hash and copied only to `rom/game.nes`.
The 53 hash-checked JSON chunks
total about 31 MB uncompressed; only the current chunk is retained in memory.
`scripts/build-static.mjs` copies an explicit static file list into ignored
`.cloudflare/site/`; only that directory is deployed. Build output and the
original local evidence are not committed.

For deployment, first authorize the account that owns `zoink.site`:

```bash
./node_modules/.bin/wrangler login
./node_modules/.bin/wrangler whoami
```

Alternatively provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through
the environment, never source control. Authorization must permit this account's
Pages deployment and custom-domain operations. DNS editing requires separate
permission; a standard Wrangler OAuth login does not necessarily grant it.
Before publishing, inspect that account's existing `jev-mario` Pages project and
the exact `jev-mario.zoink.site` DNS/custom-domain records. Do not overwrite an
unrelated resource; resolve any conflict with its owner first. Do not change
the root domain or other subdomains. Then:

```bash
WRANGLER_SEND_METRICS=false pnpm deploy:static
```

`cloudflare-pages/wrangler.jsonc` publishes only `.cloudflare/site/` to the
`jev-mario` Pages project, with `this-that-local` as its production branch.
`deploy:pages` is an explicit alias for the same deployment. The root
`wrangler.jsonc` is for local static preview only, with no custom-domain route.
Pages deploy has no dry-run option; validate the allowlisted build and tests
before uploading.

Associate `jev-mario.zoink.site` in the project's **Custom domains** settings
before adding its DNS record. If DNS editing is not authorized for the CLI,
the zone owner must add exactly this record in the DNS dashboard:

| Type | Name | Target | TTL |
| --- | --- | --- | --- |
| CNAME | `jev-mario` | `jev-mario.pages.dev` | Auto |

DNS-only is sufficient. Do not migrate nameservers or change other records.
Wait for the Pages domain/certificate status to become active, then verify
both the returned Pages deployment URL and the custom domain over HTTPS.
A working `pages.dev` URL is not proof of custom-domain activation.
No anonymous temporary account is used. The preview/deploy scripts explicitly disable Wrangler's
automatic `.env`/process-environment binding import, so the local Jev key never
becomes a Worker binding. Do not replace these scripts with an unconfigured
`wrangler dev` in the repository root.

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

## Official Jev API

### Watch a recorded run

On **http://127.0.0.1:4175**, **回放本局（从 1-1 开始）** starts an
isolated, offline replay of the loaded run. The live game must be stopped,
without an in-flight or partially journaled action. Use **暂停回放 / 继续回放**,
**下一决策**, or enter an executed-decision count and **定位并暂停**.
Position `0` is the opening screen. Stepping finishes the current decision
and its automatic transitions; at a decision boundary it advances one decision.
Playback speeds are 1×, 4× and 16×, excluding historical inference waits.
**返回正式游戏** leaves the original game exactly where it was.

The screen and history are returned together. The displayed input/questions
describe the action's **pre-action** frame; the screen shows that action's
progress and subsequent native transitions. Raw recorded responses, Choices,
probabilities, full historical inputs and current replay RAM are inspectable.
Missing values remain missing: this is not a model reasoning transcript.
Unexecuted failed/cancelled attempts are not playback actions. Reconstructed
transitions retain their provenance warning, including the lost original live
snapshot at log index 3944 in the audited campaign. That campaign included
maintenance pauses and in-run policy changes, not a frozen-policy experiment.

Replay never calls a model or the Agent, never writes the source log, and
never sends the ROM to the browser. It indexes the log once, reads only the
selected historical records, streams bounded PNG frames, and retains at most
12 seek checkpoints. One replay session is active per server; opening another
invalidates the previous tab's replay token. Live mutations and service checks
are disabled until replay is exited. A changed/corrupt log explicitly stops
playback. Seeking far ahead can take about a minute while frames are rebuilt.
If an old tab reports an expired replay session, reload it before opening replay again.

The local audited run is `0e61deb0-42bd-4d6d-b554-87c6fa187020`
(6275 decisions, 113645 frames, 32/32, one life). If its server has been stopped,
restore the **finished** run without creating a new run or modifying its log:

```bash
DECISION_BACKEND=jev-official TYPESAFE_ENV_FILE=.env USE_EXPERIENCE=0 \
MARIO_ROM=midscene_run/roms/user-supplied.nes \
RESTORE_TERMINAL_RUN=0e61deb0-42bd-4d6d-b554-87c6fa187020 pnpm start
```

Do not launch a second server on the occupied port. Restoration checks every
recorded transition against an independent NES instance before serving the
frozen terminal; no inference is requested and no Agent is started. The private
ROM and historical log must already exist locally; neither is distributed.
This terminal-restoration path requires cross-run experience to have been disabled.
The victory image is the native victory trigger, not a newly advanced ending.

### Enable official inference

No local model process or Python environment is needed for official mode.
Install the Node dependencies, then supply a private `.env` containing
`TYPESAFE_API_KEY`. The file is parsed as data, never executed or copied:

```bash
DECISION_BACKEND=jev-official \
TYPESAFE_ENV_FILE="/absolute/path/to/private/.env" \
MARIO_ROM="/absolute/path/to/your/game.nes" pnpm start
```

Alternatively provide `TYPESAFE_API_KEY` through the process environment.
If `TYPESAFE_ENV_FILE` is set, its key takes precedence; a missing file or key
fails explicitly. Do not paste keys into command arguments, source, or logs.
Open the same local dashboard at **http://127.0.0.1:4175** and start the agent.
The default model is pinned to `jev-1.14.0`; `JEV_MODEL` can explicitly select
another published version, `jev-latest`, or `jev-preview`. Aliases can change;
each decision records the model ID actually returned.

Only `https://api.typesafe.ai/v1/systemone` and `/v1/models` can receive the key,
in a server-side Bearer header. Redirects are rejected. The browser never
receives the key. Request errors stop the agent; there are no retries, votes,
fallback models, or replacement actions. Local mode retains numeric-loopback-only
requests. Switching backend requires a server restart; the dashboard cannot
change the endpoint or credentials.
Non-success responses retain a redacted provider type, code and explanation
in the stopped-agent error and JSONL log. The diagnostic reader buffers at most
4096 bytes, makes at most 64 stream reads and has a 2-second deadline. Only selected JSON fields, plain text,
or an HTML title are eligible; raw response headers and other object fields are
never recorded. Credentials and sensitive-field lines are redacted before
field-length limits are applied. Oversized, unreadable, malformed or timed-out
bodies have explicit diagnostic status instead of an invented explanation.
This never retries the request or weakens the original HTTP failure.
Earlier discarded response bodies cannot be recovered by this change.
Official requests use `Connection: close` so a pooled socket is not retained
across synchronous emulator forecasts. This isolates cross-decision connection
reuse; it does not guarantee uninterrupted API availability or retry failures.
`pnpm start` sets Node's process-local address-attempt allowance to 2000 ms.
When launching Node directly, use
`node --network-family-autoselection-attempt-timeout=2000 server.mjs`.
This leaves later DNS addresses time within Node 24's unchanged approximately
10-second fetch connection budget; a 10-second per-address allowance can consume
nearly that entire budget on the first address. The overall request limit remains
125 seconds. Address fallback happens before sending HTTP, not by retrying a
decision. DNS, the official hostname, SNI and certificate verification are unchanged;
no service IP is pinned. This fixes the budget conflict, not every possible
network failure, and successful health checks alone do not prove reliability.

The same nine actions, structured facts, forecast budgets, and continuous
32-stage goal are retained. Choice and Noul are requested together. Official
Choice `confidence` is **not** the selected action's probability; both are
displayed separately without fabricating missing values. Neither is a promise
of clearing Mario. Official probabilities are rounded to hundredths and can sum
to 0.99 rather than 1. The parser accepts this only when the per-option rounding
intervals admit a unit total; it preserves the returned numbers and Choice,
without renormalizing or changing local-backend validation.
The live API has also returned a Choice that was not the probability maximum.
For a valid nine-option distribution and a declared action, the official Choice
remains authoritative: a visible warning and the log preserve that disagreement,
without choosing the maximum instead or retrying. Malformed answers still stop
the agent; local-backend coherence checks remain strict.
A campaign continued from a local-model prefix is mixed-backend
evidence, not an official-Jev-only completion.

Use the same environment variables with `pnpm probe` for a synthetic protocol
check or `pnpm smoke` for a separate short ROM run. Neither proves 32-stage
completion. Official API calls are billed by TypeSafe.

Protocol sources: [System One](https://docs.typesafe.ai/api/system-one),
[models](https://docs.typesafe.ai/models), and
[confidence](https://docs.typesafe.ai/confidence).

## Decisions and probabilities

`local_this_that.py` imports the upstream `TypedDecider` and its typed
System One protocol parser. It is an HTTP bridge, not a replacement model.
All nine choices and their descriptions are passed in declaration order.
Choice and binary jump usefulness are answered in a **single forward pass**.

The chosen native index maps directly to `noop`, `right`, `right_jump`,
`right_run`, `right_run_jump`, `jump`, `left`, `down` (enter a pipe), or
`left_jump` (hold left and A together to jump back over obstacles).
No option is filtered,
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

Before each decision, isolated emulator copies forecast all nine actions:
the next decision interval, holding the action for 60 frames, and whether
a fresh jump will be armed. If an action survives the first interval but
dies when held, all nine actions are explored over two follow-up intervals,
stopping when a surviving continuation is found (48 frames total at the default).
`TRAP` means none of those short-horizon continuations survives. These are current-state
physics facts supplied to the model, not a search-selected controller.
Absence of a trap flag does not guarantee longer-term safety.
Within one synchronous forecast, complete immutable NES snapshots reuse their
V8-encoded bytes; every restore decodes a fresh copy. No CPU, PPU, APU, or
controller fields are omitted, and neither candidate sets nor search budgets
are reduced. This cache is discarded after the decision.
The predictor also looks for a surviving continuation to a grounded,
A-released decision boundary (or an engine-controlled transition) within four
search intervals, allowing at most one future controller change. The first
interval is the actual control duration; subsequent search intervals are the
smallest multiple of it that is at least 16 frames. The readiness horizon is
therefore 52, 56, or 64 physical frames for 4-, 8-, or 16-frame controls.
Readiness is inspected at every actual control boundary inside that window,
including the first action's endpoint, rather than only at the longer-interval
endpoints. Shortening control cadence must not skip a previously witnessed
landing between those endpoints.
`survivesWithOneReplan` records only that
witness's existence, never a future action to execute. Failure to find one is
not proof of a trap. This avoids treating a still-alive but doomed falling
pose, or a landing with A still held, as a useful next decision state.
Underwater, readiness uses the RAM swimming flag, restart timer and vertical
speed: A must be released, and the stroke must still be inside its restart
window or Mario must no longer be rising. The same rule applies to continuation
witnesses and current-state readiness, rather than requiring swimmers to land.
This is input eligibility, not a promise of upward displacement through terrain;
forecasts preserve the actual NES effect.
Static-ground decisions retain the configured interval (16 by default). Underwater it is
capped at 8 frames so the model can release and repress A within the swim restart
window. Forecasts, telemetry, applied frames and the dashboard use that effective
interval; the configured land interval is restored on leaving water. This changes
control cadence, not the model's chosen buttons, and does not insert repeated presses.
Grounding without a static tile underfoot also caps decisions at 8 frames,
including the ensuing jump until landing on static ground. This gives the model
more opportunities to release and repress A before a descending support drops
below a reachable landing height. It does not identify a particular platform type.
Continuation searches retain their bounded branch counts but use the longer
future intervals described above, rather than shrinking every physical window
with control cadence. Threatened readiness witnesses require two such validation
intervals, or three for a boundary before the first full future interval, so an
early boundary does not shorten the survival evidence. Maximum totals remain
84, 88, or 96 frames. At the end of this validation, the continuation must again
be ready for a choice (A released and jump/stroke available), or in a nonfatal
engine-controlled transition. A jump that merely delays death beyond the window
and ends still falling does not certify the earlier landing as a usable witness.
Failure remains unknown, not proof of inevitable death. The exhaustive short `TRAP` probe still
uses actual control intervals: failing a coarser continuation search is unknown,
not proof that no finer-control escape exists. No hypothetical continuation is
automatically executed.
Timing and distance units are intentionally distinct:

| Quantity | Unit and cadence behavior |
| --- | --- |
| First action and short `TRAP` probe | Actual control frames; the probe covers three control intervals including the first action. |
| Continuation search | Physical frames in the longer intervals above; readiness is sampled at actual control boundaries. Branch/change counts are budgets, not elapsed time. |
| Held result | Always 60 physical frames, independent of 4/8/16-frame controls. |
| Stall threshold | 180 elapsed emulator frames, checked at decision boundaries; all cadences agree at a shared observation time. |
| Movement, tile and gap thresholds | Pixels, not frames: a body length/tile remains 16 pixels. Newly restored jump readiness need not travel that distance. |
| Velocity and collision timing | Pixels per physical frame and frames to contact; projection uses the next actual control interval, with 16 additional physical frames for collision warnings. |

When a forward water hold predicts sinking below the playfield and A remains held,
the model may first be asked which viable action releases A into a stroke-ready state.
Otherwise, preferring only immediate upward motion can postpone release until the
restart window is lost, producing repeated low bounces against an underwater wall.
Within 64 horizontal pixels of an active springboard, the interval is capped at
4 frames: a 16-frame hold can skip its high-bounce input window. The springboard
is identified as a non-harmful object, not an enemy. All bounce inputs still come
from successive model choices; no timed press/release sequence is inserted.
Near the springboard, forecasts retain the highest point reached during the
hold, not just endpoints. A safe trajectory reaching the obstacle's top, or a
released-A ready state when A is held, can become the question's focus before
ordinary horizontal motion. Neither predicate guarantees a successful crossing.
If the actions have mixed readiness evidence, an available moving survival
witness (or the separate rearming fallback) takes priority over spring height.
Reaching a height alone must not hide a positively witnessed continuation.
This does not combine one hypothetical path's height with another's safety;
it asks the existing survival question instead. Without such a witness, the
height question remains a bounded opportunity, not proof of safety.
After the moving and newly rearmed priorities, an airborne action with a
preparation witness can still take priority without moving a full body length.
Near a jump apex, a 4/8/16-frame interval can move only a few pixels; that must
not discard existing continuation evidence in favor of fatal held displacement.
This fallback does not apply to stationary grounded states, and unknown
continuations remain unknown rather than becoming traps.
On a known maze approach, if no connected route landing is witnessed and a
known blockage is still ahead, an available nonblocked forward survival witness
can precede intermediate-height questions even when every action has readiness
evidence. This avoids repeatedly jumping in place and landing on the same floor.
The exception stops within the existing 64-pixel gate buffer; connected route
evidence and gate-height handling retain their original semantics.
Forecasts stop at engine-controlled transitions and identify level clears
and pipe/area entry in either horizon instead of treating the next area's coordinate reset
as backward movement.
For predicted pipe entries, the disposable copy additionally advances only
engine-controlled frames (at most 6000) to read the destination world/stage.
Entry into the current or immediately next level preserves the required sequence;
a predicted skip/backtrack prioritizes the corresponding factual question over
ordinary entry/progress, preferring a surviving non-skipping option when one exists.
All options remain available, including warp entry. The model still chooses.
No playable frames beyond the transition are simulated by this destination check.
This branch sends those facts in a structured `outcomes` table alongside
the compact game state. The application sets the question's priority/focus;
the model chooses the controller action. An initial prose-input
trial stalled at x434; testing the same state with the structured table
produced the jump needed to clear the pipe.

Navigation also retains at most four observed blocked positions **within the
current life/area**: grounded horizontal attempts ending against visible terrain.
Both directions are observed, allowing one pixel of collision-rounding difference.
These are observations, not a map proving that a route is impossible. They
are cleared on life/area changes and engine-controlled transitions. Forecasts
include vertical endpoints, movement, and whether the held endpoint repeats
one of those positions. The model can choose backward movement to find another
height instead of repeatedly pressing into a wall. All nine options remain
available; no recovery action is substituted by code. This short-lived
navigation state is separate from disabled cross-episode experience.
Maze gate alternatives use observed exposed tile tops at the actual reset column,
not internal seams between overlapping solid rectangles in the terrain preview.
The multi-part 7-4 maze also reports native RAM checkpoint-counter changes:
individual observed passes/failures are kept per checkpoint within this life.
An aggregate reset does not reject the last floor when an earlier checkpoint
already failed. Its final checkpoint remains unknown unless the preceding two
checks were correct. Targets use observed floor segments and feedback, not a
hardcoded route table; all controller choices remain available.
A forecast path that already fails a native checkpoint cannot reuse a later
landing as a route witness. That is a navigation failure, not a lethal `TRAP`;
the physical survival/readiness horizons are unchanged.
After 180 physical frames without forward progress, an unresolved native
checkpoint can instead focus on obtaining new attributable feedback. A held
forecast may predict a failed standing-floor check and a reset; this goal is
explicitly information gathering, never a successful route or a lethal trap.
Already observed heights, ambiguous aggregate failures and airborne checks do
not count as new floor feedback. Safety priorities and all nine choices remain.
If the native counters already prove an earlier check failed, a separate goal
can advance toward the engine's natural loopback instead of avoiding it forever.
This never restarts the campaign, restores time/lives, or assigns that aggregate
failure to the final floor.
After 180 land frames without a new furthest position, a surviving continuation
with at least 16 horizontal pixels in the next or held interval can become the focus.
Held-only displacement must end grounded on that same held path. A fatal or still
airborne held path cannot borrow a different continuation's survival witness to
claim horizontal escape; an unfinished airborne path remains unknown, not impossible.
This distinguishes genuine sideways escape from repeated jumps in place, without
requiring a particular direction or changing the model's selected action.
It does not apply underwater, where vertical strokes are necessary progress.
Run-jump focused native requests spell out both positive and negative results as
`MEETS the required condition` or `DOES NOT MEET the required condition`.
All nine options and the structured game context remain present. The model can
still choose a negative option; no filtering, retries, voting, or override hides
such a mistake.
During a land stall or after observed wall contact, visible floor segments above the last grounded feet can
become intermediate climbing targets. The same bounded landing search checks
each action against those actual segments; a witnessed higher landing can
take priority over another horizontal retreat. Mere upward motion is not proof.
When grounded without a static tile underfoot, a higher grounded landing
(at least one tile above the last supported feet) can also be a target.
This uses actual predicted landings, including moving platforms, instead of
treating a descending platform as an indefinitely useful ready state.
This higher-landing target also applies during a stall below observed higher
floors: a moving platform can provide an intermediate step even when no
static floor exists at its height. The witness still requires actual grounding,
not just passing through the target height.
Wall contact is recorded even when a directional attempt lands against the wall,
so alternating jumps cannot hide the obstruction. Climbing probes may additionally
release or redirect after the future jump, allowing preparation, jumping, then
landing control within the same four-interval budget. This extra change applies
to climbing witnesses, not the one-change readiness or maze witnesses.
For a sustained stall before an observed gap, or non-tile support over one,
an additional mechanical probe
checks whether each candidate can prepare a running jump: hold that candidate
for its actual first interval plus up to three continuation intervals,
optionally run right for up to three continuation intervals, then
simulate up to 60 frames of running jump, optionally changing once to a
non-jump control before touchdown. This permits braking on the same path rather
than requiring a long jump hold to stop safely by itself. A landing beyond the
observed gap, including lower ground ahead of a moving platform, qualifies only
with two continuation intervals ending ready for another decision, within the
same overall frame budget. This applies equally to intermediate landings and
the 60-frame endpoint: merely being alive or briefly grounded is insufficient.
Failure to find a witness remains unknown, not a new `TRAP` classification.
The grounded
gap target remains available through retreats, run-up, and the jump, even if a
small new furthest position resets the stall clock or support changes back to
static ground. It clears after a grounded arrival beyond that target, or a
life/area change, non-playable state, swimming, or observed maze routing.
This preserves the observed goal, not a planned controller sequence.
The run-jump horizon is 160, 164, or 172 frames for 4-, 8-, or 16-frame
controls; its four preparation branches and four run-up branches remain bounded.
Release boundaries use the actual control cadence; each tries the five
non-jump controls within the remaining jump window, with no extra physical time.
The bounded probe reports
only existence (at most 172 frames with
the default interval); it never returns or executes that preparation sequence.
This is an explicit run-jump feasibility feature, not a learned planning policy.
All nine immediate actions remain available to the native model.
Hidden coin/1-up blocks (`$5f/$60`) are explicitly observed objects, not
standable floors. After an observed loop near a pipe, a bounded activation
probe requires the actual first action, a permanent used block (`$c4`), a
rearmed decision boundary and continuation on that same path. It reuses the
readiness sampling and physical budgets, including release of an already-held
jump button before a future jump and rearmed endpoint; temporary bouncing tiles and merely
being alive do not qualify. The shortest witnessed readiness time accompanies
the result. After a loop, this witnessed new support takes priority over
repeating a climb or gap landing; verified pipe entry still has priority.
This proves neither landing on the block nor entering the pipe.
Within 64 pixels of an observed hidden, activating, or used block near a pipe
after a real loop, actual control is capped at 8 frames (existing lower caps
remain). Telemetry and prediction share this geometric rule. A separate narrow
support probe preserves the actual first action, keeps at most 16 complete NES
hypotheses per sampling layer, and only explores subsequent control boundaries
whose cadence matches that rule. A positive result requires landing on a
permanent `$c4` block and remaining rearmed on that same block for at least two
physical continuation intervals (32 frames for 4/8/16-frame controls), not merely
surviving two fine samples. Preparation and validation stay within the existing
84/88/96-frame physical bounds; pruning means unknown, not `TRAP`. Its reported
duration includes validation. This stable-support evidence precedes repeated
geometry goals, but native pipe progress still comes first. No hypothetical
steering sequence is returned to or executed by the live controller.
Looped observations also retain up to 64 visible pixels behind Mario so a
revealed stepping block does not disappear just because he moved past it;
pipe preparation may consider those actually observed higher supports.
Observed enterable pipe tops retain their paired metatile identity. After an
actual same-area loop, a bounded pipe probe can test the real first action,
up to three physical continuation intervals of one steering action, then up
to 60 frames of down. Only an engine-resolved, playable destination in the
same level that is farther ahead or uses different loaded area data is a
positive transition witness; a backward return or skipped level is not.
Positive outcomes include the shortest witnessed physical time to entry,
including the actual first action. This distinguishes progressing preparation
from waiting indefinitely while an entry remains possible after future steering.
The model sees these durations; no action is selected or removed by the probe.
Automatic pipe loading remains separately capped at 6000 engine frames.
This goal can precede weaker geometric goals, but does not prove the rest of
the route and never executes the hypothetical sequence.
A directly forecast pipe return to an earlier point in the same loaded area
also remains visible to policy. Generic area-entry preference must not promote
that known return over a witnessed safe forward action; it is not a lethal trap.
Loaded-area identity comes from `AreaData` (`$e7/$e8`), not `AreaPointer`
(`$0750`): the latter can change while an entrance destination is parsed,
before Mario enters anything. Such parsing must not clear actual loop or
stall observations. Life changes and actual loaded-area changes still do.
An observed loop with no alternate floor segments is not an actionable floor
goal and must not disable ordinary gap preparation.
A witnessed landing beyond the observed gap takes priority over merely reaching
a higher intermediate platform; the latter remains a fallback when no such
forward landing is witnessed.
The stall clock resets only on a new furthest position (or life/area change),
not merely on moving right again inside the same back-and-forth loop.
Maze resets are observed from an actual large backward coordinate jump during
continuous play, not from a hardcoded castle walkthrough. A grounded reset
records the failed floor and other visible floors at that gate, within the current
life/area only. An airborne reset does not disqualify the floor beneath it:
the gate may require landing rather than a different route. Forecasts report
whether an action can land on an observed alternative floor ahead, or retreat
onto its gate-connected segment, within four decision
intervals and at most one future controller change, and whether it resets the
maze. Only those Boolean facts, never a future action sequence, guide the model's
route question. A missing witness is not proof that the route is impossible.
Visible floor tiles are retained only within this life/area to identify that
connected segment. A backward drop onto it is valid; retreating to an earlier
disconnected platform at the same height is not. An unconnected intermediate
landing must change the player's supported height: staying on the current
floor is not evidence of a route across a gap. Forward intermediate platforms
may also use a previously rejected gate height above a remaining lower route.
The observed segment is clipped to end four tiles before the gate. These height
and distance restrictions are conservative progress heuristics, not physical
reachability bounds or proof of a complete route. Rejecting a height at the gate
does not prohibit using it as a stepping stone earlier; it never becomes a valid
gate-connected landing through this exception. No level coordinates or walkthrough
are preloaded. Gate goals are cleared after passing the gate; observed tiles are
cleared when the life/area changes.
When a useful gate-connected landing is already reachable, it takes priority
over intermediate stepping stones, without removing any controller option.
The witness must accompany body-length motion or newly rearmed controls, so
doing nothing forever is not progress merely because a future escape exists.
Alternative floors are hypotheses: the model may complete a grounded attempt
that loops again, recording and excluding that floor on the next attempt.
An airborne reset remains distinct from testing a floor while grounded.
While following an observed maze alternative, mixed survival witnesses can
focus on a surviving forward step before a backward one, without discarding
either option; this avoids repeatedly retreating from a rearmable gap approach.

When forecasts disagree about immediate survival/detected traps, the request
focuses on that single Boolean fact instead of competing forward-distance
numbers. Holding an action for 60 frames is only a warning, not a requirement:
the model can change its action at the next interval. Treating every unsafe long
hold as an unsafe immediate action caused a verified loop before the 1-2 pit.
Every action still appears in the question, including
unsafe ones; the application does not sort, remove, or replace model choices.
This is rule-guided model control, not a claim that the model independently
learned an entire game policy. Focused questions improved observed unsafe
choices in local-model checks, but do not guarantee safe play.
When available, a moving continuation witness takes priority over weaker
stationary rearming. Movement is measured in the actual first interval or a
surviving held path, never from displacement occurring only on a fatal hold.
This keeps a newly rearmed short landing eligible when the alternatives merely
have large fatal held displacements. Proven traps still invalidate that witness.
Only when no moving continuation witness is available, a newly rearmed
jump/stroke boundary can become the fallback focus even when its displacement
is less than a body length. A short landing can restore control without moving
16 pixels; it does not join or displace available moving witnesses.
Already-ready stationary poses do not gain this exception, and a continuation
witness is still required.
If no action has a usable readiness witness within the short interval-based
horizon, but the existing 60-frame held forecasts disagree about survival,
the question instead focuses on surviving that longer hold without a detected
trap. This prevents short springboard intervals from discarding known braking
evidence. It does not require long-hold safety when a replan witness exists,
extend the simulation budget, or execute the hypothetical hold.
The model input states the first-action, readiness-search, and held-action
physical frame horizons separately. A missing readiness witness explicitly
means unknown within the bounded search, not that survival is impossible.
If the held action dies, a grounded/rearmed pose is insufficient on its own:
the predictor applies the same survival verification to initial and later ready
boundaries. Verification branches over all nine actions for two longer intervals,
or three for an early boundary, without shortening the physical evidence window.
Delayed A releases are also sampled at actual control boundaries: at most
`1 + 2 * continuationFrames / frames` release offsets and nine follow-up choices,
each sampled within the same three-future-interval physical window.
These finite budgets establish a bounded witness, not indefinite safety.
The candidate snapshot is restored after this check before any further search.
The single future change may also be a delayed A release within two
additional longer intervals of the original jump. Releasing immediately can shorten
the jump so it misses a moving platform; holding A until landing and then
releasing is still one change within the same four-interval budget.
Outside mixed-safety situations, entering a predicted pipe/area or moving away
from known blocked endpoints can likewise become the single question focus.
Navigation requires displacement in either the next or held endpoint of at least
one body width (16 pixels) or one body height, so tiny inertial drift is not
mistaken for escaping a blockage, and a useful swim stroke is not discarded
just because holding A longer would sink back.
A newly available underwater stroke producing upward motion is also useful,
even if its shorter next interval covers less than a body height.
A moving release or wait that makes a jump/stroke available can provide a useful next interval even
when an uninterrupted hold would return to a known blockage. The next and held
endpoints are checked separately; the model can replan after releasing A.
If every action satisfies the navigation predicate, the full outcome table is
kept instead of erasing progress differences with an all-true question.
Underwater, if a forward hold predicts falling/death with the feet at or below
the 240-pixel viewport edge, surviving upward motion can become the question's
focus before ordinary progress. This warns earlier about drops and downward
currents; it does not require every action to survive an uninterrupted hold.
The original eight actions remain available; `left_jump` adds a missing
controller capability, not an automatically executed recovery sequence.
Deeper hazard lookahead can cost several seconds per decision; ordinary
unthreatened states skip that extra search.

## Game behavior

- Starts at world 1-1 through the normal START sequence, without RAM edits.
- Supports original mapper-0 iNES SMB1: 32 KiB PRG, 8 KiB CHR, no trainer,
  40976 bytes. World-layout telemetry and the supplied Europe Rev A have
  been exercised; ROM headers alone cannot identify arbitrary games or hacks.
- **JSNES uses NTSC timing. Europe Rev A runs compatibly, not with accurate
  50 Hz PAL timing.** The local framebuffer is displayed without audio.
- Defaults to 16 emulator frames per land decision, capped at 8 underwater or on non-tile support and 4 near springboards,
  not 16 decisions per second.
  Emulation pauses during inference. Holding A through landing does not
  rearm a new jump; the model must choose an action without A.
- The goal is **all 32 stages, 1-1 through 8-4, without warp shortcuts**.
  Ordinary flagpoles and earlier castles are intermediate clears, not the
  final stopping condition. The dashboard and model receive current-level
  and completed-level information.
- During engine-controlled animations/loading, release all buttons and
  advance ordinary NES frames until input is playable again, then resume
  model decisions. These frames are logged as `automatic-transition`, not
  fabricated model choices; no RAM timers are skipped. A transition exceeding
  6000 frames fails explicitly. Area changes reset stale motion/terrain history.
- Final victory requires the 8-4 castle victory mode **and all 32 recorded
  stage clears in the current run**. Reaching 8-4 with skipped stages reports
  an incomplete campaign, not success.
- **Continuous play is enabled by default.** A death advances the game's own
  death/respawn animation and consumes a normal life, then the model resumes
  at the game's spawn/checkpoint. Previously cleared stages remain recorded
  within that campaign. Game over starts a fresh campaign through normal
  boot/START, with a new run ID and zero completed stages; progress from
  different campaigns is never combined. No lives, checkpoints, or timers
  are edited. `CONTINUOUS_PLAY=0` restores stop-on-death behavior.
- Manual pause is respected, including during respawn. Service errors and
  safety limits still stop explicitly; continuous mode is not an error-swallowing
  loop and does not guarantee the model will eventually solve every stage.
  Pause cancels and discards late answers.
- Cross-episode experience is **off by default**: no previous episode is
  read or saved. `USE_EXPERIENCE=1` explicitly enables bounded factual memory,
  not weight training; existing history is otherwise left untouched.

## Configuration and evidence

| Variable | Default |
| --- | --- |
| `GAME_PORT` | `4175` |
| `DECISION_BACKEND` | `this-that`; opt in with `jev-official` |
| `TYPESAFE_ENV_FILE` | None; private credential file for official mode |
| `TYPESAFE_API_KEY` | None; environment alternative to the file |
| `JEV_MODEL` | `jev-1.14.0` in official mode |
| `THIS_THAT_BASE_URL` | `http://127.0.0.1:8767` |
| `MARIO_ROM` | None; upload a local `.nes` |
| `FRAMES_PER_DECISION` | `16`, range 1–60; water/non-tile support cap 8, nearby springboard cap 4 |
| `MAX_DECISIONS` | `20000` for the whole campaign |
| `CONTINUOUS_PLAY` | `1`; automatic respawn and new campaign after game over |
| `USE_EXPERIENCE` | `0` |

Change the model port with `pnpm model --port 8768`, then set
`THIS_THAT_BASE_URL=http://127.0.0.1:8768` for the game.
Both servers bind only `127.0.0.1`, check Host/Origin, and reject cross-site
requests. Local model URLs allow only numeric HTTP loopback addresses;
redirects, DNS hostnames, and URL credentials are rejected. Explicit official
mode permits only the fixed TypeSafe HTTPS API, with no redirects.

`midscene_run/logs/<run-id>.jsonl` records full telemetry, exact compact model
input and question descriptions, native model identity/distributions,
the applied action, subsequent coordinates, and errors. All runtime data
is Git-ignored. Model failures stop play rather than producing default actions.
Immediately after emulation advances, `applied` or `automatic-applied` records
the actual action, frame range and raw 2 KiB RAM before telemetry sampling.
If sampling or transition logging fails, status exposes `pendingApplied` and
marks the error `post-action`; the cached telemetry may still describe the prior
frame. Applied model decisions are counted even in this failure case. Never
request that Choice again or recover by ignoring its already-applied frames.

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

**Verified official Jev full campaign:** run
`0e61deb0-42bd-4d6d-b554-87c6fa187020` completed all **32 stages in order**
using `jev-1.14.0`: **6,275 model actions, 113,645 emulator frames, one life
remaining**. Every playable action matched the official raw Choice, all nine
options remained available, and model memory was empty. Lives changed naturally
`3 → 2 → 3 → 2 → 1`; neither deaths nor spent time were undone.
The final predicate is native NES victory mode (`$0770=2`) in world 8, stage 4,
with all 32 recorded clears. The game stops at that trigger; the preserved image
is not a subsequently advanced ending animation.

Independent full-log replay matched every recorded player/frame transition,
the final ordered campaign state, and every live RGBA pixel. This was **not a
frozen-policy, intervention-free benchmark**: it included policy/telemetry
repairs and 24 recorded process recoveries. At action 3944, a debugger-cleanup
failure lost the original live snapshot after an already-applied Choice.
Authorized deterministic reconstruction preserved that action exactly once;
no original-live full-snapshot comparison is claimed.
Private local evidence is under `midscene_run/verification/`:
`0e61deb0-42bd-4d6d-b554-87c6fa187020-victory-audit.json`,
`0e61deb0-42bd-4d6d-b554-87c6fa187020-victory-6275-replay.json`, and
`0e61deb0-42bd-4d6d-b554-87c6fa187020-victory-6275.png`.
This result belongs to the hosted official backend, not local Gemma or This-That,
and does not guarantee another campaign will succeed.

The **Gemma baseline**, not this model, previously cleared 1-1 without
experience in 138 decisions / 2194 frames, ending at x3161 with all three
lives. Its local evidence is
`midscene_run/logs/d10d0a8a-6dea-47d4-9463-345dd46eb890.jsonl`.
Do not attribute that result to This-That.

**Verified This-That run:** `59adc974-09de-4850-9c3e-0011cb220ccf` cleared
1-1 on the earlier seven-action, single-level version, with the supplied
Europe Rev A ROM, experience disabled, and 16-frame
decisions. It took **87 decisions, 1388 emulator frames, and 85.02 seconds**
from the first request to the final transition. Mean decision HTTP latency
was **511.8 ms**; all responses generated zero tokens. Final state:
`clear=true`, `dead=false`, `x=3161`, three lives remaining.
That historical `clear` meant a level clear, not completion of all worlds.

Every applied action matched the native model choice, and an independent
ROM replay reproduced all 87 player/episode transitions. Local evidence:
`midscene_run/logs/59adc974-09de-4850-9c3e-0011cb220ccf.jsonl` and
`midscene_run/verification/59adc974-09de-4850-9c3e-0011cb220ccf-audit.json`.
This is one verified successful run, not a guarantee of future completion
or a controlled benchmark against Gemma's different input/policy.

**Historical campaign run:** `dfe87464-917a-4749-ae97-f4d83a856d5f` used the
then-current eight-action model policy with experience disabled, cleared 1-1, automatically
entered 1-2, and executed the next model choice there. It was deliberately
paused at **1/32 completed**, with all three lives remaining:
116 native decisions, 2910 total emulator frames, including 1061 neutral
engine-animation frames. An independent ROM replay reproduced every
transition; every playable action matched the native Choice.
Evidence: `midscene_run/logs/dfe87464-917a-4749-ae97-f4d83a856d5f.jsonl` and
`midscene_run/verification/dfe87464-917a-4749-ae97-f4d83a856d5f-campaign-audit.json`.
This establishes continued play across the first level boundary, **not
completion of all 32 stages**. Full-campaign success for the local This-That
backend, including water levels and castle mazes, has not been established.

The same campaign subsequently died in 1-2. Continuous-mode verification
then confirmed a normal NES respawn with lives decreasing from three to two,
the completed 1-1 retained, and fresh native model choices resuming without
experience. Evidence: `midscene_run/verification/continuous-respawn-result.json`.
This is a recovery check, not a full-game victory.

Later debugging verified a live escape past the 1-2 pit, but that campaign
missed the normal exit. The held-horizon pipe-entry flag was missing.
`midscene_run/verification/normal-exit-regression.json` records an isolated
replay from the exact pre-exit state, with new native decisions completing
1-2 and reaching 1-3 loading after the fix. This counterfactual check is not
a completed live campaign; no old state was injected into live play.

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
