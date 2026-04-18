// Pure rendering functions for provider usage cards
// No dependencies on global state or DOM

function esc(str) {
  const m = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str || '').replace(/[&<>"']/g, (c) => m[c]);
}

function compactPlan(plan) {
  if (!plan) return '';
  const lower = String(plan || '').trim().toLowerCase();
  if (lower === 'pro' || lower === 'claude pro') return 'Pro';
  if (lower === 'max' || lower === 'claude max') return 'Max';
  if (lower === 'team pro') return 'Team Pro';
  if (lower === 'team max') return 'Team Max';
  if (lower === 'oauth' || lower.startsWith('sk-ant')) return 'OAuth';
  if (lower.includes('team')) return 'Team';
  return String(plan || '').slice(0, 12);
}

function cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) {
  const refreshAttr = payload?.nextRefreshAt
    ? ' data-next-refresh-at="' + esc(payload.nextRefreshAt) + '"'
    : '';
  const intervalAttr = payload?.refreshIntervalMs
    ? ' data-refresh-interval-ms="' + String(payload.refreshIntervalMs || 0) + '"'
    : '';
  const refreshBtn = '<button type="button" class="refresh-btn" data-refresh-provider="' + esc(providerKey) + '" aria-label="Refresh ' + esc(title) + ' usage">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 8a6 6 0 1 0 6-6m0-2v4H2"/></svg>' +
  '</button>';

  return '<div class="usage-head"' + refreshAttr + intervalAttr + ' data-usage-refresh="1" data-provider="' + esc(providerKey) + '">' +
    '<div class="card-logo">' + logo + '</div>' +
    '<div class="card-title">' + esc(title) + '</div>' +
    planPill +
    aliasPill +
    switchBtn +
    refreshBtn +
  '</div>';
}

function winRow(window_) {
  if (!window_ || typeof window_ !== 'object') {
    return '<div class="win-row"><div class="win-label">—</div><div class="win-meter"><div class="win-meter-empty" style="width:0"></div></div><div class="win-meta">n/a</div></div>';
  }

  const used = Number(window_.usedPercent || 0);
  const label = window_.label || '—';
  const resetIn = window_.resetIn || '';
  const usedPct = Math.min(100, Math.max(0, used));
  return '<div class="win-row">' +
    '<div class="win-label">' + esc(label) + '</div>' +
    '<div class="win-meter"><div class="win-meter-empty" style="width:' + String(Math.max(100 - usedPct, 0)) + '%"></div></div>' +
    '<div class="win-meta">' + Number(usedPct).toFixed(0) + '%' + (resetIn ? ' · ' + esc(resetIn) : '') + '</div>' +
  '</div>';
}

function renderUsageRow(providerKey, title, payload, options = {}) {
  const {
    logo = '',
    planDisplay = null,
    aliasPill = '',
    switchBtn = '',
    isProfileSwitching = false,
    switchingAlias = '',
  } = options;

  if (payload && payload.loading) {
    const planPill = '<div class="card-plan">Loading</div>';
    return '<article class="usage-row loading" data-provider="' + esc(providerKey) + '">' +
      cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) +
      '<div class="usage-loading"><span class="usage-spinner" aria-hidden="true"></span><span>Loading usage…</span></div>' +
    '</article>';
  }

  if (!payload || !payload.ok) {
    const planPill = '<div class="card-plan">Unavailable</div>';
    return '<article class="usage-row error" data-provider="' + esc(providerKey) + '">' +
      cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) +
      '<div class="usage-error">' + esc(payload?.error || 'Usage unavailable') + '</div>' +
    '</article>';
  }

  const plan = planDisplay !== null ? planDisplay : compactPlan(payload.plan || 'connected');
  const planPill = '<div class="card-plan">' + esc(plan) + '</div>';

  return '<article class="usage-row' + (isProfileSwitching ? ' switching' : '') + '" data-provider="' + esc(providerKey) + '">' +
    cardHead(providerKey, title, logo, planPill, aliasPill, switchBtn, payload) +
    (isProfileSwitching
      ? '<div class="usage-switching-note"><span class="usage-spinner" aria-hidden="true"></span><span>Switching to ' + esc(switchingAlias) + '…</span></div>'
      : '') +
    '<div class="windows">' +
      winRow(payload.primary) +
      winRow(payload.secondary) +
    '</div>' +
  '</article>';
}

export {
  renderUsageRow,
  cardHead,
  winRow,
  compactPlan,
  esc,
};
