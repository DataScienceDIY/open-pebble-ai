# Appstore submission package

Assets and metadata to publish open-pebble-ai to the Rebble Appstore. Not
uploaded — run `./publish.sh` for a dry-run preview, then `./publish.sh
--confirm` when you're ready.

## Contents

```
appstore/
  description.txt          # Long description shown on the app's listing page
  release-notes.txt        # Notes attached to the v0.1.0 release
  icons/
    icon-small.png         # 80x80 PNG, listing-page small icon
    icon-large.png         # 144x144 PNG, listing-page hero icon
  screenshots/
    emery_idle.png         # 200x228 PNG, idle screen
    emery_chat.png         # 200x228 PNG, chat-bubble exchange
  publish.sh               # Wrapper around `pebble publish` that wires it all up
  README.md                # This file
```

Filenames in `screenshots/` MUST start with the target platform name —
`pebble publish` uses the prefix to route each screenshot. So
`emery_idle.png` is treated as an emery screenshot, `emery_chat.png` as
another emery one, etc. To add Pebble 2 / Chalk / etc. coverage later,
add `flint_*.png`, `chalk_*.png`, etc. — but the app currently only
targets `emery`, so emery-only is correct.

## How publishing works under the hood

`pebble publish` is the SDK CLI for submitting to the Rebble appstore at
`https://appstore-api.repebble.com`. It:

1. Reads metadata from the .pbw bundle (UUID, displayName, version).
2. Looks up your UUID via Firebase auth + the appstore API to find an
   existing app entry or create a new one.
3. Uploads the .pbw as a new release, plus screenshots and icons.
4. Marks the release as either draft (default) or visible
   (`--is-published`).

Authentication is via Firebase. Either log in interactively the first
time (it caches a refresh token), or set `PEBBLE_FIREBASE_ID_TOKEN` for
CI. See `pebble publish --help`.

## Before publishing — clear baked secrets

`scripts/inject-config-defaults.sh` bakes the values from your local
`.env.local` into `src/pkjs/config_defaults.js`. Anything in there ships
verbatim to every user. Before publishing:

```bash
./scripts/inject-config-defaults.sh --clear  # restore empty defaults
pebble build                                  # rebuild the .pbw
```

`publish.sh` checks for an `sk-...`-shaped value in
`src/pkjs/config_defaults.js` and refuses to run if it finds one. The
check is a safety net, not a substitute for being deliberate.

## Refreshing screenshots

Both static screenshots were captured from the running emulator:

```bash
pebble screenshot --emulator emery appstore/screenshots/emery_idle.png
# (drive the app to whatever state you want to capture, then)
pebble screenshot --emulator emery appstore/screenshots/emery_chat.png
```

The current `emery_chat.png` shows "hello from fake-owui" because it
was captured with the local stub server. Retake it against the real
OWUI endpoint before publishing if you want a more representative
sample reply.

## Animated demo GIF

To add an animated preview to the listing, run:

```bash
./scripts/capture-demo-gif.sh
```

That script orchestrates a `pebble screenshot --gif-all-platforms`
capture: it spins up the emulator with `OWUI_DEBUG=1`, starts the
`fake-owui` stub, then injects two SELECT clicks during the 7-second
recording window so the GIF shows actual motion (idle → spinner →
chat bubbles → next turn). Output lands at
`appstore/screenshots/emery_demo.gif` and `publish.sh` picks it up
automatically alongside the PNGs.

Prerequisites (Linux): `ffmpeg`, `xdotool`, `x11-utils`, an X11
session (not Wayland). The script's preflight check fails fast if
anything is missing.

`pebble publish`'s `--gif-all-platforms` mode can auto-capture
rollover GIFs *during* publish, but our wrapper passes
`--no-gif-all-platforms` and uploads whatever files are in
`appstore/screenshots/` instead. Capturing once with the script above
and committing the GIF keeps publishes deterministic and avoids
needing X11 tools on the publishing machine.

## Sanity checklist

- [ ] `.env.local` cleared from `src/pkjs/config_defaults.js`
- [ ] Fresh `pebble build` succeeded after the clear
- [ ] `appstore/description.txt` reflects the current feature set
- [ ] `appstore/release-notes.txt` matches the version being shipped
- [ ] Screenshots show the current UI (regenerate after UI changes)
- [ ] `package.json` `version` is bumped (e.g. 0.1.0 -> 0.1.1) for each
      release; `pebble publish` rejects re-uploads with the same version
- [ ] `git tag` the release commit before publishing for traceability
