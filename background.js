/**
 * TongRadio Assistant — background worker (MV3, works in Chrome/Edge/Firefox)
 *
 * Responsibilities:
 *  1. Poll Bilibili live status (chrome.alarms).
 *  2. Watch rooms: live(1) -> offline(0)/round(2) transition triggers "end action":
 *       - radio: switch a matching tab to the user's radio URL with ?autoplay=random
 *       - close: close matching tabs
 *  3. Notify: offline/round(0|2) -> live(1) transition for watched notify-UIDs.
 */
'use strict';

const B = (typeof browser !== 'undefined') ? browser : chrome;

const ALARM = 'tongradio-poll';
const LS_SETTINGS = 'settings';
const LS_STATE = 'state';

let ticking = false; // 防止并发 tick 重复触发动作

// 注入代码版本标记：诊断里出现该标记 = 正在运行的是最新代码
const INJ_VERSION = '1.2.3';

const DEFAULTS = {
  watchMode: 'fixed',        // 'fixed' | 'all'
  fixedUid: '401315430',     // 星瞳 UID
  endAction: 'radio',        // 'radio' | 'close'
  radioUrl: 'https://radio.autsun.asia/',
  pollSeconds: 60,
  notifyEnabled: true,
  notifyUids: ['401315430'],
  reliableMode: true,    // 可靠模式：用调试器 API 强制自动播放（100% 生效），默认开启
};

const STATE_DEFAULT = {
  prev: {},          // roomId(long) -> last live_status observed
  lastRooms: {},     // roomId(long) -> {uname, uid, roomId, shortId, title, status}
  lastCheck: 0,      // unix seconds
};

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

async function getConfig() {
  let cfg = {};
  try {
    const obj = await B.storage.sync.get(LS_SETTINGS);
    if (obj && obj[LS_SETTINGS]) cfg = obj[LS_SETTINGS];
  } catch (e) { /* ignore */ }
  const merged = Object.assign({}, DEFAULTS, cfg);
  // 迁移：v1.2.0 的可靠模式默认是关且当时无法开启，旧设置里的 reliableMode:false
  // （没有 _schema 标记）视为无效旧值，按新默认 true 处理。真正手动关掉会带 _schema:2。
  if (merged.reliableMode === false && !cfg._schema) {
    merged.reliableMode = true;
  }
  if (!Array.isArray(merged.notifyUids)) merged.notifyUids = [];
  merged.notifyUids = merged.notifyUids.map(String).filter(Boolean);
  if (!Array.isArray(merged.notifyUids) || merged.notifyUids.length === 0) merged.notifyUids = [DEFAULTS.fixedUid];
  return merged;
}

async function saveConfig(patch) {
  const cur = await getConfig();
  const next = Object.assign({}, cur, patch);
  await B.storage.sync.set({ [LS_SETTINGS]: next });
  return next;
}

async function getState() {
  try {
    const obj = await B.storage.local.get(LS_STATE);
    if (obj && obj[LS_STATE]) return Object.assign({}, STATE_DEFAULT, obj[LS_STATE]);
  } catch (e) { /* ignore */ }
  return Object.assign({}, STATE_DEFAULT);
}

async function saveState(state) {
  await B.storage.local.set({ [LS_STATE]: state });
}

// ---------------------------------------------------------------------------
// Bilibili API
// ---------------------------------------------------------------------------

const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (TongRadioAssistant/1.0)',
  'Accept': 'application/json',
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: API_HEADERS, cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const payload = await res.json();
  if (payload.code !== 0 && payload.code !== undefined) {
    throw new Error('api code=' + payload.code + ' ' + (payload.message || payload.msg || ''));
  }
  return payload;
}

/** Batch status by UID list. Returns map uid(string) -> info. */
async function fetchByUids(uids) {
  const q = new URLSearchParams();
  uids.forEach((u) => q.append('uids[]', u));
  const payload = await fetchJson('https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?' + q.toString());
  return payload.data || {};
}

/** Single-room status by room number (accepts long or short id). */
async function fetchRoomInfo(roomNumber) {
  const q = new URLSearchParams({ room_id: String(roomNumber) });
  const payload = await fetchJson('https://api.live.bilibili.com/room/v1/Room/get_info?' + q.toString());
  return payload.data || null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractRoomId(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'live.bilibili.com') return null;
    const m = u.pathname.match(/^\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    return null;
  }
}

function tabMatchesRoom(url, roomId, shortId) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'live.bilibili.com') return false;
    const seg = (u.pathname || '').split('/')[1] || '';
    const n = parseInt(seg, 10);
    if (!Number.isFinite(n)) return false;
    return n === roomId || n === shortId;
  } catch (e) {
    return false;
  }
}

function buildRadioUrl(base) {
  const b = (base && base.trim()) || DEFAULTS.radioUrl;
  try {
    const u = new URL(b);
    if (!u.searchParams.has('autoplay')) u.searchParams.set('autoplay', 'random');
    return u.href;
  } catch (e) {
    // 非法 URL 时兜底
    const sep = b.includes('?') ? '&' : '?';
    return b + sep + 'autoplay=random';
  }
}

function notifyId(roomId) {
  return 'tongradio-live-' + roomId;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function liveTabs() {
  try {
    return await B.tabs.query({ url: 'https://live.bilibili.com/*' });
  } catch (e) {
    return [];
  }
}

/**
 * 电台页加载后，注入带「用户手势」的 play()，让自动播放不再被浏览器拦截。
 * 这是 Chrome/Edge 下绕过 autoplay policy 的标准做法（scripting userGesture）。
 * 需要 scripting 权限 + 该电台域名的 host 权限（默认 radio.autsun.asia 已预授权；
 * 自定义域名需在 popup 里点一次「授权电台域名」）。
 */
async function ensureRadioPlaying(tabId, radioUrl) {
  const cfg = await getConfig();
  // 可靠模式：优先用调试器（100% 生效）；失败（如 DevTools 占用）则回退 scripting
  if (cfg.reliableMode && B.debugger) {
    lastInjectInfo = { ok: false, reason: 'debugger-start', attempts: 0, seen: [], v: INJ_VERSION };
    const r = await ensureRadioPlayingViaDebugger(tabId);
    if (r.ok) {
      lastInjectInfo = { ok: true, reason: r.reason, attempts: 0, seen: ['debugger'], v: INJ_VERSION };
      return true;
    }
    console.warn('[tongradio] debugger inject failed:', r.reason, '-> fallback scripting');
  }
  lastInjectInfo = { ok: false, reason: 'unknown', attempts: 0, seen: [], v: INJ_VERSION };
  if (!B.scripting) { lastInjectInfo.reason = 'no-scripting'; return false; }
  const seen = new Set();
  for (let i = 0; i < 60; i++) {   // 最多等 ~30s 歌单加载完成
    await sleep(500);
    lastInjectInfo.attempts++;
    try {
      const t = await B.tabs.get(tabId);
      if (!t || !t.url || !/^https?:/.test(t.url)) continue;
      const res = await B.scripting.executeScript({
        target: { tabId },
        // 同步返回状态；play() 用 fire-and-forget，下一轮读实际播放状态。
        // 不依赖 executeScript 是否 await 注入函数返回的 Promise（兼容性更稳）。
        func: () => {
          const a = document.getElementById('audio') || document.querySelector('audio');
          if (!a) return { state: 'no-audio' };
          if (!a.paused) return { state: 'playing' };
          if (a.currentSrc) {
            const p = a.play();
            if (p && p.catch) p.catch(function () {});
            return { state: 'play-called' };
          }
          const btn = document.getElementById('playBtn') ||
            document.querySelector('[id*="PlayBtn"],[id*="playBtn"]');
          if (btn) {
            btn.click();
            return { state: 'clicked-play' };
          }
          return { state: 'no-src' };
        },
        userGesture: true,
      });
      const st = res && res[0] && res[0].result && res[0].result.state;
      if (st) seen.add(st);
      if (st === 'playing') {
        lastInjectInfo = { ok: true, reason: 'playing', attempts: lastInjectInfo.attempts, seen: [...seen], v: INJ_VERSION };
        return true;
      }
      // play-called / clicked-play / no-src / no-audio：还没就绪，继续等
    } catch (e) {
      const msg = String((e && e.message) || e);
      lastInjectInfo.lastError = String(msg).slice(0, 300);
      if (/permission|Cannot access|host permission|not allowed to access/i.test(msg)) {
        lastInjectInfo = { ok: false, reason: 'no-host-permission', attempts: lastInjectInfo.attempts, seen: [...seen], lastError: String(msg).slice(0, 300), v: INJ_VERSION };
        console.warn('[tongradio] inject blocked by permission:', msg);
        return false;
      }
      // 页面正在加载等其他原因，重试
    }
  }
  lastInjectInfo = { ok: false, reason: 'timeout', attempts: lastInjectInfo.attempts, seen: [...seen], v: INJ_VERSION };
  return false;
}

// 防止同一标签页并发注入
const injecting = new Set();

// 最近一次自动播放注入的结果（供 popup 诊断）
let lastInjectInfo = { ok: false, reason: 'not-run', attempts: 0, seen: [], v: INJ_VERSION };

/**
 * 可靠模式：用 chrome.debugger 的 Runtime.evaluate + userGesture 注入播放。
 * 这是 CDP 协议里明确支持「带用户手势执行」的命令，真实站点实测可用，
 * 是 Chrome/Edge 收紧自动播放政策后最稳的兜底（会短暂出现"正在调试此浏览器"提示条）。
 */
async function ensureRadioPlayingViaDebugger(tabId) {
  const target = { tabId };
  try {
    await B.debugger.attach(target, '1.3');
  } catch (e) {
    return { ok: false, reason: 'attach-failed' };
  }
  try {
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      try {
        const resp = await B.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(async () => {
            const a = document.getElementById('audio') || document.querySelector('audio');
            if (!a) return 'no-audio';
            if (!a.paused) return 'playing';
            if (!a.currentSrc) {
              const b = document.getElementById('playBtn') || document.querySelector('[id*="playBtn"],[id*="PlayBtn"]');
              if (b) { b.click(); return 'clicked-play'; }
              return 'no-src';
            }
            try { await a.play(); return 'started'; }
            catch (e) { return 'blocked:' + e.name; }
          })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        const st = resp && resp.result && resp.result.value;
        if (st === 'playing' || st === 'started') return { ok: true, reason: st };
        if (st === 'blocked:NotAllowedError') return { ok: false, reason: st };
        // no-src / no-audio / clicked-play：还没就绪，继续等
      } catch (e) {
        // 页面加载中等，重试
      }
    }
    return { ok: false, reason: 'timeout' };
  } finally {
    try { await B.debugger.detach(target); } catch (e) { /* ignore */ }
  }
}

/**
 * 对「带 ?autoplay 参数、且属于配置的电台域名」的标签页执行自动播放注入。
 * 覆盖两条路径：扩展切换标签页（runEndAction）和用户手动打开电台链接。
 */
async function maybeInjectRadio(tabId, url) {
  if (!url || !B.scripting || injecting.has(tabId)) return false;
  let ap = null;
  try {
    const u = new URL(url);
    ap = u.searchParams.get('autoplay');
    if (ap !== '1' && ap !== 'random') return false;
    const cfg = await getConfig();
    if (cfg.endAction !== 'radio') return false;
    const radio = new URL(cfg.radioUrl);
    if (u.origin !== radio.origin) return false; // 只对配置的电台域注入
  } catch (e) {
    return false;
  }
  injecting.add(tabId);
  try {
    return await ensureRadioPlaying(tabId, url);
  } finally {
    injecting.delete(tabId);
  }
}

/** Apply end action (radio / close) to all tabs of a room. */
async function runEndAction(roomId, shortId, cfg) {
  const tabs = await liveTabs();
  const matches = tabs.filter((t) => tabMatchesRoom(t.url || '', roomId, shortId));
  if (matches.length === 0) return;

  if (cfg.endAction === 'close') {
    await B.tabs.remove(matches.map((t) => t.id).filter((id) => id != null));
    console.log('[tongradio] closed', matches.length, 'tab(s) for room', roomId);
    return;
  }

  // radio: 第一个标签页切到电台，多余的关掉
  const url = buildRadioUrl(cfg.radioUrl);
  await B.tabs.update(matches[0].id, { url });
  const rest = matches.slice(1);
  if (rest.length) {
    await B.tabs.remove(rest.map((t) => t.id).filter((id) => id != null));
  }
  console.log('[tongradio] switched tab to', url, '(room', roomId, ')');

  // 尝试确保自动播放（成功则无需任何点击）；失败时电台页有兜底层
  const ok = await maybeInjectRadio(matches[0].id, url);
  if (ok) {
    console.log('[tongradio] radio autoplay ensured');
  } else {
    console.warn('[tongradio] radio autoplay not confirmed:', lastInjectInfo.reason);
  }
  return { autoplayOk: ok, injectReason: lastInjectInfo.reason };
}

async function notifyLive(info) {
  const title = info.uname ? info.uname + ' 开播了' : '主播开播了';
  const message = (info.title || '点击打开直播间') + ' · live.bilibili.com/' + info.roomId;
  try {
    await B.notifications.create(notifyId(info.roomId), {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: title,
      message: message,
    });
  } catch (e) {
    console.warn('[tongradio] notification failed:', e);
  }
}

// ---------------------------------------------------------------------------
// polling / state machine
// ---------------------------------------------------------------------------

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickInner();
  } finally {
    ticking = false;
  }
}

async function tickInner() {
  const cfg = await getConfig();
  const rooms = {}; // roomId(long) -> info

  // 1) UIDs: notify list + fixed watch uid
  const uidSet = new Set(cfg.notifyUids.map(String));
  if (cfg.watchMode === 'fixed' && cfg.fixedUid) uidSet.add(String(cfg.fixedUid));
  const uids = Array.from(uidSet).filter(Boolean);
  if (uids.length) {
    try {
      const byUid = await fetchByUids(uids);
      for (const raw of Object.values(byUid)) {
        const info = normalizeRoom(raw);
        if (info) rooms[info.roomId] = info;
      }
    } catch (e) {
      console.warn('[tongradio] uid batch fetch failed:', e);
    }
  }

  // 2) 'all' mode: every open live.bilibili.com tab
  if (cfg.watchMode === 'all') {
    const tabs = await liveTabs();
    for (const t of tabs) {
      const rid = extractRoomId(t.url || '');
      if (!rid) continue;
      try {
        const data = await fetchRoomInfo(rid);
        if (!data) continue;
        const info = normalizeRoom(data);
        if (info) rooms[info.roomId] = info;
      } catch (e) {
        console.warn('[tongradio] room fetch failed for', rid, e);
      }
    }
  }

  const state = await getState();
  state.lastCheck = Math.floor(Date.now() / 1000);

  for (const info of Object.values(rooms)) {
    const roomId = info.roomId;
    const before = state.prev[roomId];
    const now = info.status;

    // 记录快照供 popup 展示
    state.lastRooms[roomId] = info;

    if (before === undefined) {
      // 首次观测：只记录，不触发动作/通知
      state.prev[roomId] = now;
      continue;
    }
    state.prev[roomId] = now;

    // —— 播完动作：直播中 -> 非直播中 ——
    const watchedFixed = cfg.watchMode === 'fixed' && info.uid && String(info.uid) === String(cfg.fixedUid);
    const watchedAll = cfg.watchMode === 'all';
    if ((watchedFixed || watchedAll) && before === 1 && now !== 1) {
      try {
        await runEndAction(roomId, info.shortId, cfg);
      } catch (e) {
        console.warn('[tongradio] end action failed:', e);
      }
    }

    // —— 开播提醒：非直播中 -> 直播中 ——
    if (cfg.notifyEnabled && info.uid && cfg.notifyUids.includes(String(info.uid)) && before !== 1 && now === 1) {
      notifyLive(info);
    }
  }

  // 只保留本次见过的房间状态，避免陈旧记录占内存
  for (const rid of Object.keys(state.prev)) {
    if (!rooms[rid] && !state.lastRooms[rid]) {
      delete state.prev[rid];
      delete state.lastRooms[rid];
    }
  }

  await saveState(state);
}

function normalizeRoom(raw) {
  const roomId = raw.room_id != null ? Number(raw.room_id) : (raw.roomId != null ? Number(raw.roomId) : 0);
  if (!roomId) return null;
  return {
    roomId: roomId,
    shortId: raw.short_id != null ? Number(raw.short_id) : (raw.shortId != null ? Number(raw.shortId) : 0),
    uid: raw.uid != null ? Number(raw.uid) : (raw.uid ? Number(raw.uid) : null),
    uname: raw.uname || '',
    title: raw.title || '',
    status: raw.live_status != null ? Number(raw.live_status) : (raw.liveStatus != null ? Number(raw.liveStatus) : -1),
  };
}

// ---------------------------------------------------------------------------
// alarm
// ---------------------------------------------------------------------------

async function rescheduleAlarm(cfg) {
  const sec = Math.max(15, Math.min(3600, Number(cfg.pollSeconds) || 60));
  await B.alarms.create(ALARM, { periodInMinutes: sec / 60 });
}

async function bootstrap() {
  const cfg = await getConfig();
  await rescheduleAlarm(cfg);
}

// ---------------------------------------------------------------------------
// messaging (popup)
// ---------------------------------------------------------------------------

async function statusSnapshot() {
  const state = await getState();
  return { rooms: state.lastRooms || {}, lastCheck: state.lastCheck || 0 };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'check-now':
      await tick();
      return statusSnapshot();
    case 'get-statuses':
      return statusSnapshot();
    case 'test-end-action': {
      // 对指定房间（或第一个直播间标签页）立刻执行播完动作，用于端到端验证
      let roomId = Number(msg.roomId) || 0;
      let shortId = Number(msg.shortId) || 0;
      const cfg = await getConfig();
      if (!roomId) {
        const tabs = await liveTabs();
        const t = tabs[0];
        if (!t) return { ok: false, reason: 'no-tab' };
        const rid = extractRoomId(t.url || '');
        if (!rid) return { ok: false, reason: 'bad-url' };
        // 先解析出长短号
        try {
          const data = await fetchRoomInfo(rid);
          if (data) {
            roomId = Number(data.room_id) || rid;
            shortId = Number(data.short_id) || 0;
          } else {
            roomId = rid;
          }
        } catch (e) {
          roomId = rid;
        }
      }
      const r = await runEndAction(roomId, shortId, cfg);
      return { ok: true, roomId: roomId, endAction: cfg.endAction, autoplayOk: !!(r && r.autoplayOk), injectReason: r && r.injectReason };
    }
    case 'diagnose': {
      const cfg = await getConfig();
      let radio = null;
      try { radio = new URL(cfg.radioUrl).origin + '/*'; } catch (e) { /* ignore */ }
      let hostGranted = 'n/a';
      try {
        if (radio && B.permissions) hostGranted = await B.permissions.contains({ origins: [radio] });
      } catch (e) { hostGranted = 'err'; }
      let version = '';
      try { version = B.runtime.getManifest().version; } catch (e) { /* ignore */ }
      return {
        version: version,
        scripting: !!B.scripting,
        hostGranted: hostGranted,
        radioPattern: radio,
        endAction: cfg.endAction,
        radioUrl: cfg.radioUrl,
        lastInject: lastInjectInfo,
      };
    }
    case 'settings-saved': {
      const cfg = await getConfig();
      await rescheduleAlarm(cfg);
      return { ok: true };
    }
  }
}

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then((result) => {
    if (result !== undefined) sendResponse(result);
  });
  return true; // async
});

B.notifications.onClicked.addListener((id) => {
  const m = id.match(/^tongradio-live-(\d+)$/);
  const roomId = m ? Number(m[1]) : 0;
  if (roomId) {
    B.tabs.create({ url: 'https://live.bilibili.com/' + roomId });
  }
});

B.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM) {
    tick();
  }
});

// 电台页加载完成（扩展切换或手动打开带 ?autoplay 的电台链接）后，注入手势播放
B.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    maybeInjectRadio(tabId, tab && tab.url);
  }
});

B.runtime.onInstalled.addListener(() => { bootstrap(); });
B.runtime.onStartup.addListener(() => { bootstrap(); });

// 启动后立刻检查一轮（同时兜底：事件页/session 恢复时状态新鲜）
bootstrap().then(() => tick());
