/**
 * TongRadio Assistant — popup controller.
 * Reads/writes settings in storage.sync, talks to background via messages.
 */
'use strict';

const B = (typeof browser !== 'undefined') ? browser : chrome;

const LS_SETTINGS = 'settings';

const DEFAULTS = {
  watchMode: 'fixed',
  fixedUid: '401315430',
  endAction: 'radio',
  radioUrl: 'https://radio.autsun.asia/',
  pollSeconds: 60,
  notifyEnabled: true,
  notifyUids: ['401315430'],
  reliableMode: true,   // 可靠模式默认开
};

// status badge helpers
const STATUS_LABEL = { 0: '未开播', 1: '直播中', 2: '轮播中' };
const STATUS_CLASS = { 0: 'off', 1: 'live', 2: 'round' };

let currentRooms = {}; // roomId -> info snapshot (from background)
let settings = null;

const $ = (sel) => document.querySelector(sel);

async function loadSettings() {
  let stored = {};
  try {
    const obj = await B.storage.sync.get(LS_SETTINGS);
    if (obj && obj[LS_SETTINGS]) stored = obj[LS_SETTINGS];
  } catch (e) { /* ignore */ }
  settings = Object.assign({}, DEFAULTS, stored);
  // 与后台一致：旧版本（无 _schema 标记）的 reliableMode:false 是坏数据，按默认 true 处理
  if (settings.reliableMode === false && !stored._schema) {
    settings.reliableMode = true;
  }
  if (!Array.isArray(settings.notifyUids) || settings.notifyUids.length === 0) {
    settings.notifyUids = [DEFAULTS.fixedUid];
  }
  return settings;
}

async function saveSettings() {
  settings._schema = 2;   // 设置版本：标记「可靠模式」的开关是用户主动选择的
  await B.storage.sync.set({ [LS_SETTINGS]: settings });
  try { await B.runtime.sendMessage({ type: 'settings-saved' }); } catch (e) { /* ignore */ }
  refreshUidList();
  showToast('设置已保存');
}

function readForm() {
  const watchMode = document.querySelector('input[name="watchMode"]:checked');
  const endAction = document.querySelector('input[name="endAction"]:checked');
  settings.watchMode = watchMode ? watchMode.value : settings.watchMode;
  settings.endAction = endAction ? endAction.value : settings.endAction;
  settings.fixedUid = ($('#fixedUid').value || '').trim() || DEFAULTS.fixedUid;
  settings.radioUrl = ($('#radioUrl').value || '').trim() || DEFAULTS.radioUrl;
  settings.pollSeconds = Number($('#pollSeconds').value) || 60;
  settings.notifyEnabled = $('#notifyEnabled').checked;
  settings.reliableMode = !!$('#reliableMode').checked;
}

function fillForm() {
  const radio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  radio('watchMode', settings.watchMode);
  radio('endAction', settings.endAction);
  $('#fixedUid').value = settings.fixedUid;
  $('#radioUrl').value = settings.radioUrl;
  $('#pollSeconds').value = String(settings.pollSeconds);
  $('#notifyEnabled').checked = !!settings.notifyEnabled;
  $('#reliableMode').checked = !!settings.reliableMode;
}

// ---- UID list ----
function renderUidItem(uid) {
  const room = findRoomByUid(uid);
  const li = document.createElement('li');
  li.className = 'uid-item';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = room && room.uname ? room.uname : ('UID ' + uid);
  name.title = 'UID ' + uid;

  const sub = document.createElement('span');
  sub.className = 'uid-sub';
  sub.textContent = room ? ('room ' + room.roomId) : '待检查';

  const badge = document.createElement('span');
  badge.className = 'badge ' + (room ? (STATUS_CLASS[room.status] || 'unknown') : 'unknown');
  badge.textContent = room ? (STATUS_LABEL[room.status] || '未知') : '未知';

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'rm';
  rm.title = '移除';
  rm.textContent = '✕';
  rm.addEventListener('click', () => {
    settings.notifyUids = settings.notifyUids.filter((u) => u !== uid);
    saveSettings();
  });

  li.appendChild(name);
  li.appendChild(sub);
  li.appendChild(badge);
  li.appendChild(rm);
  return li;
}

function refreshUidList() {
  const ul = $('#uidList');
  ul.innerHTML = '';
  settings.notifyUids.forEach((uid) => {
    ul.appendChild(renderUidItem(uid));
  });
  if (settings.notifyUids.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '还没有监控的开播提醒 UID';
    ul.appendChild(empty);
  }
}

function findRoomByUid(uid) {
  for (const r of Object.values(currentRooms || {})) {
    if (r.uid != null && String(r.uid) === String(uid)) return r;
  }
  return null;
}

// ---- last check / statuses ----
async function refreshStatuses() {
  try {
    const snap = await B.runtime.sendMessage({ type: 'get-statuses' });
    currentRooms = (snap && snap.rooms) || {};
    if (snap && snap.lastCheck) {
      const d = new Date(snap.lastCheck * 1000);
      $('#lastCheck').textContent = '上次检查：' + d.toLocaleTimeString();
    }
    refreshUidList();
  } catch (e) {
    $('#lastCheck').textContent = '上次检查：读取失败';
  }
}

// ---- toast ----
let toastTimer = null;
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---- events ----
function bindEvents() {
  $('#addUidBtn').addEventListener('click', () => {
    const v = ($('#newUid').value || '').trim();
    if (!/^\d+$/.test(v)) { showToast('UID 需为纯数字'); return; }
    if (settings.notifyUids.includes(v)) { showToast('该 UID 已在列表'); return; }
    settings.notifyUids.push(v);
    $('#newUid').value = '';
    saveSettings();
  });
  $('#newUid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#addUidBtn').click();
  });

  $('#checkNow').addEventListener('click', async () => {
    $('#lastCheck').textContent = '正在检查…';
    try {
      const snap = await B.runtime.sendMessage({ type: 'check-now' });
      currentRooms = (snap && snap.rooms) || {};
      if (snap && snap.lastCheck) {
        $('#lastCheck').textContent = '上次检查：' + new Date(snap.lastCheck * 1000).toLocaleTimeString();
      }
      refreshUidList();
      showToast('检查完成');
    } catch (e) {
      $('#lastCheck').textContent = '检查失败';
    }
  });

  $('#testEnd').addEventListener('click', async () => {
    try {
      const r = await B.runtime.sendMessage({ type: 'test-end-action' });
      if (r && r.ok) {
        if (r.endAction === 'close') {
          showToast('已关闭直播间标签页');
        } else if (r.autoplayOk) {
          showToast('已切到电台并自动开播 ✓');
        } else {
          showToast('已切到电台（被拦截：' + (r.injectReason || '未知') + '），诊断里看原因');
        }
      } else if (r && r.reason === 'no-tab') {
        showToast('没有打开的直播间标签页');
      } else {
        showToast('执行失败');
      }
      runDiagnose();
    } catch (e) {
      showToast('执行失败');
    }
  });

  // 任意设置变化 -> 保存（reliableMode 单独处理，需先请求 debugger 权限）
  ['change', 'input'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      if (!(e.target instanceof Element)) return;
      const id = e.target.id;
      if (id === 'reliableMode') return;
      if (id === 'fixedUid' || id === 'radioUrl') return; // text input: save on blur/Enter
      if (e.target.closest('.uid-add')) return;
      if (e.target.closest('#uidList')) return;
      readForm();
      saveSettings();
    });
  });

  $('#reliableMode').addEventListener('change', () => {
    // debugger 权限已内置，无需运行时授权，直接保存即可
    readForm();
    saveSettings();
  });

  ['fixedUid', 'radioUrl'].forEach((id) => {
    const el = $('#' + id);
    el.addEventListener('blur', () => { readForm(); saveSettings(); checkRadioPermission(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });

  $('#grantPerm').addEventListener('click', async () => {
    if (!B.permissions) { showToast('当前浏览器不支持运行时授权'); return; }
    const origin = radioOrigin(settings.radioUrl);
    if (!origin) return;
    try {
      const granted = await B.permissions.request({ origins: [origin] });
      showToast(granted ? '已授权，可自动播放' : '未授权');
      await checkRadioPermission();
    } catch (e) {
      showToast('授权失败');
    }
  });

  // 诊断
  $('#diagRefresh').addEventListener('click', runDiagnose);
  $('#grantPerm2').addEventListener('click', async () => {
    if (!B.permissions) { showToast('当前浏览器不支持运行时授权'); return; }
    const origin = radioOrigin(settings.radioUrl);
    if (!origin) return;
    try {
      const granted = await B.permissions.request({ origins: [origin] });
      showToast(granted ? '已授权' : '未授权');
      await runDiagnose();
    } catch (e) {
      showToast('授权失败');
    }
  });
}

async function runDiagnose() {
  const el = $('#diagText');
  if (!el) return;
  el.textContent = '读取中…';
  try {
    const d = await B.runtime.sendMessage({ type: 'diagnose' });
    const hostText = d.hostGranted === true ? '✅ 已授权' : (d.hostGranted === false ? '❌ 未授权' : String(d.hostGranted));
    el.textContent =
      '版本: ' + d.version + '\n' +
      'scripting 可用: ' + (d.scripting ? '✅' : '❌ 需要新版浏览器/重装') + '\n' +
      'debugger 可用: ' + (d.debugger ? '✅' : '—（Firefox 无此权限，用站点权限）') + '\n' +
      '可靠模式: ' + (d.reliableMode ? '开 ✅' : '关 ❌') + '\n' +
      '电台域名权限: ' + hostText + '  (' + (d.radioPattern || '未知') + ')\n' +
      '播完动作: ' + d.endAction + '\n' +
      '电台地址: ' + d.radioUrl + '\n' +
      '最近一次注入: ' + JSON.stringify(d.lastInject) + '\n\n' +
      '若「电台域名权限」显示 ❌：点上面的「授权电台域名」按钮';
  } catch (e) {
    el.textContent = '诊断失败: ' + e;
  }
}

function radioOrigin(url) {
  try {
    return new URL(url).origin + '/*';
  } catch (e) {
    return null;
  }
}

async function checkRadioPermission() {
  const row = $('#permRow');
  if (!row || !B.permissions) return;
  const origin = radioOrigin(settings.radioUrl);
  if (!origin) { row.style.display = 'none'; return; }
  try {
    const ok = await B.permissions.contains({ origins: [origin] });
    row.style.display = ok ? 'none' : 'flex';
  } catch (e) {
    row.style.display = 'none';
  }
}

async function init() {
  await loadSettings();
  fillForm();
  bindEvents();
  await checkRadioPermission();
  await refreshStatuses();
  await runDiagnose();
}

init();
