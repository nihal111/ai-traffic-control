# Handoff - AI Traffic Control Mobile ttyd Stack

Date: 2026-04-07
Owner context: mobile terminal customization work

## Project rename note
This project was renamed from `MobileDev` to `AiTrafficControl` (display name: `AI Traffic Control`).
All tracked repository paths and references should now use `AiTrafficControl`.

## Goal
Maintain a custom mobile-friendly terminal on top of ttyd with nginx injection, while keeping persistence via tmux and minimizing moving parts.

## Architecture

### Standalone endpoint (nginx.conf)
- Browser -> nginx `:7680` -> ttyd `127.0.0.1:7682`
- Config: `nginx-ttyd/nginx.conf`
- Assets served directly from `nginx-ttyd/ttyd-mobile.{css,js}`

### Dashboard-managed sessions (start-ttyd-sessions.sh)
- Each scientist session gets its own port: `:7001`-`:7004`
- Config **generated** at: `dashboard/run/nginx-sessions.conf`
- Template lives in: `dashboard/scripts/start-ttyd-sessions.sh`
- Same CSS/JS assets are aliased from `nginx-ttyd/`

**Both nginx instances** inject the toolbar HTML inline via `sub_filter`. The HTML is baked into the config at generation time, NOT loaded dynamically. This means:

## How to refresh after changing toolbar/CSS/JS

### If you only changed CSS or JS files:
The `.css` and `.js` are served via `alias` directives pointing at the source files in `nginx-ttyd/`. A browser hard-refresh picks up changes immediately — no nginx restart needed. Bump the `?v=` query string in the config to bust caches.

### If you changed the toolbar HTML (button layout, new buttons, removed buttons):

**Step 1**: Update the toolbar HTML in these template locations:
- `nginx-ttyd/nginx.conf` (standalone endpoint)
- `dashboard/scripts/start-ttyd-sessions.sh` (session template)

**Step 2**: Regenerate the sessions config by re-running:
```bash
cd ~/Code/AiTrafficControl/dashboard
bash scripts/start-ttyd-sessions.sh
```
This regenerates `dashboard/run/nginx-sessions.conf` from the template.

OR manually edit `dashboard/run/nginx-sessions.conf` if you don't want to restart ttyd processes.

**Step 3**: Reload both nginx instances:
```bash
# Standalone nginx
nginx -c ~/Code/AiTrafficControl/nginx-ttyd/nginx.conf \
      -p ~/Code/AiTrafficControl/nginx-ttyd/ -s reload

# Sessions nginx
/opt/homebrew/opt/nginx/bin/nginx \
      -p ~/Code/AiTrafficControl/dashboard/run/nginx/ \
      -c ~/Code/AiTrafficControl/dashboard/run/nginx-sessions.conf \
      -s reload
```

**Step 4**: Hard-refresh in the browser.

### Quick reference — version bump checklist
When changing assets, bump the `?v=N` in all of:
1. `nginx-ttyd/nginx.conf`
2. `dashboard/scripts/start-ttyd-sessions.sh`
3. `dashboard/run/nginx-sessions.conf` (generated — will be overwritten on next `start-ttyd-sessions.sh` run)

## Current Toolbar Layout
- **Row 1** (5 buttons): Ctrl+C, Tab, Up, Down, Esc
- **Row 2** (4 buttons, tmux scroll): Ctrl+B, [, PgUp, PgDn
- Row 2 buttons do NOT open the keyboard (skipFocus)
- Font size fixed at 24px, wrap always enabled, no drawer/More button

## What was built
1. Mobile toolbar overlay via nginx `sub_filter` injection
2. Font sizing — default `24px`, persisted in `localStorage` key `ttyd_mobile_font_size_v3`
3. Keyboard avoidance via `window.visualViewport` — terminal container shrinks when keyboard opens so xterm.js re-fits rows
4. Tmux scroll mode row (Ctrl+B, [, PgUp, PgDn) that sends sequences without triggering keyboard
5. Optional features behind flags (default OFF): `scrollbar`, `history`, `touchscroll`

## How to start after reboot
```bash
cd ~/Code/AiTrafficControl/dashboard
bash scripts/start-ttyd-sessions.sh
```

For the standalone endpoint:
```bash
cd ~/Code/AiTrafficControl/nginx-ttyd
./scripts/start.sh
```

## Key Files
- `nginx-ttyd/nginx.conf` — standalone nginx config
- `nginx-ttyd/ttyd-mobile.js` — all mobile JS (toolbar, keyboard avoidance, scroll)
- `nginx-ttyd/ttyd-mobile.css` — toolbar + terminal layout styles
- `dashboard/scripts/start-ttyd-sessions.sh` — generates per-session nginx config
- `dashboard/run/nginx-sessions.conf` — **generated** runtime config (do not edit as source of truth)
- `dashboard/tests/e2e/mobile-keyboard-follow.spec.mjs` — keyboard scroll test

## Known Notes
- `dashboard/run/nginx-sessions.conf` is generated and will drift from templates if you only edit the template without regenerating. Always check the running config matches.
- History preload is intentionally off.
- If mobile shows stale behavior, hard refresh the tab (assets are cache-busted via `?v=` params).
