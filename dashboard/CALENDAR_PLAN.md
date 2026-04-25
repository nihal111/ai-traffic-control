# Calendar Page Implementation Plan

**Audience:** Haiku executing incrementally. Each milestone is self-contained — ship, verify, then move to next.

## Repos touched
- `/Users/nihal/Code/CalendarAutomation` (Python backend)
- `/Users/nihal/Code/AiTrafficControl/dashboard/server.mjs` (Node HTTP + HTML)

## Server restart
After any change in either repo:
```
pkill -f "node.*dashboard/server.mjs"; cd /Users/nihal/Code/AiTrafficControl && node dashboard/server.mjs &
```
Then verify at http://localhost:1111/calendar.

## Global rules for the executor
- Do NOT rewrite the whole `renderCalendarPage()` function in `server.mjs`. It's a backtick template literal containing JavaScript that also uses backticks; full rewrites keep breaking. Use `Edit` with narrow, unique `old_string`/`new_string` pairs.
- Inside the template string, nested JS uses `\`...\``. Keep that escape. Do NOT turn them into plain backticks in `old_string` — copy them verbatim from the file.
- Before each Edit, run a Read on the region to confirm current line numbers (they'll shift as we add code).
- After each milestone, curl `/api/calendar/state` and reload `/calendar` in browser (or `curl -s http://localhost:1111/calendar | head -50`) to verify no 500s and no syntax errors in the HTML.

---

# Milestone 1 — Fix Today's Brief (past + current + future, with colors + now-line)

**Goal:** Show the whole day's events, color-coded like Google Calendar, with a horizontal "now" line between past and upcoming events. Vertical layout is fine.

## 1.1 Backend: return full day + color_id

### File: `/Users/nihal/Code/CalendarAutomation/calendar_tools/classify.py`
At line 62, the `enrich_event` function returns a dict. Add a `color_id` field.

**Edit** — find and replace this exact block (inside the returned dict, keep the trailing `}`):
```python
        "recurring": event.recurring_event_id is not None if hasattr(event, "recurring_event_id") else False,
        "routine": classify_event(event, config),
        "_raw": event,
    }
```
Replace with:
```python
        "recurring": event.recurring_event_id is not None if hasattr(event, "recurring_event_id") else False,
        "routine": classify_event(event, config),
        "color_id": getattr(event, "color_id", None),
        "_raw": event,
    }
```

### File: `/Users/nihal/Code/CalendarAutomation/calendar_tools/tools.py`
At line 203 `daily_briefing()` — when `day == date.today()`, it currently calls `get_events(client, time_min=now, ...)` which excludes past events. Change it to fetch the full day.

**Edit** — replace:
```python
    day = day or date.today()
    if day == date.today():
        now = _now_local()
        all_events = get_events(client, time_min=now, time_max=_end_of_day(day))
        open_slots = find_open_slots(client, day=day, from_now=True)
    else:
        all_events = get_events(client, day=day)
        open_slots = find_open_slots(client, day=day)
```
With:
```python
    day = day or date.today()
    all_events = get_events(client, day=day)
    if day == date.today():
        open_slots = find_open_slots(client, day=day, from_now=True)
    else:
        open_slots = find_open_slots(client, day=day)
```

### File: `/Users/nihal/Code/CalendarAutomation/scripts/dashboard_state.py`
The `event_to_dict` helper (line 52) must pass `color_id` through.

**Edit** — replace:
```python
def event_to_dict(event: dict) -> dict:
    """Convert an event dict to JSON-serializable format."""
    return {
        "id": event.get("id"),
        "summary": event.get("summary"),
        "start": event.get("start").isoformat() if event.get("start") else None,
        "end": event.get("end").isoformat() if event.get("end") else None,
        "routine": event.get("routine", False),
        "location": event.get("location"),
        "description": event.get("description"),
    }
```
With:
```python
def event_to_dict(event: dict) -> dict:
    """Convert an event dict to JSON-serializable format."""
    return {
        "id": event.get("id"),
        "summary": event.get("summary"),
        "start": event.get("start").isoformat() if event.get("start") else None,
        "end": event.get("end").isoformat() if event.get("end") else None,
        "routine": event.get("routine", False),
        "location": event.get("location"),
        "description": event.get("description"),
        "color_id": event.get("color_id"),
    }
```

### Verification
```
cd /Users/nihal/Code/CalendarAutomation && python3 scripts/dashboard_state.py | python3 -c "import json,sys; d=json.load(sys.stdin); evs=d['brief']['all_events']; print(len(evs), 'events'); [print(e['summary'], e['start'], e.get('color_id')) for e in evs]"
```
Expected: All today's events, including ones already past (e.g. 8am events visible at 10pm).

## 1.2 Frontend: Google Calendar colors + render past/future + now-line

### File: `/Users/nihal/Code/AiTrafficControl/dashboard/server.mjs`

Everything below is inside `renderCalendarPage()` which starts at **line 3778**. Use Read to confirm exact lines before editing, since line numbers will drift as you edit.

### 1.2.a — Add Google color palette CSS

Find the `.event-item.routine` CSS block (around line 3945):
```css
    .event-item.routine {
      opacity: 0.6;
      border-left-color: #7e8e91;
    }
    .event-time { font-size: 11px; color: #7e8e91; margin-top: 4px; }
```
Replace with (adds color classes + event-time stays as-is):
```css
    .event-item.routine {
      opacity: 0.55;
      border-left-color: #7e8e91;
    }
    .event-item.past {
      opacity: 0.5;
    }
    .event-time { font-size: 11px; color: #7e8e91; margin-top: 4px; }
    /* Google Calendar event colors (color_id 1-11) */
    .gc-color-1  { border-left-color: #7986cb; } /* Lavender */
    .gc-color-2  { border-left-color: #33b679; } /* Sage */
    .gc-color-3  { border-left-color: #8e24aa; } /* Grape */
    .gc-color-4  { border-left-color: #e67c73; } /* Flamingo */
    .gc-color-5  { border-left-color: #f6bf26; } /* Banana */
    .gc-color-6  { border-left-color: #f4511e; } /* Tangerine */
    .gc-color-7  { border-left-color: #039be5; } /* Peacock */
    .gc-color-8  { border-left-color: #616161; } /* Graphite */
    .gc-color-9  { border-left-color: #3f51b5; } /* Blueberry */
    .gc-color-10 { border-left-color: #0b8043; } /* Basil */
    .gc-color-11 { border-left-color: #d50000; } /* Tomato */
    .gc-color-default { border-left-color: #4285f4; } /* Calendar default blue */
    /* Now-line separator */
    .now-line {
      position: relative;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #fd971f 15%, #f92672 50%, #fd971f 85%, transparent 100%);
      margin: 10px 0;
      border-radius: 2px;
    }
    .now-line::before {
      content: "NOW " attr(data-time);
      position: absolute;
      left: 50%;
      top: -9px;
      transform: translateX(-50%);
      background: #2a2624;
      border: 1px solid #665c54;
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #fd971f;
    }
```

### 1.2.b — Render past events above now-line, future below

Find the brief rendering block in `loadDashboard()`. Currently (around line 4066-4085):
```javascript
        // Render brief - show all events (routine and non-routine)
        const brief = data.brief || {};
        let briefHtml = '';
        const allEvents = brief.all_events || brief.events || [];
        if (allEvents.length > 0) {
          briefHtml += '<div class="event-list">';
          for (const ev of allEvents) {
            const routineClass = ev.routine ? ' routine' : '';
            const start = new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(ev.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            briefHtml += \`<div class="event-item\${routineClass}">
              <div>\${ev.summary}</div>
              <div class="event-time">\${start} – \${end}</div>
            </div>\`;
          }
          briefHtml += '</div>';
        } else {
          briefHtml = '<div class="empty-state">No events today</div>';
        }
        document.getElementById('briefContent').innerHTML = briefHtml;
```

Replace with:
```javascript
        // Render brief - show ALL events (past + future), color-coded, with now-line
        const brief = data.brief || {};
        let briefHtml = '';
        const allEvents = brief.all_events || brief.events || [];
        if (allEvents.length > 0) {
          const now = new Date();
          const nowLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          // Sort by start time ascending (backend already does, but be safe)
          const sorted = allEvents.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
          briefHtml += '<div class="event-list">';
          let nowLineInserted = false;
          for (const ev of sorted) {
            const startDate = new Date(ev.start);
            const endDate = new Date(ev.end);
            const isPast = endDate < now;
            // Insert now-line before the first non-past event
            if (!nowLineInserted && !isPast) {
              briefHtml += \`<div class="now-line" data-time="\${nowLabel}"></div>\`;
              nowLineInserted = true;
            }
            const routineClass = ev.routine ? ' routine' : '';
            const pastClass = isPast ? ' past' : '';
            const colorClass = ev.color_id ? \` gc-color-\${ev.color_id}\` : ' gc-color-default';
            const start = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            briefHtml += \`<div class="event-item\${routineClass}\${pastClass}\${colorClass}">
              <div>\${ev.summary || '(untitled)'}</div>
              <div class="event-time">\${start} – \${end}</div>
            </div>\`;
          }
          // If every event is in the past, still show the now-line at the bottom
          if (!nowLineInserted) {
            briefHtml += \`<div class="now-line" data-time="\${nowLabel}"></div>\`;
          }
          briefHtml += '</div>';
        } else {
          briefHtml = '<div class="empty-state">No events today</div>';
        }
        document.getElementById('briefContent').innerHTML = briefHtml;
```

### Verification
1. Restart server.
2. Open http://localhost:1111/calendar.
3. Expect:
   - All today's events visible (including morning ones even at 10pm).
   - Past events have `.past` opacity.
   - Orange/pink "NOW hh:mm" line separates past from upcoming.
   - Event border-left color matches Google Calendar color for events you've colored (if none, default blue).

---

# Milestone 2 — Weekly view toggle

**Goal:** Tabs above the brief section: `Today` (current behaviour) and `Week` (next 7 days grouped by day).

## 2.1 Backend: ensure week data is available

`dashboard_state.py` already returns `slots_week`. For **week events** we need a new payload. Add it to `dashboard_state.py`.

### File: `/Users/nihal/Code/CalendarAutomation/scripts/dashboard_state.py`

After the slots_week loop (around line 153), and **before** the "Backlog items" comment, add:

```python
    # Events for next 7 days
    week_events_data = []
    try:
        for i in range(1, 8):
            day = today + timedelta(days=i)
            day_events = get_events(client, day=day)
            for ev in day_events:
                week_events_data.append({
                    "day": day.isoformat(),
                    **event_to_dict(ev),
                })
    except Exception:
        pass
```

Then add `week_events_data` to the final `result` dict:
```python
    result = {
        "generated_at": now.isoformat(),
        "brief": brief_data,
        "slots_today": slots_today_data,
        "slots_week": slots_week_data,
        "week_events": week_events_data,
        "backlog": backlog_data,
        "stale": stale_data,
    }
```

### Verification
```
cd /Users/nihal/Code/CalendarAutomation && python3 scripts/dashboard_state.py | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('week_events',[])),'week events'); print({e['day'] for e in d.get('week_events',[])})"
```

## 2.2 Frontend: Tab UI

### File: `/Users/nihal/Code/AiTrafficControl/dashboard/server.mjs`

### 2.2.a — Tab CSS

Find the `.section-title` CSS block (around line 3879). After it, add:
```css
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      background: #2a2624;
      padding: 3px;
      border-radius: 8px;
      border: 1px solid #665c54;
      width: fit-content;
    }
    .tab {
      padding: 6px 14px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: #a89984;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      font-family: inherit;
    }
    .tab.active {
      background: linear-gradient(180deg, #d79921, #d97706);
      color: #1b1d1e;
    }
    .day-header {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #fd971f;
      margin: 12px 0 6px;
      padding-left: 2px;
    }
    .day-header:first-child { margin-top: 0; }
```

### 2.2.b — Tab markup

Find the Today's Brief section markup (around line 4018):
```html
    <div class="section">
      <div class="section-title">Today's Brief</div>
      <div id="briefContent" class="loading">
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>
    </div>
```
Replace with:
```html
    <div class="section">
      <div class="section-title">Brief</div>
      <div class="tabs">
        <button class="tab active" data-view="today" onclick="setBriefView('today')">Today</button>
        <button class="tab" data-view="week" onclick="setBriefView('week')">Week</button>
      </div>
      <div id="briefContent" class="loading">
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>
    </div>
```

### 2.2.c — View state + render function

At the top of the `<script>` block (right after `let lastFetchMs = 0;`), add:
```javascript
    let briefView = 'today';
    let lastState = null;

    function setBriefView(view) {
      briefView = view;
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
      });
      if (lastState) renderBrief(lastState);
    }
```

Refactor `loadDashboard` so it calls `renderBrief(data)` instead of inlining brief rendering. Structure:
- Keep the fetch + error handling intact.
- Stash `lastState = data`.
- Move the existing brief render block into `function renderBrief(data) { ... }` and add branching on `briefView`.

**Exact replacement** — find the entire brief rendering block inside `loadDashboard()` (the one you edited in 1.2.b, from `// Render brief` through `document.getElementById('briefContent').innerHTML = briefHtml;`). Replace it with:
```javascript
        lastState = data;
        renderBrief(data);
```

Then add this new function BEFORE `async function loadDashboard()`:
```javascript
    function renderEventItem(ev) {
      const now = new Date();
      const startDate = new Date(ev.start);
      const endDate = new Date(ev.end);
      const isPast = endDate < now;
      const routineClass = ev.routine ? ' routine' : '';
      const pastClass = isPast ? ' past' : '';
      const colorClass = ev.color_id ? ' gc-color-' + ev.color_id : ' gc-color-default';
      const start = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const end = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return \`<div class="event-item\${routineClass}\${pastClass}\${colorClass}">
        <div>\${ev.summary || '(untitled)'}</div>
        <div class="event-time">\${start} – \${end}</div>
      </div>\`;
    }

    function renderBrief(data) {
      const container = document.getElementById('briefContent');
      if (briefView === 'today') {
        const brief = data.brief || {};
        const allEvents = brief.all_events || brief.events || [];
        if (allEvents.length === 0) {
          container.innerHTML = '<div class="empty-state">No events today</div>';
          return;
        }
        const now = new Date();
        const nowLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const sorted = allEvents.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
        let html = '<div class="event-list">';
        let nowLineInserted = false;
        for (const ev of sorted) {
          const isPast = new Date(ev.end) < now;
          if (!nowLineInserted && !isPast) {
            html += \`<div class="now-line" data-time="\${nowLabel}"></div>\`;
            nowLineInserted = true;
          }
          html += renderEventItem(ev);
        }
        if (!nowLineInserted) {
          html += \`<div class="now-line" data-time="\${nowLabel}"></div>\`;
        }
        html += '</div>';
        container.innerHTML = html;
      } else {
        // Week view: group by day
        const weekEvents = data.week_events || [];
        if (weekEvents.length === 0) {
          container.innerHTML = '<div class="empty-state">No events this week</div>';
          return;
        }
        const byDay = {};
        for (const ev of weekEvents) {
          (byDay[ev.day] = byDay[ev.day] || []).push(ev);
        }
        const days = Object.keys(byDay).sort();
        let html = '';
        for (const day of days) {
          const dateObj = new Date(day + 'T12:00:00');
          const label = dateObj.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
          html += \`<div class="day-header">\${label}</div>\`;
          html += '<div class="event-list">';
          const sorted = byDay[day].slice().sort((a, b) => new Date(a.start) - new Date(b.start));
          for (const ev of sorted) html += renderEventItem(ev);
          html += '</div>';
        }
        container.innerHTML = html;
      }
    }
```

### Verification
- Tabs render with Today active.
- Click Week → shows next 7 days grouped by day header.
- Click Today → returns to today with now-line intact.

---

# Milestone 3 — Client cache + refresh button

**Goal:** Page loads instantly from `localStorage` cache; an explicit refresh button hits the API and shows a spinner. Background polling is removed (was every 60s) to match the "refresh-button like usage cards" pattern.

## 3.1 Frontend refactor

### File: `/Users/nihal/Code/AiTrafficControl/dashboard/server.mjs`

### 3.1.a — Refresh button CSS + markup

In the CSS block, after `.back-btn:hover` (around line 3870), add:
```css
    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      position: relative;
      z-index: 1;
    }
    .refresh-btn {
      padding: 8px 12px;
      background: #3c3836;
      border: 1px solid #7c6f64;
      border-radius: 7px;
      color: #ebdbb2;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .refresh-btn:hover { background: #504945; border-color: #928374; }
    .refresh-btn.loading .refresh-icon {
      animation: spin 0.9s linear infinite;
    }
    .refresh-icon {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid #ebdbb2;
      border-top-color: transparent;
      border-radius: 50%;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
```

In the header markup, find:
```html
    <header>
      <h1>Calendar</h1>
      <button class="back-btn" onclick="history.back()">← Back</button>
    </header>
```
Replace with:
```html
    <header>
      <h1>Calendar</h1>
      <div class="header-actions">
        <button class="refresh-btn" id="refreshBtn" onclick="refreshDashboard()">
          <span class="refresh-icon"></span>Refresh
        </button>
        <button class="back-btn" onclick="history.back()">← Back</button>
      </div>
    </header>
```

### 3.1.b — Cache + refresh logic

At the top of the `<script>` block, replace:
```javascript
    let lastFetchMs = 0;
    let briefView = 'today';
    let lastState = null;
```
With:
```javascript
    const CACHE_KEY = 'calendarDashboardState';
    let briefView = 'today';
    let lastState = null;

    function loadFromCache() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch { return null; }
    }
    function saveToCache(data) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    }
```

Replace the existing `loadDashboard` body so it accepts a `forceNetwork` flag and uses cache:
```javascript
    async function loadDashboard(forceNetwork = false) {
      // 1. Render cached immediately if available and not forcing
      if (!forceNetwork) {
        const cached = loadFromCache();
        if (cached) {
          lastState = cached;
          renderAll(cached);
          const genAt = cached.generated_at ? new Date(cached.generated_at) : null;
          if (genAt) document.getElementById('lastUpdated').textContent = genAt.toLocaleTimeString() + ' (cached)';
        }
      }
      // 2. Fetch fresh in background
      const btn = document.getElementById('refreshBtn');
      if (btn) btn.classList.add('loading');
      try {
        const resp = await fetch('/api/calendar/state');
        const data = await resp.json();
        if (data.error) {
          document.getElementById('briefContent').innerHTML = '<div class="empty-state">Error: ' + data.error + '</div>';
          return;
        }
        lastState = data;
        saveToCache(data);
        renderAll(data);
        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
      } catch (error) {
        console.error('Load failed:', error);
        if (!lastState) document.getElementById('briefContent').innerHTML = '<div class="empty-state">Failed to load</div>';
      } finally {
        if (btn) btn.classList.remove('loading');
      }
    }

    async function refreshDashboard() {
      await loadDashboard(true);
    }
```

Also introduce `renderAll(data)` which runs the three render calls. Find the old body of `loadDashboard` that rendered brief/slots/backlog/lastUpdated inline and extract the render parts into:
```javascript
    function renderAll(data) {
      renderBrief(data);
      renderSlots(data);
      renderBacklog(data);
    }
```

Move the existing slot-rendering block (around current line 4088-4104) and backlog-rendering block (around 4107-4127) into their own functions `renderSlots(data)` and `renderBacklog(data)` — bodies unchanged, just wrapped. Remove them from `loadDashboard` since `renderAll` handles it.

### 3.1.c — Drop the 60s interval poll

Find:
```javascript
    // Load on page load and every 60s
    loadDashboard();
    setInterval(loadDashboard, 60000);

    // Reload when page becomes visible
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        loadDashboard();
      }
    });
```
Replace with:
```javascript
    // Paint cached state instantly, then fetch fresh in background
    loadDashboard();

    // Re-fetch when tab regains focus
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadDashboard();
    });
```

### Verification
- First visit: page loads, refresh icon spins briefly, then data appears.
- Reload page: instant render from cache (no skeletons), `Updated: hh:mm:ss (cached)` shown, then refreshes silently and label updates.
- Click Refresh: spinner visible during fetch, label updates to current time without `(cached)`.
- No more 60s auto-poll.

---

# Milestone 4 — Backlog: add form + richer display

**Goal:** Inline "+ Add" form with all fields; backlog items show full metadata; stale items flagged.

## 4.1 Frontend

### File: `/Users/nihal/Code/AiTrafficControl/dashboard/server.mjs`

### 4.1.a — CSS for form + meta

Add to CSS block (after `.backlog-meta`):
```css
    .backlog-add-btn {
      width: 100%;
      padding: 10px;
      background: transparent;
      border: 1px dashed #7c6f64;
      border-radius: 8px;
      color: #a89984;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      font-family: inherit;
      margin-bottom: 8px;
    }
    .backlog-add-btn:hover { border-color: #fd971f; color: #fd971f; }
    .backlog-form {
      display: none;
      flex-direction: column;
      gap: 8px;
      background: #2a2624;
      border: 1px solid #665c54;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 8px;
    }
    .backlog-form.open { display: flex; }
    .backlog-form input,
    .backlog-form select,
    .backlog-form textarea {
      padding: 8px 10px;
      border: 1px solid #7c6f64;
      border-radius: 6px;
      background: #3c3836;
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
    }
    .backlog-form textarea { resize: vertical; min-height: 54px; }
    .backlog-form-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }
    .backlog-form-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .backlog-form-actions button {
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid #7c6f64;
      background: #504945;
      color: #ebdbb2;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }
    .backlog-form-actions .primary {
      background: linear-gradient(180deg, #d79921, #d97706);
      color: #1b1d1e;
      border: none;
    }
    .priority-high { color: #f92672; font-weight: 700; }
    .priority-medium { color: #e6db74; }
    .priority-low { color: #7e8e91; }
    .backlog-badges {
      display: inline-flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #504945;
      color: #ebdbb2;
      font-weight: 600;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }
    .badge.stale { background: #f92672; color: #1b1d1e; }
    .badge.tag { background: #3c3836; color: #66d9ef; border: 1px solid #49483e; }
```

### 4.1.b — Markup

Find the Backlog section in the body:
```html
    <div class="section">
      <div class="section-title">Backlog</div>
      <div id="backlogContent" class="loading">
        <div class="skeleton"></div>
      </div>
    </div>
```
Replace with:
```html
    <div class="section">
      <div class="section-title">Backlog</div>
      <button class="backlog-add-btn" onclick="toggleBacklogForm()">+ Add Item</button>
      <form class="backlog-form" id="backlogForm" onsubmit="submitBacklogForm(event)">
        <input type="text" id="bfTitle" placeholder="Title" required />
        <div class="backlog-form-row">
          <select id="bfPriority">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
          </select>
          <select id="bfEnergy">
            <option value="any" selected>Any energy</option>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
            <option value="evening">Evening</option>
            <option value="weekend">Weekend</option>
          </select>
          <input type="number" id="bfEstimate" placeholder="mins" min="5" step="5" value="30" />
        </div>
        <input type="text" id="bfTags" placeholder="Tags (comma separated)" />
        <textarea id="bfNotes" placeholder="Notes (optional)"></textarea>
        <div class="backlog-form-actions">
          <button type="button" onclick="toggleBacklogForm()">Cancel</button>
          <button type="submit" class="primary">Add</button>
        </div>
      </form>
      <div id="backlogContent" class="loading">
        <div class="skeleton"></div>
      </div>
    </div>
```

### 4.1.c — JS: form handlers + richer render

Add these functions in the `<script>` block:
```javascript
    function toggleBacklogForm() {
      const form = document.getElementById('backlogForm');
      form.classList.toggle('open');
      if (form.classList.contains('open')) {
        document.getElementById('bfTitle').focus();
      }
    }

    async function submitBacklogForm(ev) {
      ev.preventDefault();
      const title = document.getElementById('bfTitle').value.trim();
      if (!title) return;
      const tagsRaw = document.getElementById('bfTags').value.trim();
      const body = {
        title,
        priority: document.getElementById('bfPriority').value,
        energy: document.getElementById('bfEnergy').value,
        estimate_minutes: parseInt(document.getElementById('bfEstimate').value, 10) || 30,
        tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
        notes: document.getElementById('bfNotes').value.trim(),
      };
      try {
        const resp = await fetch('/api/calendar/backlog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await resp.json();
        if (result.ok) {
          document.getElementById('backlogForm').reset();
          document.getElementById('bfPriority').value = 'medium';
          document.getElementById('bfEnergy').value = 'any';
          document.getElementById('bfEstimate').value = '30';
          toggleBacklogForm();
          await loadDashboard(true);
        } else {
          alert('Add failed: ' + (result.error || 'unknown'));
        }
      } catch (e) {
        alert('Add failed: ' + e.message);
      }
    }
```

Replace the existing inline backlog rendering (now inside or soon-to-be inside `renderBacklog`) with:
```javascript
    function renderBacklog(data) {
      const container = document.getElementById('backlogContent');
      const items = (data.backlog || []).slice();
      const stale = new Set((data.stale || []).map(i => i.id));
      if (items.length === 0) {
        container.innerHTML = '<div class="empty-state">No backlog items</div>';
        return;
      }
      // Sort: high priority first, then oldest created first
      const rank = { high: 0, medium: 1, low: 2 };
      items.sort((a, b) => {
        const pr = (rank[a.priority] ?? 99) - (rank[b.priority] ?? 99);
        if (pr !== 0) return pr;
        return new Date(a.created) - new Date(b.created);
      });
      let html = '<div class="backlog-list">';
      for (const item of items) {
        const priClass = 'priority-' + item.priority;
        const isStale = stale.has(item.id);
        const ageDays = Math.floor((Date.now() - new Date(item.created).getTime()) / 86400000);
        let badges = '';
        if (isStale) badges += '<span class="badge stale">stale</span>';
        badges += '<span class="badge">' + item.energy + '</span>';
        badges += '<span class="badge">' + item.estimate_minutes + 'm</span>';
        badges += '<span class="badge">' + ageDays + 'd old</span>';
        for (const tag of (item.tags || [])) {
          badges += '<span class="badge tag">#' + tag + '</span>';
        }
        html += \`<div class="backlog-item">
          <div style="flex: 1; min-width: 0;">
            <div class="backlog-title"><span class="\${priClass}">●</span> \${item.title}</div>
            <div class="backlog-badges">\${badges}</div>
          </div>
          <div class="backlog-actions">
            <button class="action-btn" title="Done" onclick="markDone('\${item.id}')">✓</button>
            <button class="action-btn" title="Drop" onclick="markDropped('\${item.id}')">✗</button>
          </div>
        </div>\`;
      }
      html += '</div>';
      container.innerHTML = html;
    }
```

### Verification
- Click "+ Add Item" → form expands.
- Fill title + submit → item appears in the list (via forced refresh).
- Items sorted: high priority first; oldest within priority.
- Badges show energy, duration, age, tags, stale (if >14d old).

---

# Milestone 5 — "Slot It" modal

**Goal:** Click a backlog item's new `⏰` button → modal shows today+week slots that fit the item's `estimate_minutes`; clicking a slot creates a calendar event via `POST /api/calendar/backlog/:id/slot` and marks the item scheduled.

## 5.1 Frontend only (backend already supports `POST /api/calendar/backlog/:id/slot`)

### File: `/Users/nihal/Code/AiTrafficControl/dashboard/server.mjs`

### 5.1.a — CSS

Add:
```css
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 50;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: linear-gradient(180deg, #3a342f 0%, #2a2624 100%);
      border: 1px solid #665c54;
      border-radius: 12px;
      width: 100%;
      max-width: 520px;
      max-height: 80vh;
      overflow-y: auto;
      padding: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .modal-title { font-size: 14px; font-weight: 800; letter-spacing: 0.3px; text-transform: uppercase; color: #fd971f; }
    .modal-subtitle { font-size: 12px; color: #a89984; margin-top: 4px; }
    .modal-close {
      background: transparent;
      border: none;
      color: #a89984;
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
    }
    .slot-option {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      background: #3c3836;
      border: 1px solid #665c54;
      border-left: 3px solid #a6e22e;
      border-radius: 8px;
      margin-bottom: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .slot-option:hover { background: #504945; }
    .slot-option.too-short {
      opacity: 0.4;
      cursor: not-allowed;
      border-left-color: #7e8e91;
    }
    .slot-day-header {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #fd971f;
      margin: 12px 0 6px;
    }
    .slot-day-header:first-child { margin-top: 0; }
```

### 5.1.b — Markup

At the end of the `<div class="calendar-page">` block (just before `</div>` that closes it, which is just before the `<script>` tag), add:
```html
    <div class="modal-backdrop" id="slotModal" onclick="if(event.target.id==='slotModal') closeSlotModal()">
      <div class="modal">
        <div class="modal-header">
          <div>
            <div class="modal-title">Slot It</div>
            <div class="modal-subtitle" id="slotModalSubtitle"></div>
          </div>
          <button class="modal-close" onclick="closeSlotModal()">✕</button>
        </div>
        <div id="slotModalBody"></div>
      </div>
    </div>
```

### 5.1.c — JS

Add ⏰ button in `renderBacklog` inside `.backlog-actions`:
```javascript
            <button class="action-btn" title="Slot it" onclick="openSlotModal('\${item.id}')">⏰</button>
```
Insert it BEFORE the ✓ button in the action row.

Add these functions:
```javascript
    let slotModalItem = null;

    function openSlotModal(itemId) {
      if (!lastState) return;
      const item = (lastState.backlog || []).find(i => i.id === itemId);
      if (!item) return;
      slotModalItem = item;
      document.getElementById('slotModalSubtitle').textContent =
        item.title + ' · needs ' + item.estimate_minutes + 'm';
      const body = document.getElementById('slotModalBody');
      const needed = item.estimate_minutes;

      // Group slots by day: today first, then week
      const groups = [];
      if ((lastState.slots_today || []).length > 0) {
        groups.push({ label: 'Today', slots: lastState.slots_today.map(s => ({ ...s, day: new Date(s.start).toISOString().slice(0,10) })) });
      }
      const weekByDay = {};
      for (const s of (lastState.slots_week || [])) {
        (weekByDay[s.day] = weekByDay[s.day] || []).push(s);
      }
      for (const day of Object.keys(weekByDay).sort()) {
        const dateObj = new Date(day + 'T12:00:00');
        groups.push({ label: dateObj.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), slots: weekByDay[day] });
      }

      if (groups.length === 0) {
        body.innerHTML = '<div class="empty-state">No open slots available</div>';
      } else {
        let html = '';
        for (const g of groups) {
          html += \`<div class="slot-day-header">\${g.label}</div>\`;
          for (const slot of g.slots) {
            const start = new Date(slot.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(slot.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const fits = slot.duration_minutes >= needed;
            const klass = fits ? 'slot-option' : 'slot-option too-short';
            const onClick = fits ? \`onclick="confirmSlot('\${slot.start}', this)"\` : '';
            html += \`<div class="\${klass}" \${onClick}>
              <span>\${start} – \${end}</span>
              <span style="color: #7e8e91; font-size: 11px;">\${formatDuration(slot.duration_minutes)}</span>
            </div>\`;
          }
        }
        body.innerHTML = html;
      }

      document.getElementById('slotModal').classList.add('open');
    }

    function closeSlotModal() {
      document.getElementById('slotModal').classList.remove('open');
      slotModalItem = null;
    }

    async function confirmSlot(slotStartIso, btn) {
      if (!slotModalItem) return;
      const start = new Date(slotStartIso);
      const end = new Date(start.getTime() + slotModalItem.estimate_minutes * 60000);
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
      try {
        const resp = await fetch('/api/calendar/backlog/' + slotModalItem.id + '/slot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start: start.toISOString(), end: end.toISOString() }),
        });
        const result = await resp.json();
        if (result.ok) {
          closeSlotModal();
          await loadDashboard(true);
        } else {
          alert('Slot failed: ' + (result.error || 'unknown'));
          btn.style.pointerEvents = '';
          btn.style.opacity = '';
        }
      } catch (e) {
        alert('Slot failed: ' + e.message);
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
      }
    }
```

### Verification
- Click ⏰ on a backlog item → modal opens with slots grouped by day.
- Slots shorter than the item's estimate are dim and unclickable.
- Click a fitting slot → modal closes; backlog list refreshes; item disappears from pending; new event appears in Today's Brief if start is today.
- Check Google Calendar: event exists with the item's title at the chosen time.

---

# Milestone sequence

1. M1 — backend fix + color classes + now-line. Ship. Verify events are now full-day + colored + separator shown.
2. M2 — weekly view. Ship. Verify tabs.
3. M3 — cache + refresh. Ship. Verify instant load on reload.
4. M4 — add form + richer backlog. Ship. Verify new items persist.
5. M5 — slot-it modal. Ship. Verify GCal events created from backlog.

Do NOT bundle milestones. After each, restart the server and test in browser before starting the next.
