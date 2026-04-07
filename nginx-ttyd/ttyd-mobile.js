(function () {
  var MIN_FONT = 10;
  var MAX_FONT = 36;
  var DEFAULT_FONT = 24;
  var STORAGE_KEY = "ttyd_mobile_font_size_v3";
  var WRAP_KEY = "ttyd_mobile_wrap";
  var touchBound = false;
  var railInit = false;
  var historyLoaded = false;
  var keyboardOpen = false;

  function getTerm() {
    if (window.term && window.term.options) return window.term;
    return null;
  }

  function queryParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (_e) {
      return null;
    }
  }

  function parseBool(value, fallback) {
    if (value === null || value === undefined) return fallback;
    var s = String(value).trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    return fallback;
  }

  function mobileFlags() {
    var cfg = window.TTYD_MOBILE_FLAGS || {};
    var scrollbar = parseBool(queryParam("scrollbar"), parseBool(cfg.scrollbar, false));
    var history = parseBool(queryParam("history"), parseBool(cfg.history, false));
    return {
      scrollbar: scrollbar,
      history: history,
    };
  }

  function dispatchResizeTwice() {
    window.dispatchEvent(new Event("resize"));
    setTimeout(function () {
      window.dispatchEvent(new Event("resize"));
    }, 60);
  }

  function updateFontLabel(size) {
    var label = document.getElementById("ttyd-font-size-label");
    if (label) label.textContent = "Font: " + size + "px";
  }

  function readFontSize() {
    var raw = localStorage.getItem(STORAGE_KEY);
    var parsed = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed)) return DEFAULT_FONT;
    return Math.max(MIN_FONT, Math.min(MAX_FONT, parsed));
  }

  function applyFontSize(size) {
    var term = getTerm();
    size = Math.max(MIN_FONT, Math.min(MAX_FONT, size));
    localStorage.setItem(STORAGE_KEY, String(size));
    updateFontLabel(size);
    if (!term) return;
    term.options.fontSize = size;
    dispatchResizeTwice();
    if (typeof term.focus === "function") term.focus();
  }

  function ensureFontApplied(retriesLeft) {
    var term = getTerm();
    if (term) {
      applyFontSize(readFontSize());
      return;
    }
    if (retriesLeft <= 0) return;
    setTimeout(function () {
      ensureFontApplied(retriesLeft - 1);
    }, 120);
  }

  function setWrapEnabled(enabled) {
    var btn = document.getElementById("ttyd-btn-wrap");
    if (btn) {
      btn.textContent = enabled ? "Wrap On" : "Wrap Off";
      btn.classList.toggle("active", enabled);
    }
    localStorage.setItem(WRAP_KEY, enabled ? "1" : "0");
    sendSeq(enabled ? "\x1b[?7h" : "\x1b[?7l");
    dispatchResizeTwice();
  }

  function toggleWrap() {
    var enabled = localStorage.getItem(WRAP_KEY) !== "0";
    setWrapEnabled(!enabled);
  }

  function sendSeq(seq) {
    var term = getTerm();
    if (term && typeof term.input === "function") {
      term.input(seq);
      if (typeof term.focus === "function") term.focus();
    }
  }

  function preloadTmuxHistory() {
    if (historyLoaded) return;
    var term = getTerm();
    if (!term) return;
    historyLoaded = true;

    var session = queryParam("tmuxSession") || "mobile";
    var linesRaw = queryParam("historyLines") || "50000";
    var lines = Math.max(500, Math.min(200000, parseInt(linesRaw, 10) || 50000));
    var mark = "ttyd_history_loaded_" + session + "_" + lines;
    if (window.sessionStorage && sessionStorage.getItem(mark) === "1") return;

    fetch("/ttyd-history?session=" + encodeURIComponent(session) + "&lines=" + lines, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        if (!text) return;
        term.clear();
        term.write(text.replace(/\\n/g, "\\r\\n"));
        term.write("\\r\\n");
        dispatchResizeTwice();
        if (window.sessionStorage) sessionStorage.setItem(mark, "1");
      })
      .catch(function (e) {
        console.warn("history preload failed:", e);
      });
  }

  function setKeyboardOffset(px) {
    var n = Math.max(0, Math.round(px || 0));
    document.documentElement.style.setProperty("--ttyd-kb-offset", n + "px");
    setKeyboardOpen(n >= 40);
    updateToolbarHeight();
  }

  function toolbar() {
    return document.getElementById("ttyd-mobile-toolbar");
  }

  function drawer() {
    return document.getElementById("ttyd-toolbar-drawer");
  }

  function updateToolbarHeight() {
    var tb = toolbar();
    if (!tb) return;
    var h = Math.max(70, Math.round(tb.offsetHeight || 0));
    document.documentElement.style.setProperty("--ttyd-toolbar-height", h + "px");
  }

  function setKeyboardOpen(open) {
    if (keyboardOpen === !!open) return;
    keyboardOpen = !!open;
    var tb = toolbar();
    if (!tb) return;
    tb.classList.toggle("keyboard-open", keyboardOpen);
    if (!keyboardOpen) closeDrawer();
  }

  function openDrawer() {
    var tb = toolbar();
    var panel = drawer();
    var trigger = document.getElementById("ttyd-btn-more");
    if (!tb || !panel) return;
    panel.hidden = false;
    tb.classList.add("drawer-open");
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    updateToolbarHeight();
  }

  function closeDrawer() {
    var tb = toolbar();
    var panel = drawer();
    var trigger = document.getElementById("ttyd-btn-more");
    if (!tb || !panel) return;
    panel.hidden = true;
    tb.classList.remove("drawer-open");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    updateToolbarHeight();
  }

  function toggleDrawer() {
    var panel = drawer();
    if (!panel) return;
    if (panel.hidden) openDrawer();
    else closeDrawer();
  }

  function keyboardOffsetFromVisualViewport() {
    var vv = window.visualViewport;
    if (!vv) return 0;
    var raw = window.innerHeight - (vv.height + vv.offsetTop);
    if (!Number.isFinite(raw)) return 0;
    if (raw < 0) return 0;
    // Ignore tiny browser chrome jitters; only treat larger inset as keyboard.
    if (raw < 24) return 0;
    return raw;
  }

  function installKeyboardAvoidance() {
    var vv = window.visualViewport;
    if (!vv) return;
    var raf = 0;
    var settleTimer = 0;

    function schedule() {
      if (raf) return;
      raf = window.requestAnimationFrame(function () {
        raf = 0;
        setKeyboardOffset(keyboardOffsetFromVisualViewport());
      });
    }

    function stopSettleChecks() {
      if (!settleTimer) return;
      clearInterval(settleTimer);
      settleTimer = 0;
    }

    function startSettleChecks() {
      stopSettleChecks();
      var tries = 0;
      settleTimer = setInterval(function () {
        tries += 1;
        schedule();
        if (keyboardOffsetFromVisualViewport() <= 0 || tries >= 15) {
          stopSettleChecks();
        }
      }, 120);
    }

    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", function () {
      // Android browsers sometimes lag viewport updates after keyboard close.
      setTimeout(schedule, 160);
      setTimeout(startSettleChecks, 220);
    });
    window.addEventListener("orientationchange", function () {
      setTimeout(schedule, 120);
      setTimeout(startSettleChecks, 220);
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") schedule();
    });
    schedule();
  }

  function bindTouchScroll() {
    if (touchBound) return;
    var viewport = document.querySelector(".xterm .xterm-viewport");
    if (!viewport) return;
    touchBound = true;

    var touchStartY = 0;
    var touchStartX = 0;
    var scrollStart = 0;
    var draggingScroll = false;

    viewport.addEventListener(
      "touchstart",
      function (e) {
        if (!e.touches || e.touches.length !== 1) return;
        var t = e.touches[0];
        touchStartY = t.clientY;
        touchStartX = t.clientX;
        scrollStart = viewport.scrollTop;
        draggingScroll = false;
      },
      { passive: true }
    );

    viewport.addEventListener(
      "touchmove",
      function (e) {
        if (!e.touches || e.touches.length !== 1) return;
        var t = e.touches[0];
        var dy = touchStartY - t.clientY;
        var dx = touchStartX - t.clientX;

        if (!draggingScroll) {
          if (Math.abs(dy) < 4) return;
          if (Math.abs(dy) < Math.abs(dx)) return;
          draggingScroll = true;
        }

        viewport.scrollTop = scrollStart + dy;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { passive: false, capture: true }
    );
  }

  function ensureScrollRail() {
    if (railInit) return;
    var viewport = document.querySelector(".xterm .xterm-viewport");
    if (!viewport) return;
    railInit = true;

    var rail = document.createElement("div");
    rail.id = "ttyd-scroll-rail";
    rail.innerHTML =
      '<button id="ttyd-scroll-up" type="button">▲</button>' +
      '<div id="ttyd-scroll-track"><div id="ttyd-scroll-thumb"></div></div>' +
      '<button id="ttyd-scroll-down" type="button">▼</button>';
    document.body.appendChild(rail);

    var upBtn = rail.querySelector("#ttyd-scroll-up");
    var downBtn = rail.querySelector("#ttyd-scroll-down");
    var track = rail.querySelector("#ttyd-scroll-track");
    var thumb = rail.querySelector("#ttyd-scroll-thumb");
    var dragging = false;
    var dragStartY = 0;
    var dragStartTop = 0;

    function maxScroll() {
      return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }

    function setByRatio(ratio) {
      ratio = Math.max(0, Math.min(1, ratio));
      viewport.scrollTop = ratio * maxScroll();
      syncThumb();
    }

    function syncThumb() {
      var ms = maxScroll();
      if (ms <= 0) {
        rail.classList.add("hidden");
        thumb.style.top = "0px";
        thumb.style.height = Math.max(20, track.clientHeight * 0.8) + "px";
        return;
      }
      rail.classList.remove("hidden");
      var visibleRatio = Math.max(0.08, viewport.clientHeight / viewport.scrollHeight);
      var thumbH = Math.max(24, Math.floor(track.clientHeight * visibleRatio));
      var travel = Math.max(1, track.clientHeight - thumbH);
      var ratio = viewport.scrollTop / ms;
      thumb.style.height = thumbH + "px";
      thumb.style.top = Math.round(travel * ratio) + "px";
    }

    function scrollBy(delta) {
      viewport.scrollTop += delta;
      syncThumb();
    }

    upBtn.addEventListener("click", function () {
      scrollBy(-Math.max(40, viewport.clientHeight * 0.5));
    });
    downBtn.addEventListener("click", function () {
      scrollBy(Math.max(40, viewport.clientHeight * 0.5));
    });

    track.addEventListener("click", function (e) {
      if (e.target === thumb) return;
      var rect = track.getBoundingClientRect();
      var y = e.clientY - rect.top;
      setByRatio(y / Math.max(1, rect.height));
    });

    thumb.addEventListener(
      "touchstart",
      function (e) {
        if (!e.touches || e.touches.length !== 1) return;
        dragging = true;
        dragStartY = e.touches[0].clientY;
        dragStartTop = parseFloat(thumb.style.top || "0") || 0;
        e.preventDefault();
      },
      { passive: false }
    );

    thumb.addEventListener("mousedown", function (e) {
      dragging = true;
      dragStartY = e.clientY;
      dragStartTop = parseFloat(thumb.style.top || "0") || 0;
      e.preventDefault();
    });

    function onDragMove(clientY) {
      var h = parseFloat(thumb.style.height || "24") || 24;
      var travel = Math.max(1, track.clientHeight - h);
      var top = Math.max(0, Math.min(travel, dragStartTop + (clientY - dragStartY)));
      thumb.style.top = top + "px";
      viewport.scrollTop = (top / travel) * maxScroll();
    }

    document.addEventListener(
      "touchmove",
      function (e) {
        if (!dragging || !e.touches || e.touches.length !== 1) return;
        onDragMove(e.touches[0].clientY);
        e.preventDefault();
      },
      { passive: false }
    );

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      onDragMove(e.clientY);
      e.preventDefault();
    });

    document.addEventListener("touchend", function () {
      dragging = false;
    });
    document.addEventListener("mouseup", function () {
      dragging = false;
    });

    viewport.addEventListener("scroll", syncThumb, { passive: true });
    window.addEventListener("resize", syncThumb);
    setInterval(syncThumb, 300);
    syncThumb();
  }

  window.__ttydMobileSendSeq = sendSeq;

  function bind(id, seq, closeAfter) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", function () {
      sendSeq(seq);
      if (closeAfter) closeDrawer();
    });
  }

  bind("ttyd-btn-ctrlc", "\x03");
  bind("ttyd-btn-esc", "\x1b");
  bind("ttyd-btn-tab", "\x09");
  bind("ttyd-btn-up", "\x1b[A");
  bind("ttyd-btn-down", "\x1b[B");
  bind("ttyd-btn-esc-alt", "\x1b", true);
  bind("ttyd-btn-tab-alt", "\x09", true);
  bind("ttyd-btn-up-alt", "\x1b[A", true);
  bind("ttyd-btn-down-alt", "\x1b[B", true);

  var wrapBtn = document.getElementById("ttyd-btn-wrap");
  if (wrapBtn) {
    wrapBtn.addEventListener("click", function () {
      toggleWrap();
      closeDrawer();
    });
  }

  var decBtn = document.getElementById("ttyd-btn-font-dec");
  if (decBtn) {
    decBtn.addEventListener("click", function () {
      var current = readFontSize();
      applyFontSize(current - 1);
      closeDrawer();
    });
  }

  var incBtn = document.getElementById("ttyd-btn-font-inc");
  if (incBtn) {
    incBtn.addEventListener("click", function () {
      var current = readFontSize();
      applyFontSize(current + 1);
      closeDrawer();
    });
  }

  var moreBtn = document.getElementById("ttyd-btn-more");
  if (moreBtn) moreBtn.addEventListener("click", toggleDrawer);

  document.addEventListener("click", function (e) {
    var tb = toolbar();
    var panel = drawer();
    if (!tb || !panel || panel.hidden) return;
    if (tb.contains(e.target)) return;
    closeDrawer();
  });

  window.addEventListener("load", function () {
    var flags = mobileFlags();
    var initialFont = readFontSize();
    updateFontLabel(initialFont);
    applyFontSize(initialFont);
    ensureFontApplied(20);
    setWrapEnabled(localStorage.getItem(WRAP_KEY) !== "0");
    installKeyboardAvoidance();
    bindTouchScroll();
    if (flags.scrollbar) ensureScrollRail();
    if (flags.history) setTimeout(preloadTmuxHistory, 120);
    updateToolbarHeight();
  });

  window.addEventListener("resize", function () {
    bindTouchScroll();
    if (mobileFlags().scrollbar) ensureScrollRail();
    updateToolbarHeight();
  });
})();
