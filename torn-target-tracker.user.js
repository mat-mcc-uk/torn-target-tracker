// ==UserScript==
// @name         Torn Target Tracker
// @namespace    https://github.com/mat-mcc-uk
// @version      2.0.0
// @description  FFScouter-powered target finder and profile overlay for mugging
// @author       mat-mcc-uk
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      ffscouter.com
// @updateURL    https://raw.githubusercontent.com/mat-mcc-uk/torn-target-tracker/main/torn-target-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/mat-mcc-uk/torn-target-tracker/main/torn-target-tracker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Persisted state
  // ---------------------------------------------------------------
  let ffsKey         = GM_getValue('ttt_ffsKey',  '');
  let tornKey        = GM_getValue('ttt_tornKey',  '');
  let myStats        = GM_getValue('ttt_myStats',  null);
  let myStatsFetched = GM_getValue('ttt_myStatsFetched', 0);
  // Cash history keyed by player ID: { wins, losses, records: [{ ts, amount }] }
  let cashDB         = GM_getValue('ttt_cashDB', {});

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const STATS_TTL_MS   = 60 * 60 * 1000;  // re-fetch own stats every hour
  const FFS_TTL_MS     = 10 * 60 * 1000;  // cache per-player FFS response 10m
  const PROTECT_MS     = 12 * 60 * 60 * 1000;  // mug protection window
  const MAX_RECORDS    = 30;               // cash records kept per target

  // In-tab FFS response cache so repeated profile visits don't burn requests.
  const ffsCache = {};

  // ---------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 12000,
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

  // ---------------------------------------------------------------
  // Your own stats (Torn API)
  // ---------------------------------------------------------------
  async function getMyStats() {
    if (myStats && Date.now() - myStatsFetched < STATS_TTL_MS) return myStats;
    if (!tornKey) return null;
    try {
      const d = await gmFetch(
        `https://api.torn.com/user/?selections=basic,battlestats&key=${tornKey}`
      );
      if (d.error) return null;
      myStats = {
        tornId: d.player_id,
        name:   d.name,
        level:  d.level,
        total:  (d.strength || 0) + (d.defense || 0) + (d.speed || 0) + (d.dexterity || 0),
      };
      myStatsFetched = Date.now();
      GM_setValue('ttt_myStats', myStats);
      GM_setValue('ttt_myStatsFetched', myStatsFetched);
      return myStats;
    } catch { return null; }
  }

  // ---------------------------------------------------------------
  // FFScouter — stats for one player
  // ---------------------------------------------------------------
  async function getFfsStats(playerId) {
    const hit = ffsCache[playerId];
    if (hit && Date.now() - hit.at < FFS_TTL_MS) return hit.data;
    if (!ffsKey) return null;
    try {
      const arr = await gmFetch(
        `https://ffscouter.com/api/v1/get-stats?key=${ffsKey}&targets=${playerId}`
      );
      if (!Array.isArray(arr) || !arr.length) return null;
      const data = arr[0];
      if (data.error || data.code) return null;
      ffsCache[playerId] = { data, at: Date.now() };
      return data;
    } catch { return null; }
  }

  // ---------------------------------------------------------------
  // FFScouter — find beatable targets
  // ---------------------------------------------------------------
  async function findTargets({ maxFF = 1.5, minLevel = 1, maxLevel = 100 } = {}) {
    if (!ffsKey) return null;
    try {
      return await gmFetch(
        `https://ffscouter.com/api/v1/get-targets?key=${ffsKey}` +
        `&minff=1.0&maxff=${maxFF}&minlevel=${minLevel}&maxlevel=${maxLevel}` +
        `&inactiveonly=0&limit=20`
      );
    } catch { return null; }
  }

  // ---------------------------------------------------------------
  // Cash history
  // ---------------------------------------------------------------
  function recordResult(playerId, outcome, cashTaken) {
    const id = String(playerId);
    if (!cashDB[id]) cashDB[id] = { wins: 0, losses: 0, records: [] };
    const h = cashDB[id];
    if (outcome === 'won') h.wins++;
    else if (outcome === 'lost') h.losses++;
    if (outcome === 'won' && cashTaken > 0) {
      h.records.unshift({ ts: Date.now(), amount: cashTaken });
      if (h.records.length > MAX_RECORDS) h.records.length = MAX_RECORDS;
    }
    GM_setValue('ttt_cashDB', cashDB);
  }

  function cashSummary(playerId) {
    const h = cashDB[String(playerId)];
    if (!h) return null;
    const cashRecords = h.records.filter(r => r.amount > 0);
    const avg = cashRecords.length
      ? cashRecords.reduce((a, b) => a + b.amount, 0) / cashRecords.length
      : null;
    return {
      wins: h.wins, losses: h.losses,
      avg, samples: cashRecords.length,
      lastHitTs: cashRecords[0]?.ts || null,
    };
  }

  // ---------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------
  function fmtCash(n) {
    if (!n) return '$0';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + n;
  }

  function fmtAge(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 60)   return m + 'm ago';
    if (m < 1440) return Math.round(m / 60) + 'h ago';
    return Math.round(m / 1440) + 'd ago';
  }

  // Fair fight verdict. Lower FF = you outclass them.
  function ffVerdict(ff) {
    if (ff === null || ff === undefined) return { text: 'No data', colour: '#888' };
    if (ff < 1.3) return { text: 'Easy win',    colour: '#9fe8b0' };
    if (ff < 1.8) return { text: 'Manageable',  colour: '#9fe8b0' };
    if (ff < 2.5) return { text: 'Risky',       colour: '#f0d27a' };
    return               { text: 'Avoid',        colour: '#f0a0a0' };
  }

  // ---------------------------------------------------------------
  // Profile page DOM — read live data without an API call
  // ---------------------------------------------------------------
  function readProfileDom() {
    // Name: usually in the page title "PlayerName [ID] - Torn"
    let name = null;
    const titleM = document.title.match(/^(.+?)\s*\[/);
    if (titleM) name = titleM[1].trim();

    // Level: Torn renders it inside a specific wrapper
    let level = null;
    for (const sel of ['.level-wrap .value', '.basic-information .level', '[class*="level"] .value']) {
      const el = document.querySelector(sel);
      if (el) { level = parseInt(el.textContent) || null; break; }
    }

    // Status: "Okay", "In hospital", "Traveling" etc.
    let status = null;
    for (const sel of ['.status-wrap', '[class*="status"] .value', '.profile-status']) {
      const el = document.querySelector(sel);
      if (el) { status = el.textContent.trim(); break; }
    }

    return { name, level, status };
  }

  // ---------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------
  GM_addStyle(`
    #ttt-overlay {
      background: #1b1b1b;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 10px 12px;
      margin: 8px 0;
      font-family: Arial, sans-serif;
      font-size: 12px;
      color: #e0e0e0;
      max-width: 520px;
    }
    .ttt-ov-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-size: 11px;
      font-weight: bold;
      color: #aaa;
    }
    .ttt-ov-verdict {
      font-size: 13px;
      font-weight: bold;
      padding: 4px 12px;
      border-radius: 4px;
      background: #2a2a2a;
      margin-bottom: 8px;
      display: inline-block;
    }
    .ttt-ov-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .ttt-ov-lbl { color: #888; }
    .ttt-ov-val { font-weight: bold; }
    .ttt-sep { border: none; border-top: 1px solid #333; margin: 7px 0; }
    .ttt-warn { color: #f0d27a; font-size: 10px; margin-top: 3px; }
    .ttt-bad  { color: #f0a0a0; font-size: 10px; margin-top: 3px; }
    .ttt-ov-btn {
      background: #2a2a2a; color: #e0e0e0;
      border: 1px solid #555; border-radius: 3px;
      padding: 3px 8px; cursor: pointer; font-size: 11px;
      margin-top: 8px;
    }
    .ttt-ov-btn:hover { background: #333; }

    /* Target finder */
    #ttt-finder {
      position: fixed;
      bottom: 110px; right: 10px;
      width: 350px;
      max-width: calc(100vw - 20px);
      max-height: 70vh;
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
    #ttt-finder.ttt-col .ttt-fb { display: none; }
    #ttt-finder h3 {
      margin: 0; padding: 8px 10px;
      background: #2a2a2a; border-bottom: 1px solid #444;
      cursor: pointer; user-select: none;
      display: flex; justify-content: space-between; align-items: center;
      font-size: 12px;
    }
    .ttt-fb { padding: 8px 10px; }
    .ttt-controls {
      display: flex; gap: 5px; align-items: center;
      flex-wrap: wrap; margin-bottom: 8px; font-size: 11px;
    }
    .ttt-controls input {
      background: #2a2a2a; color: #e0e0e0;
      border: 1px solid #555; border-radius: 3px;
      padding: 2px 4px;
    }
    .ttt-find-btn {
      background: #1e5631; color: #9fe8b0;
      border: 1px solid #2d7d47; border-radius: 3px;
      padding: 3px 10px; cursor: pointer; font-size: 11px;
    }
    .ttt-find-btn:disabled { opacity: 0.5; cursor: default; }
    .ttt-t-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 0; border-bottom: 1px solid #222; cursor: pointer;
    }
    .ttt-t-row:hover { background: #212121; }
    .ttt-ff-pill {
      min-width: 36px; text-align: center; font-weight: bold;
      font-size: 11px; padding: 2px 4px; border-radius: 3px;
      background: #2a2a2a; flex-shrink: 0;
    }
    .ttt-t-name { font-size: 12px; }
    .ttt-t-sub  { font-size: 10px; color: #666; }
    .ttt-settings-panel {
      border-top: 1px solid #333;
      padding-top: 8px; margin-top: 8px; font-size: 11px;
    }
    .ttt-settings-panel label { display: block; color: #aaa; margin-bottom: 2px; }
    .ttt-settings-panel input {
      background: #2a2a2a; color: #e0e0e0;
      border: 1px solid #555; border-radius: 3px;
      padding: 3px 5px; width: 100%; box-sizing: border-box; margin-bottom: 6px;
    }
    .ttt-icon-btn {
      background: none; border: none;
      color: #e0e0e0; cursor: pointer; font-size: 13px; padding: 0 2px;
    }
    .ttt-empty { color: #666; text-align: center; padding: 16px; font-size: 11px; }
  `);

  // ---------------------------------------------------------------
  // Profile overlay
  // ---------------------------------------------------------------
  async function injectOverlay() {
    if (document.getElementById('ttt-overlay')) return;
    const m = location.search.match(/XID=(\d+)/i);
    if (!m) return;
    const playerId = m[1];

    // Anchor: insert before the profile's main wrapper
    let anchor = null;
    for (const sel of ['.profile-wrapper', '.profile-container', '#profile-container', '.basic-information']) {
      anchor = document.querySelector(sel);
      if (anchor) break;
    }
    if (!anchor) return;

    const overlay = document.createElement('div');
    overlay.id = 'ttt-overlay';
    overlay.innerHTML = `
      <div class="ttt-ov-hdr">🎯 Target Tracker <span style="color:#555;font-weight:normal">Loading…</span></div>
    `;
    anchor.before(overlay);

    // Fetch in parallel
    const [ffsData, me] = await Promise.all([getFfsStats(playerId), getMyStats()]);
    const dom = readProfileDom();
    const cash = cashSummary(playerId);

    // FFS data
    const ff      = ffsData?.fair_fight ?? null;
    const bsHuman = ffsData?.bs_estimate_human ?? null;
    const dist    = ffsData?.distribution?.distribution_human ?? null;
    const dataAge = ffsData?.last_updated ? fmtAge(ffsData.last_updated * 1000) : null;
    const verdict = ffVerdict(ff);

    // Mug protection
    const lastHit     = cash?.lastHitTs || null;
    const isProtected = lastHit && Date.now() - lastHit < PROTECT_MS;
    const protMinsLeft = isProtected ? Math.ceil((lastHit + PROTECT_MS - Date.now()) / 60000) : null;

    // Warnings
    const lowYield = cash?.avg && cash.avg < 200000 && (dom.level || 0) > 30;
    const highDef  = dist && /DEF[^)]*(\d+)%/i.exec(dist)?.[1] >= 50;

    // My stats label
    const myLabel = me?.total
      ? `${me.total >= 1e9 ? (me.total / 1e9).toFixed(1) + 'B' : Math.round(me.total / 1e6) + 'M'}`
      : null;

    const statusLine = dom.status ? `<div class="ttt-ov-row">
      <span class="ttt-ov-lbl">Status:</span>
      <span class="ttt-ov-val">${dom.status}</span>
    </div>` : '';

    overlay.innerHTML = `
      <div class="ttt-ov-hdr">
        🎯 Target Tracker
        <span style="color:#555;font-weight:normal;font-size:10px">
          ${dataAge ? `FFS data ${dataAge}` : ffsKey ? 'No FFS data' : 'Add FFScouter key in panel ⚙'}
        </span>
      </div>

      <div class="ttt-ov-verdict" style="color:${verdict.colour}">
        ${verdict.text}${ff !== null ? ` · FF ${ff.toFixed(2)}` : ''}
      </div>

      ${bsHuman ? `<div class="ttt-ov-row">
        <span class="ttt-ov-lbl">Their stats:</span>
        <span class="ttt-ov-val">${bsHuman}${dist ? ` · ${dist}` : ''}</span>
      </div>` : ''}

      ${myLabel ? `<div class="ttt-ov-row">
        <span class="ttt-ov-lbl">Your stats:</span>
        <span class="ttt-ov-val">${myLabel}</span>
      </div>` : ''}

      ${statusLine}

      <hr class="ttt-sep">

      <div class="ttt-ov-row">
        <span class="ttt-ov-lbl">Fight record:</span>
        <span class="ttt-ov-val">${cash ? `${cash.wins}W / ${cash.losses}L` : 'No history'}</span>
      </div>

      ${cash?.avg ? `<div class="ttt-ov-row">
        <span class="ttt-ov-lbl">Avg cash taken:</span>
        <span class="ttt-ov-val" style="color:#9fe8b0">${fmtCash(cash.avg)} (${cash.samples} fights)</span>
      </div>` : ''}

      ${lastHit ? `<div class="ttt-ov-row">
        <span class="ttt-ov-lbl">Last hit:</span>
        <span class="ttt-ov-val">${fmtAge(lastHit)}</span>
      </div>` : ''}

      ${isProtected ? `<div class="ttt-bad">🛡 Mug protection active — expires in ~${protMinsLeft}m</div>` : ''}
      ${lowYield    ? `<div class="ttt-warn">⚠️ Low cash returns — likely wearing 7★ clothing</div>` : ''}
      ${highDef     ? `<div class="ttt-warn">⚔️ High DEF build — harder to mug</div>` : ''}

      <button class="ttt-ov-btn" id="ttt-ov-refresh">↻ Refresh FFS data</button>
    `;

    document.getElementById('ttt-ov-refresh').addEventListener('click', async () => {
      const btn = document.getElementById('ttt-ov-refresh');
      btn.textContent = 'Refreshing…';
      delete ffsCache[playerId];
      document.getElementById('ttt-overlay')?.remove();
      await injectOverlay();
    });
  }

  // ---------------------------------------------------------------
  // Attack result capture
  // ---------------------------------------------------------------
  function watchAttackResult() {
    let done = false;
    const obs = new MutationObserver(() => {
      if (done) return;
      const el = document.querySelector('.log-wrap, .attack-result, [class*="attackResult"]');
      if (!el) return;
      done = true;
      obs.disconnect();

      const text = el.textContent || '';

      // Target ID
      let targetId = null;
      const urlM = location.search.match(/user2ID=(\d+)|target=(\d+)/i);
      if (urlM) targetId = urlM[1] || urlM[2];
      if (!targetId) {
        const link = document.querySelector('a[href*="profiles.php?XID="]');
        if (link) { const lm = link.href.match(/XID=(\d+)/); if (lm) targetId = lm[1]; }
      }
      if (!targetId) return;

      let outcome = 'unknown';
      if (/mugged|hospitalized/i.test(text)) outcome = 'won';
      else if (/lost|defeated/i.test(text)) outcome = 'lost';
      else if (/stalemate|escaped/i.test(text)) outcome = 'stalemate';

      let cash = 0;
      const cashM = text.match(/\$[\d,]+/);
      if (cashM) cash = parseInt(cashM[0].replace(/[$,]/g, '')) || 0;

      if (outcome !== 'unknown') recordResult(targetId, outcome, cash);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------
  // Target finder panel
  // ---------------------------------------------------------------
  function buildFinder() {
    if (document.getElementById('ttt-finder')) return;

    const maxFF  = GM_getValue('ttt_maxFF',   '1.5');
    const minLv  = GM_getValue('ttt_minLv',   '1');
    const maxLv  = GM_getValue('ttt_maxLv',   '100');

    const panel = document.createElement('div');
    panel.id = 'ttt-finder';
    panel.classList.add('ttt-col');
    panel.innerHTML = `
      <h3>
        <span>🎯 Target Finder</span>
        <span style="display:flex;gap:4px;align-items:center">
          <button class="ttt-icon-btn" id="ttt-gear">⚙</button>
          <button class="ttt-icon-btn" id="ttt-tog">▲</button>
        </span>
      </h3>
      <div class="ttt-fb">
        <div class="ttt-controls">
          <span>Max FF:</span>
          <input id="ttt-maxff" type="number" min="1" max="5" step="0.1" value="${maxFF}" style="width:46px">
          <span>Level:</span>
          <input id="ttt-minlv" type="number" min="1" max="100" value="${minLv}" style="width:38px">
          <span>–</span>
          <input id="ttt-maxlv" type="number" min="1" max="100" value="${maxLv}" style="width:38px">
          <button class="ttt-find-btn" id="ttt-find">Find</button>
        </div>
        <div id="ttt-results" class="ttt-empty">
          Set your max fair fight and click Find.<br>
          Lower FF = easier target. Start with 1.5.
        </div>
        <div id="ttt-settings" class="ttt-settings-panel" style="display:none">
          <label>FFScouter API key</label>
          <input id="ttt-ffs-inp" type="password" value="${ffsKey}" placeholder="16-char FFScouter key">
          <label>Torn API key (for your own stats)</label>
          <input id="ttt-torn-inp" type="password" value="${tornKey}" placeholder="Limited access key">
          <button class="ttt-find-btn" id="ttt-save" style="width:100%;text-align:center">Save keys</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Collapse / expand
    const tog = document.getElementById('ttt-tog');
    function togglePanel() {
      panel.classList.toggle('ttt-col');
      tog.textContent = panel.classList.contains('ttt-col') ? '▲' : '▼';
    }
    panel.querySelector('h3').addEventListener('click', togglePanel);
    tog.addEventListener('pointerdown', (e) => e.stopPropagation());
    tog.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });

    // Settings
    document.getElementById('ttt-gear').addEventListener('click', (e) => {
      e.stopPropagation();
      const s = document.getElementById('ttt-settings');
      s.style.display = s.style.display === 'block' ? 'none' : 'block';
    });

    // Save keys
    document.getElementById('ttt-save').addEventListener('click', async () => {
      const btn  = document.getElementById('ttt-save');
      const newFfs  = document.getElementById('ttt-ffs-inp').value.trim();
      const newTorn = document.getElementById('ttt-torn-inp').value.trim();

      if (newTorn && newTorn !== tornKey) {
        btn.textContent = 'Verifying Torn key…';
        try {
          const d = await gmFetch(`https://api.torn.com/user/?selections=basic&key=${newTorn}`);
          if (d.error) {
            alert('Torn rejected that key: ' + d.error.error);
            btn.textContent = 'Save keys'; return;
          }
        } catch {
          alert('Could not reach Torn API.');
          btn.textContent = 'Save keys'; return;
        }
      }

      ffsKey = newFfs; tornKey = newTorn;
      GM_setValue('ttt_ffsKey', ffsKey);
      GM_setValue('ttt_tornKey', tornKey);
      myStats = null; myStatsFetched = 0;
      GM_setValue('ttt_myStats', null);
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save keys'; }, 2000);
      getMyStats(); // warm cache now
    });

    // Find
    document.getElementById('ttt-find').addEventListener('click', async () => {
      if (!ffsKey) {
        document.getElementById('ttt-results').innerHTML =
          `<div class="ttt-empty">Add your FFScouter key in settings (⚙).</div>`;
        return;
      }

      const btn     = document.getElementById('ttt-find');
      const results = document.getElementById('ttt-results');
      const maxFF_  = parseFloat(document.getElementById('ttt-maxff').value) || 1.5;
      const minLv_  = parseInt(document.getElementById('ttt-minlv').value)   || 1;
      const maxLv_  = parseInt(document.getElementById('ttt-maxlv').value)   || 100;

      GM_setValue('ttt_maxFF', String(maxFF_));
      GM_setValue('ttt_minLv', String(minLv_));
      GM_setValue('ttt_maxLv', String(maxLv_));

      btn.textContent = 'Searching…';
      btn.disabled = true;
      results.innerHTML = `<div class="ttt-empty">Asking FFScouter…</div>`;

      const data = await findTargets({ maxFF: maxFF_, minLevel: minLv_, maxLevel: maxLv_ });
      btn.textContent = 'Find';
      btn.disabled = false;

      if (!data || data.error || !data.targets?.length) {
        const hint = data?.code === 17
          ? 'No matches. Try raising Max FF or widening the level range.'
          : data?.code === 6
          ? 'FFScouter key rejected. Check it is registered at ffscouter.com.'
          : 'No results.';
        results.innerHTML = `<div class="ttt-empty">${hint}</div>`;
        return;
      }

      results.innerHTML = data.targets.map(t => {
        const v    = ffVerdict(t.fair_fight);
        const cash = cashSummary(t.player_id);
        const avgStr = cash?.avg ? ` · ${fmtCash(cash.avg)} avg` : '';
        return `
          <div class="ttt-t-row" data-id="${t.player_id}">
            <span class="ttt-ff-pill" style="color:${v.colour}">${t.fair_fight?.toFixed(1) ?? '?'}</span>
            <span style="flex:1">
              <div class="ttt-t-name">${t.name} [${t.player_id}]</div>
              <div class="ttt-t-sub">
                Lv${t.level} · ${t.bs_estimate_human ?? '?'}${avgStr}
                ${t.last_action ? ' · ' + fmtAge(t.last_action * 1000) : ''}
              </div>
            </span>
          </div>
        `;
      }).join('');

      results.querySelectorAll('.ttt-t-row').forEach(row => {
        row.addEventListener('click', () => {
          window.open(`/profiles.php?XID=${row.dataset.id}`, '_self');
        });
      });
    });
  }

  // ---------------------------------------------------------------
  // SPA router
  // ---------------------------------------------------------------
  function route() {
    const path   = location.pathname;
    const search = location.search;

    if (path.includes('profiles.php') && search.includes('XID=')) {
      injectOverlay();
    } else if (path.includes('loader.php') && /attack/i.test(search)) {
      watchAttackResult();
    }

    // Finder everywhere except profile and attack pages
    if (!path.includes('profiles.php') && !path.includes('loader.php')) {
      buildFinder();
    }
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  async function init() {
    getMyStats(); // warm cache silently
    route();

    // SPA navigation
    let lastHref  = location.href;
    let debounce  = null;
    new MutationObserver(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        document.getElementById('ttt-overlay')?.remove();
        route();
      }, 350);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
