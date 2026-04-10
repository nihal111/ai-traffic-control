# Mobile ttyd + nginx Overlay

This folder contains the custom mobile terminal layer built on top of `ttyd`, with `nginx` injecting a phone-friendly control bar and optional extras.

## What this setup runs

- Public entrypoint: `nginx` on `:7680`
- Backend shell transport: `ttyd` on `127.0.0.1:7682`
- Persistence layer: `tmux` session (default session name: `mobile`)
- Optional history preload service: `tmux-history-server.js` on `127.0.0.1:17777`

Data flow:

1. Phone browser connects to `http://<host-ip>:7680`
2. `nginx` reverse-proxies websocket/http to `ttyd` at `127.0.0.1:7682`
3. `ttyd` connects to shell attached to tmux-backed environment
4. Mobile toolbar and JS/CSS are injected by `nginx sub_filter`

## Files

- `nginx.conf`: reverse proxy + HTML injection + static/mobile asset routes
- `ttyd-mobile.css`: toolbar + touch/viewport + optional custom scrollbar rail styles
- `ttyd-mobile.js`: keyboard buttons, font controls, wrap toggle, touch scroll handling, optional feature flags
- `tmux-history-server.js`: optional HTTP endpoint that serves tmux backlog (`capture-pane`)
- `scripts/start.sh`: primary bring-up script
- `scripts/stop-extra-services.sh`: stops experimental listeners, leaving only `7680` + `7682`

## Feature flags (default OFF)

Both optional features are intentionally disabled by default.

- `scrollbar`: enable custom right-side scroll rail
- `history`: preload tmux history from `/ttyd-history`

### Enable per request using URL query params

- `?scrollbar=1`
- `?history=1`
- Can combine: `?scrollbar=1&history=1&tmuxSession=mobile&historyLines=80000`

### Enable globally (optional)

In `nginx.conf`, edit injected JS object:

```html
window.TTYD_MOBILE_FLAGS = {
  scrollbar: false,
  history: false
};
```

Set either key to `true`, then reload nginx.

## Start / restart guide

## 1) Standard startup (recommended)

From this directory:

```bash
./scripts/start.sh
```

What it does:

- Ensures tmux session `mobile` exists
- Ensures backend ttyd is listening on `127.0.0.1:7682` (session `ttyd-backend`)
- Validates and starts/reloads nginx on `:7680`
- Does **not** start history server unless requested

Optional: start with history server as well:

```bash
ENABLE_HISTORY_SERVER=1 ./scripts/start.sh
```

## 2) After tmux server restart/reboot

If tmux is restarted or machine rebooted, run:

```bash
cd ~/Code/AiTrafficControl/nginx-ttyd
./scripts/start.sh
```

That is enough to recreate the baseline (`7680` -> `7682`).

## 3) Manual bring-up (without scripts)

```bash
# Ensure tmux session exists
tmux has-session -t mobile 2>/dev/null || tmux new-session -d -s mobile

# Start backend ttyd (if not already running)
tmux new-session -d -s ttyd-backend \
  '/opt/homebrew/bin/ttyd -W -i 127.0.0.1 -p 7682 -t scrollback 100000 -t disableResizeOverlay true /bin/bash'

# Start or reload nginx
/opt/homebrew/opt/nginx/bin/nginx -p ~/Code/AiTrafficControl/nginx-ttyd/ -c ~/Code/AiTrafficControl/nginx-ttyd/nginx.conf
# or reload if already running:
/opt/homebrew/opt/nginx/bin/nginx -p ~/Code/AiTrafficControl/nginx-ttyd/ -c ~/Code/AiTrafficControl/nginx-ttyd/nginx.conf -s reload
```

## Service cleanup

To stop extra experimental stacks and keep only primary ports:

```bash
./scripts/stop-extra-services.sh
```

Expected remaining listeners:

- `:7680` nginx
- `127.0.0.1:7682` ttyd

## Validation checks

```bash
lsof -nP -iTCP -sTCP:LISTEN | rg ':(7680|7682|17777|7685|7686)\b'
tmux ls
```

## Notes about history behavior

Without `history=1`, terminal output begins from the time the browser attaches (normal ttyd behavior).
With `history=1` and history server running, tmux backlog is preloaded once per tab/session key.

## Troubleshooting

- If toolbar changes do not appear, hard-refresh mobile browser tab.
- If history preload fails, confirm history server is running on `127.0.0.1:17777`.
- If `codex`/node issues occur with Homebrew dylibs, reinstall `node` (`brew reinstall node`).
