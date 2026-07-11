// ==UserScript==
// @name         Torn Target Tracker
// @namespace    https://github.com/mat-mcc-uk
// @version      1.0.1
// @description  Mug target identification and tracking using TornStats spy data
// @author       mat-mcc-uk
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/mat-mcc-uk/torn-target-tracker/main/torn-target-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/mat-mcc-uk/torn-target-tracker/main/torn-target-tracker.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      www.tornstats.com
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const MUG_COOLDOWN_MS   = 5 * 60 * 1000;         // 5 minutes between mugs
  const SPY_CACHE_MS      = 6 * 60 * 60 * 1000;    // re-fetch spy at most every 6h (TS rate limit)
  const STATS_REFRESH_MS  = 60 * 60 * 1000;        // refresh own stats every hour
  const SEED_INTERVAL_MS  = 6 * 60 * 60 * 1000;    // re-seed attack log every 6h
  const MAX_ATTACKS       = 50;                     // attack records kept per target
  const ROUTE_DEBOUNCE_MS = 350;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let tornApiKey     = GM_getValue('ttt_tornKey', '');
  let tsApiKey       = GM_getValue('ttt_tsKey', '');
  let myStats        = GM_getValue('ttt_myStats', null);
  let myStatsFetched = GM_getValue('ttt_myStatsFetched', 0);
  let targetDB       = GM_getValue('ttt_targetDB', {});
  let panelPos       = GM_getValue('ttt_panelPos', null);
  let sortMode       = GM_getValue('ttt_sortMode', 'score');
  let seedFetched    = GM_getValue('ttt_seedFetched', 0);
  let dom            = {};

  // ---------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------
  let dbTimer = null;
  function saveDB() {
    clearTimeout(dbTimer);
    dbTimer = setTimeout(() => GM_setValue('ttt_targetDB', targetDB), 500);
  }

  // ---------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch { reject(new Error('Bad JSON from ' + url)); }
          } else {
            reject(new Error('HTTP ' + r.status));
          }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  function tornFetch(path, selections) {
    return gmFetch(`https://api.torn.com/${path}?selections=${selections}&key=${tornApiKey}`);
  }

  // ---------------------------------------------------------------
  // Own stats
  // ---------------------------------------------------------------
  async function refreshMyStats(force = false) {
    if (!tornApiKey) return;
    if (!force && Date.now() - myStatsFetched < STATS_REFRESH_MS) return;
    try {
      const d = await tornFetch('user/', 'basic,battlestats');
      if (d.error) return;
      myStats = {
        tornId:     d.player_id,
        name:       d.name,
        level:      d.level,
        strength:   d.strength   || 0,
        defense:    d.defense    || 0,
        speed:      d.speed      || 0,
        dexterity:  d.dexterity  || 0,
        total:      (d.strength || 0) + (d.defense || 0) + (d.speed || 0) + (d.dexterity || 0),
      };
      myStatsFetched = Date.now();
      GM_setValue('ttt_myStats', myStats);
      GM_setValue('ttt_myStatsFetched', myStatsFetched);
    } catch { /* silent */ }
  }

  // ---------------------------------------------------------------
  // Attack log seeding
  // ---------------------------------------------------------------
  async function seedAttackLog() {
    if (!tornApiKey || !myStats) return;
    if (Date.now() - seedFetched < SEED_INTERVAL_MS) return;
    try {
      const d = await tornFetch('user/', 'attacksfull');
      if (d.error || !d.attacks) return;
      let changed = false;
      for (const atk of Object.values(d.attacks)) {
        // Only attacks where we were the attacker
        if (atk.attacker_id !== myStats.tornId) continue;
        const id = String(atk.defender_id);
        if (!targetDB[id]) {
          targetDB[id] = blankTarget(id, atk.defender_name || '', '');
        }
        const pushed = pushAttack(id, {
          ts:            atk.timestamp_ended || atk.timestamp_started,
          outcome:       normaliseResult(atk.result),
          cashTaken:     0,      // attacksfull doesn't carry cash — populated from DOM on live hits
          respectGained: atk.respect || 0,
        });
        if (pushed) changed = true;
      }
      if (changed) saveDB();
      seedFetched = Date.now();
      GM_setValue('ttt_seedFetched', seedFetched);
    } catch { /* silent */ }
  }

  function normaliseResult(r) {
    const s = (r || '').toLowerCase();
    if (['mugged', 'hospitalized', 'attacked'].includes(s)) return 'won';
    if (s === 'lost') return 'lost';
    if (s === 'stalemate' || s === 'escape' || s === 'timeout') return 'stalemate';
    return s;
  }

  // ---------------------------------------------------------------
  // Target helpers
  // ---------------------------------------------------------------
  function blankTarget(id, name, factionName) {
    return {
      id,
      name:             name || `Player ${id}`,
      level:            0,
      factionName:      factionName || '',
      factionId:        0,
      spy:              null,
      spyFetchedAt:     0,
      attacks:          [],
      lastActionTs:     0,
      lastActionStatus: 'Unknown',
      status:           'Unknown',
      hospitalUntil:    null,
      starred:          false,
      notes:            '',
      addedAt:          Date.now(),
    };
  }

  // Returns true if the record was new and inserted.
  function pushAttack(id, record) {
    const t = targetDB[id];
    if (!t) return false;
    if (t.attacks.some(a => a.ts === record.ts)) return false;
    t.attacks.unshift(record);
    if (t.attacks.length > MAX_ATTACKS) t.attacks.length = MAX_ATTACKS;
    return true;
  }

  // ---------------------------------------------------------------
  // Profile fetch
  // ---------------------------------------------------------------
  async function fetchProfile(id) {
    if (!tornApiKey) return;
    try {
      const d = await tornFetch(`user/${id}`, 'profile');
      if (d.error) return;
      const t = targetDB[id] || (targetDB[id] = blankTarget(id, '', ''));
      t.name             = d.name;
      t.level            = d.level;
      t.factionName      = d.faction?.faction_name || '';
      t.factionId        = d.faction?.faction_id   || 0;
      t.lastActionTs     = d.last_action?.timestamp || 0;
      t.lastActionStatus = d.last_action?.status    || 'Unknown';
      t.status           = d.status?.state          || 'Unknown';
      t.statusDescription = d.status?.description   || '';
      t.hospitalUntil    = d.status?.until          || null;
      saveDB();
    } catch { /* silent */ }
  }

  // ---------------------------------------------------------------
  // TornStats spy fetch
  // ---------------------------------------------------------------
  async function fetchSpy(id, force = false) {
    if (!tsApiKey) return null;
    const t = targetDB[id];
    if (!t) return null;
    if (!force && t.spyFetchedAt && Date.now() - t.spyFetchedAt < SPY_CACHE_MS) return t.spy;
    try {
      const d = await gmFetch(`https://www.tornstats.com/api/v1/${tsApiKey}/spy/user/${id}`);
      t.spyFetchedAt = Date.now();
      const spy = d?.spy;
      if (!spy || !spy.status || !(spy.total > 0)) {
        t.spy = null;
      } else {
        t.spy = {
          strength:  spy.strength  || 0,
          defense:   spy.defense   || 0,
          speed:     spy.speed     || 0,
          dexterity: spy.dexterity || 0,
          total:     spy.total     || 0,
          // TornStats returns age as a human string: "18 hours ago", "3 days ago"
          timestamp: parseSpyAge(spy.difference),
        };
      }
      saveDB();
      return t.spy;
    } catch {
      return null;
    }
  }

  function parseSpyAge(str) {
    const now = Date.now() / 1000;
    if (!str) return now;
    const m = str.match(/(\d+)\s+(minute|hour|day|week|month)/);
    if (!m) return now;
    const n = parseInt(m[1]);
    const u = m[2];
    const secs = { minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000 };
    return now - n * (secs[u] || 0);
  }

  // ---------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------
  function beatableScore(t) {
    const spy     = t.spy;
    const attacks = t.attacks || [];
    const wins    = attacks.filter(a => a.outcome === 'won').length;
    const total   = attacks.length;

    // Real spy data path
    if (spy && spy.total > 0 && myStats?.total > 0) {
      const ratio = myStats.total / spy.total;
      let score =
        ratio >= 3.0 ? 97 :
        ratio >= 2.0 ? 88 :
        ratio >= 1.4 ? 75 :
        ratio >= 1.1 ? 60 :
        ratio >= 0.9 ? 45 :
        ratio >= 0.7 ? 28 : 12;

      // Discount stale spy data
      const ageDays = (Date.now() / 1000 - spy.timestamp) / 86400;
      if (ageDays > 60) score = Math.round(score * 0.6);
      else if (ageDays > 30) score = Math.round(score * 0.78);
      else if (ageDays > 14) score = Math.round(score * 0.9);

      // Blend with actual win rate when we have enough fights
      if (total >= 5) {
        score = Math.round(score * 0.55 + (wins / total) * 100 * 0.45);
      }
      return clamp(score, 0, 100);
    }

    // Win rate from fight history (3+ fights)
    if (total >= 3) return Math.round((wins / total) * 100);

    // Level proxy — labelled as estimate in the UI
    if (myStats?.level && t.level > 0) {
      const lr = myStats.level / t.level;
      return lr >= 1.5 ? 72 : lr >= 1.0 ? 55 : lr >= 0.8 ? 40 : 25;
    }

    return null; // genuinely unknown
  }

  function cashScore(t) {
    let score = 0;

    // Level base: cap at 20 points
    score += Math.min(20, (t.level || 1) * 0.28);

    // Cash history: average taken, capped at 45 points ($5M = full)
    const cashHits = (t.attacks || [])
      .filter(a => a.outcome === 'won' && a.cashTaken > 0)
      .map(a => a.cashTaken);
    if (cashHits.length > 0) {
      const avg = cashHits.reduce((a, b) => a + b, 0) / cashHits.length;
      score += Math.min(45, avg / 111111);
    }

    // Activity recency: up to 10 points
    const ageMs = Date.now() - (t.lastActionTs || 0) * 1000;
    if (ageMs < 3_600_000)   score += 10;
    else if (ageMs < 14_400_000) score += 4;

    // Returning traveller: strong signal. Torn players often carry cash from
    // selling items abroad, and can't bank until they land.
    if (t.status === 'Traveling' && /torn/i.test(t.statusDescription || '')) {
      score += 25;
    }

    // Hospital: can't bank while inside (base bonus).
    if (t.status === 'Hospital') {
      score += 8;
      // Releasing soon: they've been sitting with wallet cash; worth hitting
      // shortly after release before they bank.
      if (t.hospitalUntil) {
        const minsUntilRelease = (t.hospitalUntil * 1000 - Date.now()) / 60000;
        if (minsUntilRelease > 0 && minsUntilRelease < 60) score += 7;
      }
    }

    // Mug protection penalty: our last successful hit started a 12h protection
    // window. Only the unprotected portion above the previous mug amount is
    // accessible. Flag this so the score reflects reality.
    const lastWin = (t.attacks || []).find(a => a.outcome === 'won' && a.cashTaken > 0);
    if (lastWin) {
      const protExpiry = lastWin.ts * 1000 + 12 * 60 * 60 * 1000;
      if (protExpiry > Date.now()) score = Math.round(score * 0.25);
    }

    return clamp(Math.round(score), 0, 100);
  }

  function combinedScore(t) {
    const b = beatableScore(t);
    const c = cashScore(t);
    return {
      b,
      c,
      score: b !== null ? Math.round(b * 0.55 + c * 0.45) : null,
    };
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function formatCash(n) {
    if (!n) return '$0';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + n;
  }

  function formatStats(n) {
    if (!n) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  function scoreColour(s) {
    if (s === null || s === undefined) return '#888';
    if (s >= 70) return '#9fe8b0';
    if (s >= 45) return '#f0d27a';
    return '#f0a0a0';
  }

  function statusIcon(t) {
    if (t.status === 'Hospital')                          return '🔴';
    if (t.status === 'Traveling')                         return '✈️';
    if (t.status === 'Jail' || t.status === 'Federal')    return '🔒';
    if (t.lastActionStatus === 'Online')                  return '🟢';
    if (t.lastActionStatus === 'Idle')                    return '🟡';
    return '⚫';
  }

  function mugCooldownStr(t) {
    const last = (t.attacks || [])[0];
    if (!last) return null;
    const elapsed = Date.now() - last.ts * 1000;
    if (elapsed >= MUG_COOLDOWN_MS) return null;
    const rem = MUG_COOLDOWN_MS - elapsed;
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function spyAgeStr(spy) {
    if (!spy) return 'No spy';
    const days = (Date.now() / 1000 - spy.timestamp) / 86400;
    if (days < 1)  return 'Today';
    if (days < 2)  return '1d old';
    if (days < 7)  return `${Math.floor(days)}d old`;
    if (days < 30) return `${Math.floor(days / 7)}wk old`;
    return `${Math.floor(days / 30)}mo old`;
  }

  function avgCashStr(t) {
    const hits = (t.attacks || []).filter(a => a.outcome === 'won' && a.cashTaken > 0);
    if (!hits.length) return null;
    const avg = hits.reduce((a, b) => a + b.cashTaken, 0) / hits.length;
    return formatCash(avg) + ` avg (${hits.length})`;
  }

  // Variance and trend for cash history. Returns null when insufficient data.
  function cashStats(t) {
    const hits = (t.attacks || [])
      .filter(a => a.outcome === 'won' && a.cashTaken > 0)
      .map(a => a.cashTaken);
    if (hits.length < 2) return null;
    const avg = hits.reduce((a, b) => a + b, 0) / hits.length;
    const stdDev = Math.sqrt(hits.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / hits.length);
    const cv = stdDev / avg; // coefficient of variation: low = consistent, high = erratic
    let trend = null;
    if (hits.length >= 4) {
      const recentAvg = hits.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      const olderAvg  = hits.slice(3).reduce((a, b) => a + b, 0) / (hits.length - 3);
      if (olderAvg > 0) trend = Math.round(((recentAvg - olderAvg) / olderAvg) * 100);
    }
    return { avg, stdDev, cv, trend };
  }

  // Returns an array of { type, label, detail } objects representing signals
  // about whether this target is likely carrying significant cash right now.
  //   type: 'good' | 'warn' | 'bad' | 'info'
  function walletSignals(t) {
    const signals = [];

    // Returning traveller — strongest positive signal.
    if (t.status === 'Traveling' && /torn/i.test(t.statusDescription || '')) {
      const landMs = t.hospitalUntil ? t.hospitalUntil * 1000 : null;
      const detail = landMs
        ? `lands in ~${Math.max(1, Math.ceil((landMs - Date.now()) / 60000))}m`
        : 'in transit to Torn';
      signals.push({ type: 'good', label: '✈️ Returning to Torn', detail });
    }

    // Mug protection — strongest negative signal.
    const lastWin = (t.attacks || []).find(a => a.outcome === 'won' && a.cashTaken > 0);
    if (lastWin) {
      const protExpiry = lastWin.ts * 1000 + 12 * 60 * 60 * 1000;
      const minsLeft = (protExpiry - Date.now()) / 60000;
      if (minsLeft > 0) {
        signals.push({
          type: 'bad',
          label: '🛡 Mug protection active',
          detail: `we hit them ${Math.ceil((Date.now() - lastWin.ts * 1000) / 60000)}m ago — expires in ${Math.ceil(minsLeft)}m`,
        });
      }
    }

    // Hospital status with release timing.
    if (t.status === 'Hospital') {
      if (t.hospitalUntil) {
        const minsLeft = Math.max(0, (t.hospitalUntil * 1000 - Date.now()) / 60000);
        if (minsLeft < 60) {
          signals.push({
            type: 'good',
            label: `🏥 Releasing in ~${Math.ceil(minsLeft)}m`,
            detail: 'cannot bank while inside — hit after release',
          });
        } else {
          signals.push({
            type: 'info',
            label: '🏥 In hospital',
            detail: `${Math.ceil(minsLeft)}m remaining — cannot bank`,
          });
        }
      } else {
        signals.push({ type: 'info', label: '🏥 In hospital', detail: 'cannot bank' });
      }
    }

    // Cash consistency (requires 3+ wins with cash recorded).
    const stats = cashStats(t);
    if (stats) {
      if (stats.cv < 0.3) {
        signals.push({
          type: 'good',
          label: '💰 Consistent carrier',
          detail: `avg ${formatCash(stats.avg)} ±${formatCash(stats.stdDev)}`,
        });
      } else if (stats.cv > 0.8) {
        signals.push({
          type: 'warn',
          label: '🎲 Erratic — high variance',
          detail: `avg ${formatCash(stats.avg)} ±${formatCash(stats.stdDev)}`,
        });
      }
    }

    // Cash trend (requires 4+ wins to compare recent vs older).
    if (stats != null && stats.trend != null && Math.abs(stats.trend) >= 25) {
      signals.push({
        type: stats.trend > 0 ? 'good' : 'warn',
        label: stats.trend > 0
          ? `📈 Cash up ${stats.trend}% recently`
          : `📉 Cash down ${Math.abs(stats.trend)}% recently`,
        detail: 'comparing last 3 hits to older history',
      });
    }

    // Low yield warning — likely 7★ clothing.
    if (stats && stats.avg < 200000 && (t.level || 0) > 30) {
      signals.push({
        type: 'bad',
        label: '⚠️ Low yield — likely 7★ clothing',
        detail: '75% mug reduction active — probably not worth the energy',
      });
    }

    // Online/recently active (positive if no other strong signals).
    const ageMs = Date.now() - (t.lastActionTs || 0) * 1000;
    if (ageMs < 1_800_000 && t.status !== 'Hospital') {
      signals.push({
        type: 'info',
        label: '🟢 Active in last 30m',
        detail: 'likely doing crimes or trading',
      });
    }

    return signals;
  }

  // Single-line compact summary for the panel list row. Shows the most
  // important signal only so rows stay scannable.
  function topSignalChip(t) {
    const sigs = walletSignals(t);
    if (!sigs.length) return '';
    // Priority order: bad signals first (protection), then good (returning), then info
    const priority = ['bad', 'good', 'warn', 'info'];
    const top = priority.reduce((found, type) => found || sigs.find(s => s.type === type), null);
    if (!top) return '';
    const colour = { good: '#9fe8b0', warn: '#f0d27a', bad: '#f0a0a0', info: '#888' }[top.type];
    return `<span style="color:${colour};font-size:10px">${top.label}</span>`;
  }

  function fightRecordStr(t) {
    const atks = t.attacks || [];
    if (!atks.length) return 'No history';
    const w = atks.filter(a => a.outcome === 'won').length;
    const l = atks.filter(a => a.outcome === 'lost').length;
    return `${w}W / ${l}L`;
  }

  // ---------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------
  GM_addStyle(`
    #ttt-panel {
      position: fixed;
      bottom: 110px;
      right: 10px;
      width: 370px;
      max-width: calc(100vw - 20px);
      max-height: 75vh;
      overflow-y: auto;
      background: #1b1b1b;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 6px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      z-index: 9998;
      box-shadow: 0 2px 10px rgba(0,0,0,0.5);
    }
    #ttt-panel.ttt-col .ttt-body,
    #ttt-panel.ttt-col .ttt-settings { display: none !important; }
    #ttt-panel h3 {
      margin: 0; padding: 8px 10px;
      background: #2a2a2a; border-bottom: 1px solid #444;
      cursor: move; touch-action: none;
      display: flex; justify-content: space-between; align-items: center;
      user-select: none; font-size: 13px;
    }
    #ttt-panel.ttt-drag { box-shadow: 0 4px 20px rgba(240,160,100,0.35); opacity: 0.95; }
    .ttt-body { padding: 8px 10px; }
    .ttt-settings {
      padding: 8px 10px; border-bottom: 1px solid #333;
      display: none; font-size: 11px;
    }
    .ttt-settings label { display: block; color: #aaa; margin-bottom: 3px; }
    .ttt-settings input, .ttt-settings select {
      background: #2a2a2a; color: #e0e0e0;
      border: 1px solid #555; border-radius: 3px; padding: 3px 5px;
    }
    .ttt-settings input[type=password], .ttt-settings input[type=text] {
      width: 100%; box-sizing: border-box; margin-bottom: 6px;
    }
    .ttt-btn {
      background: #333; color: #e0e0e0;
      border: 1px solid #555; border-radius: 3px;
      padding: 3px 8px; cursor: pointer; font-size: 11px;
    }
    .ttt-btn:hover { background: #444; }
    .ttt-btn.ttt-green { background: #1e5631; color: #9fe8b0; border-color: #2d7d47; }
    .ttt-btn.ttt-red { background: #4a2424; color: #f0a0a0; border-color: #7a3838; }
    .ttt-icon-btn {
      background: none; border: none; color: #e0e0e0;
      cursor: pointer; font-size: 13px; padding: 0 2px;
    }
    .ttt-add-row { display: flex; gap: 6px; margin-bottom: 8px; }
    .ttt-add-row input {
      width: 90px; background: #2a2a2a; color: #e0e0e0;
      border: 1px solid #555; border-radius: 3px; padding: 3px 5px;
      font-size: 11px;
    }
    .ttt-row {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 0; border-bottom: 1px solid #222; cursor: pointer;
    }
    .ttt-row:hover { background: #212121; }
    .ttt-badge {
      min-width: 28px; text-align: center; font-weight: bold;
      font-size: 11px; padding: 2px 4px; border-radius: 3px;
      background: #2a2a2a; flex-shrink: 0;
    }
    .ttt-row-name { flex: 1; font-size: 11px; overflow: hidden; }
    .ttt-row-name .ttt-sub { color: #666; font-size: 10px; }
    .ttt-row-meta { text-align: right; font-size: 10px; color: #888; flex-shrink: 0; }
    .ttt-cd { color: #f0d27a; }
    .ttt-empty { color: #666; text-align: center; padding: 18px 0; font-size: 11px; }
    .ttt-del { background: none; border: none; color: #555; cursor: pointer; font-size: 11px; padding: 0 2px; }
    .ttt-del:hover { color: #f0a0a0; }

    /* Profile page overlay */
    #ttt-overlay {
      background: #1b1b1b; border: 1px solid #444; border-radius: 6px;
      padding: 10px 12px; margin: 10px 0;
      font-family: Arial, sans-serif; font-size: 12px; color: #e0e0e0;
    }
    #ttt-overlay .ttt-ov-h { font-weight: bold; color: #aaa; font-size: 11px; margin-bottom: 8px; }
    #ttt-overlay .ttt-ov-r { display: flex; justify-content: space-between; margin-bottom: 4px; }
    #ttt-overlay .ttt-ov-l { color: #888; }
    #ttt-overlay .ttt-ov-v { font-weight: bold; }
    #ttt-overlay .ttt-ov-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  `);

  // ---------------------------------------------------------------
  // Home panel
  // ---------------------------------------------------------------
  function ensurePanel() {
    if (document.getElementById('ttt-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ttt-panel';
    panel.classList.add('ttt-col');
    panel.innerHTML = `
      <h3>
        <span>🎯 Target Tracker</span>
        <span style="display:flex;gap:4px;align-items:center">
          <button class="ttt-icon-btn" id="ttt-gear" title="Settings">⚙</button>
          <button class="ttt-icon-btn" id="ttt-tog">▲</button>
        </span>
      </h3>
      <div class="ttt-settings" id="ttt-settings">
        <label>Torn API key (Limited Access minimum)</label>
        <input id="ttt-tk" type="password" value="${tornApiKey}" placeholder="16-char key">
        <label>TornStats API key</label>
        <input id="ttt-sk" type="password" value="${tsApiKey}" placeholder="TornStats key">
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button class="ttt-btn" id="ttt-save-keys">Save keys</button>
          <button class="ttt-btn" id="ttt-reseed">↻ Re-seed log</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:4px">
          <select class="ttt-btn" id="ttt-sort" style="flex:1">
            <option value="score"  ${sortMode==='score' ?'selected':''}>Sort: Overall</option>
            <option value="beat"   ${sortMode==='beat'  ?'selected':''}>Sort: Beatable</option>
            <option value="cash"   ${sortMode==='cash'  ?'selected':''}>Sort: Cash score</option>
            <option value="recent" ${sortMode==='recent'?'selected':''}>Sort: Recent</option>
          </select>
          <button class="ttt-btn" id="ttt-refresh-all" title="Refresh all profiles">↻ All</button>
        </div>
        <div style="display:flex;gap:6px">
          <button class="ttt-btn ttt-red" id="ttt-clear">Clear all targets</button>
          <button class="ttt-btn" id="ttt-reset-pos">Reset position</button>
        </div>
      </div>
      <div class="ttt-body">
        <div class="ttt-add-row">
          <input id="ttt-add-id" type="number" placeholder="Player ID">
          <button class="ttt-btn ttt-green" id="ttt-add">+ Add</button>
        </div>
        <div id="ttt-list"></div>
      </div>
    `;
    document.body.appendChild(panel);
    if (panelPos) applyPos(panel, panelPos);

    dom.list = document.getElementById('ttt-list');

    wirePanelHandlers(panel);
    renderList();
    setInterval(() => {
      if (!panel.classList.contains('ttt-col')) tickCooldowns();
    }, 1000);
  }

  function wirePanelHandlers(panel) {
    // Drag
    const hdr = panel.querySelector('h3');
    let drag = null;
    hdr.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, pl: r.left, pt: r.top, moved: false, pid: e.pointerId };
      try { hdr.setPointerCapture(e.pointerId); } catch {}
    });
    hdr.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      panel.classList.add('ttt-drag');
      applyPos(panel, { left: drag.pl + dx, top: drag.pt + dy });
      e.preventDefault();
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      const wasDrag = drag.moved, r = panel.getBoundingClientRect();
      try { hdr.releasePointerCapture(e.pointerId); } catch {}
      drag = null;
      panel.classList.remove('ttt-drag');
      if (wasDrag) {
        panelPos = { left: r.left, top: r.top };
        GM_setValue('ttt_panelPos', panelPos);
      } else {
        togglePanel(panel);
      }
    }
    hdr.addEventListener('pointerup', endDrag);
    hdr.addEventListener('pointercancel', endDrag);

    // Collapse button
    const tog = document.getElementById('ttt-tog');
    tog.addEventListener('pointerdown', (e) => e.stopPropagation());
    tog.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(panel); });

    // Gear
    document.getElementById('ttt-gear').addEventListener('click', (e) => {
      e.stopPropagation();
      const s = document.getElementById('ttt-settings');
      s.style.display = s.style.display === 'block' ? 'none' : 'block';
    });

    // Save keys
    document.getElementById('ttt-save-keys').addEventListener('click', async () => {
      const btn = document.getElementById('ttt-save-keys');
      const tk = document.getElementById('ttt-tk').value.trim();
      const sk = document.getElementById('ttt-sk').value.trim();
      if (tk && tk !== tornApiKey) {
        btn.textContent = 'Verifying...';
        try {
          const d = await gmFetch(`https://api.torn.com/user/?selections=basic&key=${tk}`);
          if (d.error) { alert('Torn rejected that key: ' + d.error.error); btn.textContent = 'Save keys'; return; }
        } catch { alert('Could not reach Torn API.'); btn.textContent = 'Save keys'; return; }
      }
      tornApiKey = tk; tsApiKey = sk;
      GM_setValue('ttt_tornKey', tornApiKey);
      GM_setValue('ttt_tsKey', tsApiKey);
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save keys'; }, 2000);
      myStatsFetched = 0;
      await refreshMyStats(true);
    });

    // Re-seed
    document.getElementById('ttt-reseed').addEventListener('click', async () => {
      seedFetched = 0;
      await seedAttackLog();
      renderList();
    });

    // Sort
    document.getElementById('ttt-sort').addEventListener('change', (e) => {
      sortMode = e.target.value;
      GM_setValue('ttt_sortMode', sortMode);
      renderList();
    });

    // Refresh all profiles
    document.getElementById('ttt-refresh-all').addEventListener('click', async () => {
      const btn = document.getElementById('ttt-refresh-all');
      btn.textContent = '…';
      for (const id of Object.keys(targetDB)) {
        await fetchProfile(id);
        await new Promise(r => setTimeout(r, 600));
      }
      btn.textContent = '↻ All';
      renderList();
    });

    // Clear all
    document.getElementById('ttt-clear').addEventListener('click', () => {
      if (!confirm('Remove all targets? Attack history will be lost.')) return;
      targetDB = {};
      GM_setValue('ttt_targetDB', {});
      renderList();
    });

    // Reset position
    document.getElementById('ttt-reset-pos').addEventListener('click', () => {
      panelPos = null;
      GM_setValue('ttt_panelPos', null);
      applyPos(panel, null);
    });

    // Add target
    const addId = document.getElementById('ttt-add-id');
    document.getElementById('ttt-add').addEventListener('click', async () => {
      const id = String(addId.value.trim());
      if (!id || isNaN(id)) return;
      addId.value = '';
      if (!targetDB[id]) targetDB[id] = blankTarget(id, '', '');
      saveDB();
      renderList();
      await fetchProfile(id);
      await fetchSpy(id);
      renderList();
    });
    addId.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('ttt-add').click();
    });

    // List delegation
    document.getElementById('ttt-list').addEventListener('click', (e) => {
      const del = e.target.closest('.ttt-del');
      if (del) {
        const id = del.dataset.id;
        if (confirm(`Remove ${targetDB[id]?.name || id}?`)) {
          delete targetDB[id];
          saveDB();
          renderList();
        }
        return;
      }
      const row = e.target.closest('[data-tid]');
      if (row) window.open(`/profiles.php?XID=${row.dataset.tid}`, '_self');
    });

    window.addEventListener('resize', () => {
      if (panelPos) applyPos(panel, panelPos);
    });
  }

  function togglePanel(panel) {
    panel.classList.toggle('ttt-col');
    const col = panel.classList.contains('ttt-col');
    document.getElementById('ttt-tog').textContent = col ? '▲' : '▼';
    if (!col) renderList();
  }

  function applyPos(panel, pos) {
    if (!pos) {
      panel.style.cssText = panel.style.cssText
        .replace(/left:[^;]+;?/g, '')
        .replace(/top:[^;]+;?/g, '');
      panel.style.right = ''; panel.style.bottom = '';
      return;
    }
    const r = panel.getBoundingClientRect();
    const w = r.width || 370, M = 40;
    const cl = clamp(pos.left, M - w, window.innerWidth - M);
    const ct = clamp(pos.top,  0,      window.innerHeight - M);
    panel.style.left = cl + 'px'; panel.style.top = ct + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  }

  function renderList() {
    if (!dom.list) return;
    const targets = Object.values(targetDB);
    if (!targets.length) {
      dom.list.innerHTML = '<div class="ttt-empty">No targets yet.<br>Add a player ID above or visit any profile.</div>';
      return;
    }

    // Sort
    targets.sort((a, b) => {
      const ca = combinedScore(a), cb = combinedScore(b);
      if (sortMode === 'score')  return (cb.score || 0) - (ca.score || 0);
      if (sortMode === 'beat')   return (cb.b || 0) - (ca.b || 0);
      if (sortMode === 'cash')   return cb.c - ca.c;
      if (sortMode === 'recent') {
        const ra = a.attacks[0]?.ts || a.addedAt / 1000;
        const rb = b.attacks[0]?.ts || b.addedAt / 1000;
        return rb - ra;
      }
      return 0;
    });

    dom.list.innerHTML = targets.map(buildRow).join('');
  }

  function buildRow(t) {
    const { score, b, c } = combinedScore(t);
    const cd   = mugCooldownStr(t);
    const icon = statusIcon(t);
    const sc   = score !== null ? score : '?';
    const bs   = b    !== null ? b     : '?';
    const spyLabel = t.spy
      ? `${formatStats(t.spy.total)} · ${spyAgeStr(t.spy)}`
      : (b !== null ? `Lv${t.level} est.` : `Lv${t.level || '?'}`);
    const cash = avgCashStr(t);
    const fact = t.factionName ? ` [${t.factionName.slice(0, 12)}]` : '';
    const chip = topSignalChip(t);

    return `
      <div class="ttt-row" data-tid="${t.id}">
        <span class="ttt-badge" style="color:${scoreColour(score)}">${sc}</span>
        <span style="font-size:13px">${icon}</span>
        <span class="ttt-row-name">
          ${t.name}${fact}<br>
          <span class="ttt-sub">${spyLabel}</span>
          ${chip ? `<br>${chip}` : ''}
        </span>
        <span class="ttt-row-meta">
          ${cd ? `<span class="ttt-cd">⏱${cd}</span><br>` : ''}
          <span>B:${bs} C:${c}</span><br>
          ${cash ? `<span style="color:#9fe8b0">${cash}</span>` : ''}
        </span>
        <button class="ttt-del" data-id="${t.id}" title="Remove target">✕</button>
      </div>
    `;
  }

  function tickCooldowns() {
    document.querySelectorAll('[data-tid]').forEach((row) => {
      const t = targetDB[row.dataset.tid];
      if (!t) return;
      const cd = mugCooldownStr(t);
      const cdEl = row.querySelector('.ttt-cd');
      if (cd && cdEl) { cdEl.textContent = `⏱${cd}`; }
      else if (cd && !cdEl) {
        const meta = row.querySelector('.ttt-row-meta');
        if (meta) meta.insertAdjacentHTML('afterbegin', `<span class="ttt-cd">⏱${cd}</span><br>`);
      } else if (!cd && cdEl) {
        cdEl.nextSibling?.remove(); // the <br>
        cdEl.remove();
      }
    });
  }

  // ---------------------------------------------------------------
  // Profile page overlay
  // ---------------------------------------------------------------
  async function injectOverlay() {
    if (document.getElementById('ttt-overlay')) return;
    const m = window.location.search.match(/XID=(\d+)/);
    if (!m) return;
    const id = m[1];

    // Find a DOM anchor. Torn's profile layout uses various class names across
    // browser / PDA views; we try several and fall back gracefully.
    const selectors = [
      '.profile-container',
      '#profile-container',
      '.player-title-wrap',
      '.profile-basic-info',
      '[class*="profile-wrapper"]',
    ];
    let anchor = null;
    for (const sel of selectors) {
      anchor = document.querySelector(sel);
      if (anchor) break;
    }
    if (!anchor) return;

    const overlay = document.createElement('div');
    overlay.id = 'ttt-overlay';
    overlay.innerHTML = '<div class="ttt-ov-h">🎯 Target Tracker — loading…</div>';
    anchor.after(overlay);

    // Fetch data
    if (!targetDB[id]) targetDB[id] = blankTarget(id, '', '');
    await fetchProfile(id);
    const spy = await fetchSpy(id);
    const t = targetDB[id];
    const { score, b, c } = combinedScore(t);
    const cd = mugCooldownStr(t);

    // Stats comparison line
    const compLine = (() => {
      if (!spy || !myStats?.total) return '<span style="color:#888">No spy data — using level estimate</span>';
      const ratio = myStats.total / spy.total;
      if (ratio >= 2.0) return '<span style="color:#9fe8b0">Strong advantage</span>';
      if (ratio >= 1.2) return '<span style="color:#9fe8b0">Likely win</span>';
      if (ratio >= 0.9) return '<span style="color:#f0d27a">Even match — risky</span>';
      return '<span style="color:#f0a0a0">Outstatted — avoid</span>';
    })();

    const spyLine = spy
      ? `${formatStats(spy.total)} total (${spyAgeStr(spy)})`
      : 'Not in TornStats spy database';

    const myStatLine = myStats?.total
      ? `${formatStats(myStats.total)} total (you)`
      : 'Unknown — add battlestats to API key';

    const cash = avgCashStr(t);

    const inTargets = !!targetDB[id]?.addedAt;
    const signals   = walletSignals(t);
    const stats     = cashStats(t);
    const sigColour = { good: '#9fe8b0', warn: '#f0d27a', bad: '#f0a0a0', info: '#888' };

    const signalsHtml = signals.length
      ? signals.map(s => `
          <div style="margin-bottom:3px">
            <span style="color:${sigColour[s.type]}">${s.label}</span>
            ${s.detail ? `<span style="color:#666;font-size:10px"> — ${s.detail}</span>` : ''}
          </div>`).join('')
      : '<div style="color:#666;font-size:11px">No signals yet — refresh profile for live status</div>';

    const cashStatsHtml = stats ? `
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Std deviation:</span>
        <span class="ttt-ov-v">±${formatCash(stats.stdDev)} (${stats.cv < 0.3 ? 'consistent' : stats.cv > 0.8 ? 'erratic' : 'moderate'})</span>
      </div>
      ${stats.trend !== null ? `
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Recent trend:</span>
        <span class="ttt-ov-v" style="color:${stats.trend > 0 ? '#9fe8b0' : '#f0d27a'}">
          ${stats.trend > 0 ? '+' : ''}${stats.trend}% vs older hits
        </span>
      </div>` : ''}` : '';

    overlay.innerHTML = `
      <div class="ttt-ov-h">🎯 Target Tracker</div>
      ${cd ? `<div style="color:#f0d27a;margin-bottom:8px">⏱ Mug cooldown: ${cd}</div>` : ''}

      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Their stats:</span>
        <span class="ttt-ov-v">${spyLine}</span>
      </div>
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Your stats:</span>
        <span class="ttt-ov-v">${myStatLine}</span>
      </div>
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Assessment:</span>
        <span class="ttt-ov-v">${compLine}</span>
      </div>
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Beatable / Cash:</span>
        <span class="ttt-ov-v">
          <span style="color:${scoreColour(b)}">${b !== null ? b : '?'}</span>
          / <span style="color:${scoreColour(c)}">${c}</span>
          &nbsp;<span style="color:#666;font-size:10px">(out of 100)</span>
        </span>
      </div>
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Fight record:</span>
        <span class="ttt-ov-v">${fightRecordStr(t)}</span>
      </div>
      <div class="ttt-ov-r">
        <span class="ttt-ov-l">Avg cash taken:</span>
        <span class="ttt-ov-v" style="color:#9fe8b0">${cash || 'No cash history yet'}</span>
      </div>
      ${cashStatsHtml}

      <div style="margin-top:8px;margin-bottom:4px;color:#aaa;font-size:10px;font-weight:bold">
        WALLET SIGNALS
      </div>
      <div style="font-size:11px">
        ${signalsHtml}
      </div>

      <div class="ttt-ov-actions">
        <button class="ttt-btn ttt-green" id="ttt-ov-add">${inTargets ? '★ In targets' : '+ Add to targets'}</button>
        <button class="ttt-btn" id="ttt-ov-spy">↻ Refresh spy</button>
        <button class="ttt-btn" id="ttt-ov-refresh">↻ Refresh status</button>
      </div>
    `;

    document.getElementById('ttt-ov-add').addEventListener('click', () => {
      saveDB();
      document.getElementById('ttt-ov-add').textContent = '★ In targets';
    });

    document.getElementById('ttt-ov-spy').addEventListener('click', async () => {
      const btn = document.getElementById('ttt-ov-spy');
      btn.textContent = 'Fetching…';
      if (targetDB[id]) targetDB[id].spyFetchedAt = 0;
      await fetchSpy(id, true);
      overlay.remove();
      injectOverlay();
    });

    document.getElementById('ttt-ov-refresh').addEventListener('click', async () => {
      const btn = document.getElementById('ttt-ov-refresh');
      btn.textContent = 'Refreshing…';
      await fetchProfile(id);
      overlay.remove();
      injectOverlay();
    });
  }

  // ---------------------------------------------------------------
  // Attack result capture
  // ---------------------------------------------------------------
  function watchAttackResult() {
    // The attack result appears in the DOM after the fight resolves.
    // We watch for the result container to appear and parse it.
    let captured = false;
    const obs = new MutationObserver(() => {
      if (captured) return;
      // Torn injects result into various elements depending on version
      const result = document.querySelector(
        '.log-wrap, .attack-result, [class*="attackResult"], .log-info-row'
      );
      if (!result) return;
      captured = true;
      obs.disconnect();
      parseAndRecordResult(result);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function parseAndRecordResult(el) {
    const text = el.textContent || '';

    // Target player ID from URL or page link
    let targetId = null;
    const urlM = window.location.search.match(/user2ID=(\d+)|target=(\d+)/i);
    if (urlM) targetId = urlM[1] || urlM[2];
    if (!targetId) {
      const link = document.querySelector('a[href*="profiles.php?XID="]');
      if (link) { const lm = link.href.match(/XID=(\d+)/); if (lm) targetId = lm[1]; }
    }
    if (!targetId) return;

    // Outcome
    let outcome = 'unknown';
    const lower = text.toLowerCase();
    if (/mugged|hospitalized|attacked and won/i.test(text)) outcome = 'won';
    else if (/lost|was defeated/i.test(text)) outcome = 'lost';
    else if (/stalemate|ran away|escaped/i.test(text)) outcome = 'stalemate';

    // Cash taken — "$X,XXX,XXX" pattern in result text
    let cashTaken = 0;
    const cashM = text.match(/\$[\d,]+/);
    if (cashM) cashTaken = parseInt(cashM[0].replace(/[$,]/g, '')) || 0;

    // Respect
    let respect = 0;
    const respM = text.match(/([\d.]+)\s*respect/i);
    if (respM) respect = parseFloat(respM[1]) || 0;

    if (!targetDB[targetId]) targetDB[targetId] = blankTarget(targetId, '', '');
    const pushed = pushAttack(targetId, {
      ts: Math.floor(Date.now() / 1000),
      outcome,
      cashTaken,
      respectGained: respect,
    });
    if (pushed) saveDB();
  }

  // ---------------------------------------------------------------
  // SPA router
  // ---------------------------------------------------------------
  function route() {
    ensurePanel();
    const path   = window.location.pathname;
    const search = window.location.search;

    if (path.includes('profiles.php') && search.includes('XID=')) {
      injectOverlay();
    }
    if (path.includes('loader.php') && /attack/i.test(search)) {
      watchAttackResult();
    }
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  async function init() {
    await refreshMyStats();
    route();

    // SPA navigation watcher
    let lastHref = location.href;
    let routeTimer = null;
    new MutationObserver(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      clearTimeout(routeTimer);
      routeTimer = setTimeout(() => {
        document.getElementById('ttt-overlay')?.remove();
        route();
      }, ROUTE_DEBOUNCE_MS);
    }).observe(document.body, { childList: true, subtree: true });

    // Seed attack log in background after a short delay to let the page settle
    setTimeout(async () => {
      await seedAttackLog();
      renderList();
    }, 8000);

    // Periodic own-stats refresh
    setInterval(refreshMyStats, STATS_REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
