# Jev Mario

**[Live demo](https://jev-mario.zoink.site)** · [中文](./README.zh.md)

Super Mario Bros in a real NES emulator, with AI controller decisions and
inspectable replay: **NES → structured game state → Jev Choice → controller**.

## Play online

Click **Load ROM**, then **Start game** or **Replay full campaign**.
The Cloudflare site runs entirely in your browser; it does not call a live AI model.

- Replay all **32 stages and 6275 decisions**, with the recorded inputs and answers.
- Pause, step through decisions, or select **0.5× / 1× / 4× / 16×** speed.
- Switch between English and Chinese. Wide screens show the game and logs side
  by side; resizing below 1100px restores a single column.
- Manual controls: focus the game, use arrows to move, **Z/Space** to jump and
  **X** to run. Losing focus pauses manual play. Audio is disabled.

## Run locally

Requires **Node.js 24+**, **pnpm 9.3.0+**, and a lawfully obtained SMB1 `.nes` file.

```bash
pnpm install --frozen-lockfile
```

**Local model** — additionally requires Apple Silicon, Python 3.12 and `uv`.
Uses [FLock's This-That 1.2](https://huggingface.co/flock-io/this-that-model-1.2)
with approximately 3.76 GB of weights.

```bash
uv sync --frozen --python 3.12
pnpm download:model
pnpm model
```

Once the model is ready, run in another terminal:

```bash
MARIO_ROM="/absolute/path/to/game.nes" pnpm start
```

Open **http://127.0.0.1:4175** and click **启动 Agent**.
Alternatively, omit `MARIO_ROM` and load a local `.nes` through the page.

**Official Jev API** — no Python or local model needed. Create a private `.env`
containing `TYPESAFE_API_KEY`, then:

```bash
DECISION_BACKEND=jev-official TYPESAFE_ENV_FILE=.env \
MARIO_ROM="/absolute/path/to/game.nes" pnpm start
```

Official mode sends structured game state to TypeSafe and may incur API charges.
Neither backend sends screenshots or ROM data to the model. Never commit keys.

## Build the static site

Requires the original audited campaign log and its matching ROM, neither of
which is included in Git. A fresh clone alone cannot rebuild the published replay.
Public ROM hosting requires distribution rights, not merely ownership of a copy.

```bash
MARIO_ROM_DISTRIBUTION_AUTHORIZED=true \
MARIO_PUBLIC_ROM="/path/to/authorized.nes" \
MARIO_REPLAY_LOG="/path/to/audited-campaign.jsonl" pnpm build:static
pnpm preview:static
```

Preview: **http://127.0.0.1:4180**. With the appropriate Cloudflare authorization,
`pnpm deploy:pages` publishes to the configured `jev-mario` Pages project.
The build exports only approved gameplay fields and static assets, not credentials,
raw logs or snapshots. Optional local ROM imports stay in the browser.

## Notes

The recorded campaign included maintenance pauses and policy changes; it is not
an unattended benchmark or a guarantee of future completion. The lost live snapshot
at log index 3944 was reconstructed deterministically. Replay checks physical
transitions and the final framebuffer hash; displayed records are not internal reasoning.

Development checks: `pnpm test`, `pnpm run lint`, and `pnpm test:python` for the
Python backend.

## Credits

[MIT license](./LICENSE), retained from Midscene. [JSNES](https://github.com/bfirsh/jsnes)
uses Apache-2.0; [This-That](https://github.com/FLock-io/this-that-model) uses MIT.
Architecture inspired by [typesafe-mario](https://github.com/fhshaik/typesafe-mario);
no source or game assets were copied from that project.
Nintendo names and game resources belong to their respective owners.
