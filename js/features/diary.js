/**
 * 共享日记本
 * ─ 你和对方共用一本日记，按会话独立存储
 * ─ 双方都能写、已读、回复、记想法
 * ─ 对方的内容取自现有字卡库（不新增内容池），随时想写就写
 * ─ 独立于聊天流：不经过 simulateReply，不受拼音模式影响
 */
(function () {
  'use strict';

  const STORE_KEY = 'sharedDiary';

  // 一篇日记由几条字卡拼成（随机 1~4 条，不做字数/条数限制）
  const ENTRY_CARDS_MIN = 1;
  const ENTRY_CARDS_MAX = 4;

  // 对方反应概率
  const P_REPLY = 0.55;
  const P_THOUGHT = 0.30;
  const P_REPLY_TO_MY_COMMENT = 0.45;

  let data = { entries: [], meta: { nextPartnerAt: 0 } };
  let initialized = false;
  let isOpen = false;
  let expanded = new Set();
  let saveTimer = null;
  let writeTimer = null;
  const pending = new Set();

  // ── 基础工具 ──
  function nowTs() { return Date.now(); }
  function uid(p) { return p + nowTs().toString(36) + Math.random().toString(36).slice(2, 6); }
  function partnerName() { return (typeof settings !== 'undefined' && settings.partnerName) || '对方'; }
  function myName() { return (typeof settings !== 'undefined' && settings.myName) || '我'; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtGap(ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return min + ' 分钟后';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时后';
    return Math.floor(h / 24) + ' 天后';
  }
  function later(sec, fn) {
    const id = setTimeout(() => { pending.delete(id); try { fn(); } catch (e) { console.warn('[diary]', e); } }, Math.max(1, sec) * 1000);
    pending.add(id);
    return id;
  }

  // ── 字卡池 ──
  function getPool() {
    const all = (typeof customReplies !== 'undefined' && Array.isArray(customReplies)) ? customReplies : [];
    const pool = all.map(t => String(t == null ? '' : t).trim()).filter(Boolean);
    const groupName = settings && settings.diaryGroupName;
    if (groupName && Array.isArray(window.customReplyGroups)) {
      const g = window.customReplyGroups.find(function (g) { return g && g.name === groupName; });
      if (g && Array.isArray(g.items)) {
        const set = new Set(g.items.map(function (t) { return String(t).trim(); }));
        const filtered = pool.filter(function (t) { return set.has(t); });
        if (filtered.length) return filtered;
      }
    }
    return pool;
  }

  function pickOne(pool) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // 按用途取内容：entry=日记正文，reply=回复，thought=想法
  function getDiaryText(kind) {
    const pool = getPool();
    if (!pool.length) return '';
    if (kind === 'entry') {
      const n = ENTRY_CARDS_MIN + Math.floor(Math.random() * (ENTRY_CARDS_MAX - ENTRY_CARDS_MIN + 1));
      const parts = [];
      let guard = 0;
      while (parts.length < n && guard < n * 5) {
        guard++;
        const t = pickOne(pool);
        // 只在同一篇里避免同一句重复，跨篇不限制
        if (t && parts.indexOf(t) === -1) parts.push(t);
      }
      return parts.join('\n');
    }
    return pickOne(pool);
  }

  // ── 持久化 ──
  function save() {
    if (!initialized) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        if (typeof getStorageKey === 'function' && typeof localforage !== 'undefined') {
          localforage.setItem(getStorageKey(STORE_KEY), data).catch(function () {});
        }
      } catch (e) {}
    }, 400);
  }

  function exportData() {
    return data;
  }

  // ── 未读 ──
  function unreadCount() {
    return data.entries.filter(function (e) { return e.author === 'partner' && !e.readByUser; }).length;
  }

  function updateBadge() {
    const dot = document.getElementById('diary-dot');
    const badge = document.getElementById('diary-unread-badge');
    const n = unreadCount();
    if (dot) dot.style.display = n > 0 ? 'block' : 'none';
    if (badge) {
      badge.textContent = n + ' 篇未读';
      badge.style.display = n > 0 ? 'inline-flex' : 'none';
    }
  }

  // ── 渲染 ──
  function entryHTML(entry) {
    const isMine = entry.author === 'user';
    const name = isMine ? myName() : partnerName();
    const open = expanded.has(entry.id);
    const replies = entry.comments.filter(function (c) { return c.kind === 'reply'; }).length;
    const thoughts = entry.comments.filter(function (c) { return c.kind === 'thought'; }).length;

    let readHTML = '';
    if (isMine) {
      if (entry.readByPartner) {
        readHTML = '<span class="diary-read-label">已读 · ' + fmtGap(entry.readByPartner - entry.createdAt) + '</span>';
      } else {
        readHTML = '<span class="diary-read-label diary-read-pending">未读</span>';
      }
    } else if (!entry.readByUser) {
      readHTML = '<span class="diary-unread-tag">未读</span>';
    } else {
      readHTML = '<span class="diary-read-label">已读</span>';
    }

    const footBits = [];
    if (replies) footBits.push(replies + ' 条回复');
    if (thoughts) footBits.push(thoughts + ' 个想法');
    const footHTML = footBits.length
      ? '<div class="diary-foot"><i class="fas fa-comment-dots"></i>' + footBits.join(' · ') + '</div>'
      : '';

    const threadHTML = open ? (
      '<div class="diary-thread">' +
      entry.comments.map(function (c) {
        const who = c.author === 'user' ? myName() : partnerName();
        const cls = c.kind === 'thought' ? 'diary-cmt diary-cmt-thought' : 'diary-cmt diary-cmt-reply';
        const tag = c.kind === 'thought' ? '想法' : '回复';
        return '<div class="' + cls + '">' +
          '<div class="diary-cmt-head">' + esc(who) + ' · ' + tag + ' · ' + fmtTime(c.createdAt) + '</div>' +
          '<div class="diary-cmt-text">' + esc(c.text).replace(/\n/g, '<br>') + '</div>' +
          '</div>';
      }).join('') +
      '<div class="diary-composer">' +
      '<input class="diary-cmt-input" type="text" placeholder="写点什么…" maxlength="500">' +
      '<button type="button" class="diary-cmt-btn" data-diary-cmt="reply">回复</button>' +
      '<button type="button" class="diary-cmt-btn" data-diary-cmt="thought">记个想法</button>' +
      '</div>' +
      '</div>'
    ) : '';

    const avatarEl = isMine ? (typeof DOMElements !== 'undefined' ? DOMElements.me.avatar : null)
      : (typeof DOMElements !== 'undefined' ? DOMElements.partner.avatar : null);
    const avatarImg = avatarEl ? avatarEl.querySelector('img') : null;
    const avatarHTML = (avatarImg && avatarImg.src)
      ? '<div class="diary-avatar"><img src="' + esc(avatarImg.src) + '" alt=""></div>'
      : '<div class="diary-avatar">' + esc(name.charAt(0)) + '</div>';

    return '<div class="diary-entry' + (open ? ' is-open' : '') + '" data-id="' + entry.id + '">' +
      '<div class="diary-entry-head">' +
      avatarHTML +
      '<div class="diary-head-main">' +
      '<span class="diary-author">' + esc(name) + '</span>' +
      readHTML +
      '<span class="diary-time">' + fmtTime(entry.createdAt) + '</span>' +
      '</div>' +
      (isMine ? '<button type="button" class="diary-del" data-diary-del="' + entry.id + '" title="删除这篇日记"><i class="fas fa-trash-alt"></i></button>' : '') +
      '</div>' +
      '<div class="diary-text">' + esc(entry.text).replace(/\n/g, '<br>') + '</div>' +
      footHTML +
      threadHTML +
      '</div>';
  }

  function dateLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(today.getTime() - 86400000);
    const sameDay = function (a, b) { return a.toDateString() === b.toDateString(); };
    const md = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    const week = '日一二三四五六'.charAt(d.getDay());
    if (sameDay(d, today)) return md + ' · 今天';
    if (sameDay(d, yest)) return md + ' · 昨天';
    return md + ' · 周' + week;
  }

  function render() {
    const list = document.getElementById('diary-list');
    if (!list) return;
    updateBadge();

    const entries = data.entries.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (!entries.length) {
      list.innerHTML = '<div class="diary-empty"><i class="fas fa-book-open"></i>' +
        '<div class="diary-empty-title">还没有日记</div>' +
        '<div class="diary-empty-hint">点右上角「写一篇」记下今天；' + esc(partnerName()) + ' 也会随时来写</div></div>';
      return;
    }

    let html = '';
    let lastDate = '';
    entries.forEach(function (e) {
      const d = new Date(e.createdAt).toDateString();
      if (d !== lastDate) {
        html += '<div class="diary-date">' + dateLabel(e.createdAt) + '</div>';
        lastDate = d;
      }
      html += entryHTML(e);
    });
    list.innerHTML = html;
  }

  // ── 打开 / 关闭 ──
  function open(entryId) {
    const modal = document.getElementById('diary-modal');
    if (!modal) return;
    isOpen = true;
    const list = document.getElementById('diary-list');
    const editor = document.getElementById('diary-editor');
    if (editor) editor.style.display = 'none';
    if (list) list.style.display = 'flex';
    if (entryId) expanded.add(entryId);
    render();
    if (entryId) {
      const el = list ? list.querySelector('.diary-entry[data-id="' + entryId + '"]') : null;
      if (el) setTimeout(function () { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 120);
    } else if (list) {
      list.scrollTop = 0;
    }
    if (typeof showModal === 'function') showModal(modal);
    else modal.style.display = 'flex';
  }

  function close() {
    const modal = document.getElementById('diary-modal');
    if (!modal) return;
    isOpen = false;
    if (typeof hideModal === 'function') hideModal(modal);
    else modal.style.display = 'none';
  }

  // ── 已读 ──
  function markRead(entry) {
    if (!entry || entry.author !== 'partner' || entry.readByUser) return;
    entry.readByUser = nowTs();
    save();
    updateBadge();
    const card = document.querySelector('.diary-entry[data-id="' + entry.id + '"]');
    if (card) {
      const tag = card.querySelector('.diary-unread-tag');
      if (tag) {
        tag.className = 'diary-read-label';
        tag.textContent = '已读';
      }
    }
  }

  function toggleExpand(id) {
    const entry = data.entries.find(function (e) { return e.id === id; });
    if (!entry) return;
    if (expanded.has(id)) {
      expanded.delete(id);
      render();
      return;
    }
    expanded.add(id);
    render();
    markRead(entry);
  }

  // ── 写日记（我） ──
  function showEditor() {
    const list = document.getElementById('diary-list');
    const editor = document.getElementById('diary-editor');
    if (!editor) return;
    if (list) list.style.display = 'none';
    editor.style.display = 'flex';
    const input = document.getElementById('diary-input');
    if (input) { input.value = ''; setTimeout(function () { input.focus(); }, 60); }
  }

  function hideEditor() {
    const list = document.getElementById('diary-list');
    const editor = document.getElementById('diary-editor');
    if (editor) editor.style.display = 'none';
    if (list) list.style.display = 'flex';
  }

  function submitEntry() {
    const input = document.getElementById('diary-input');
    const text = (input && input.value || '').trim();
    if (!text) {
      if (typeof showNotification === 'function') showNotification('还没写内容', 'info');
      return;
    }
    const entry = {
      id: uid('d'),
      author: 'user',
      text: text,
      createdAt: nowTs(),
      readByUser: nowTs(),
      readByPartner: null,
      comments: []
    };
    data.entries.push(entry);
    save();
    if (input) input.value = '';
    hideEditor();
    render();
    if (typeof showNotification === 'function') showNotification('已写进日记本', 'success');
    simulatePartnerReaction(entry);
  }

  function deleteEntry(id) {
    const idx = data.entries.findIndex(function (e) { return e.id === id; });
    if (idx === -1) return;
    if (!window.confirm('删除这篇日记？')) return;
    expanded.delete(id);
    data.entries.splice(idx, 1);
    save();
    render();
  }

  // ── 评论：回复 / 想法 ──
  function addComment(entryId, kind, text) {
    const entry = data.entries.find(function (e) { return e.id === entryId; });
    if (!entry) return;
    text = String(text || '').trim();
    if (!text) {
      if (typeof showNotification === 'function') showNotification(kind === 'thought' ? '写点想法再记' : '写点内容再回复', 'info');
      return;
    }
    entry.comments.push({
      id: uid('c'),
      author: 'user',
      kind: kind === 'thought' ? 'thought' : 'reply',
      text: text,
      createdAt: nowTs()
    });
    if (entry.author === 'partner') markRead(entry);
    save();
    render();
    if (entry.author === 'partner' && kind !== 'thought' && Math.random() < P_REPLY_TO_MY_COMMENT) {
      later(30 + Math.random() * 90, function () {
        const t = getDiaryText('reply');
        if (t) addCommentInternal(entry, 'partner', 'reply', t);
      });
    }
  }

  function addCommentInternal(entry, author, kind, text) {
    entry.comments.push({
      id: uid('c'),
      author: author,
      kind: kind,
      text: String(text).trim(),
      createdAt: nowTs()
    });
    save();
    if (isOpen) render();
  }

  // ── 对方行为 ──
  function refreshEntryMeta(entry) {
    if (!isOpen) return;
    const card = document.querySelector('.diary-entry[data-id="' + entry.id + '"]');
    if (!card) { render(); return; }
    const label = card.querySelector('.diary-read-label');
    if (entry.readByPartner && label) {
      label.classList.remove('diary-read-pending');
      label.textContent = '已读 · ' + fmtGap(entry.readByPartner - entry.createdAt);
    }
  }

  function simulatePartnerReaction(entry) {
    // 已读：30~120 秒后
    later(30 + Math.random() * 90, function () {
      if (!entry.readByPartner) {
        entry.readByPartner = nowTs();
        save();
        refreshEntryMeta(entry);
      }
      if (Math.random() < P_REPLY) {
        later(20 + Math.random() * 70, function () {
          const t = getDiaryText('reply');
          if (t) addCommentInternal(entry, 'partner', 'reply', t);
        });
      }
      if (Math.random() < P_THOUGHT) {
        later(60 + Math.random() * 240, function () {
          const t = getDiaryText('thought');
          if (t) addCommentInternal(entry, 'partner', 'thought', t);
        });
      }
    });
  }

  function writePartnerEntry() {
    if (settings && settings.diaryEnabled === false) { schedulePartnerWrite(); return; }
    const text = getDiaryText('entry');
    if (!text) { schedulePartnerWrite(); return; }   // 字卡为空：不写，等下次
    const entry = {
      id: uid('d'),
      author: 'partner',
      text: text,
      createdAt: nowTs(),
      readByUser: null,
      readByPartner: nowTs(),
      comments: []
    };
    data.entries.push(entry);
    data.meta.lastPartnerEntryAt = entry.createdAt;
    save();
    updateBadge();
    if (isOpen) render();
    notifyInChat(entry);
    if (typeof window._sendPartnerNotification === 'function') {
      window._sendPartnerNotification(partnerName(), '写了一篇日记');
    }
    schedulePartnerWrite();
  }

  function notifyInChat(entry) {
    try {
      if (typeof addMessage !== 'function') return;
      addMessage({
        id: nowTs() + Math.random(),
        sender: null,
        text: '<span class="diary-chat-link" data-diary-entry="' + entry.id + '">' +
          esc(partnerName()) + ' 写了一篇日记</span>',
        timestamp: new Date(),
        type: 'system'
      });
    } catch (e) {}
  }

  function schedulePartnerWrite(firstDelaySec) {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (!initialized) return;
    const dailyMax = Number(settings && settings.diaryDailyMax);
    const max = isNaN(dailyMax) ? 2 : Math.max(0, dailyMax);
    if ((settings && settings.diaryEnabled === false) || max <= 0) return;

    let ms;
    if (firstDelaySec) {
      ms = firstDelaySec * 1000;
    } else {
      const base = 86400000 / max;
      ms = base * (0.55 + Math.random() * 0.95);
      const h = new Date().getHours();
      if (h >= 19) ms *= 0.65;          // 晚上更爱写
      else if (h < 7) ms *= 2.2;        // 凌晨少写
      ms = Math.max(60000, Math.min(ms, 14 * 3600000));
    }

    writeTimer = setTimeout(function () {
      writeTimer = null;
      writePartnerEntry();
    }, ms);
  }

  // ── 设置面板：日记内容来源 ──
  function refreshGroupSelect() {
    const sel = document.getElementById('diary-group-select');
    if (!sel) return;
    const groups = Array.isArray(window.customReplyGroups) ? window.customReplyGroups : [];
    const cur = (settings && settings.diaryGroupName) || '';
    let html = '<option value="">全部字卡</option>';
    groups.forEach(function (g) {
      if (!g || !g.name) return;
      html += '<option value="' + esc(g.name) + '">' + esc(g.name) + '</option>';
    });
    sel.innerHTML = html;
    sel.value = cur;
    const hint = document.getElementById('diary-group-hint');
    if (hint) {
      const n = getPool().length;
      hint.textContent = n > 0
        ? '当前可用字卡 ' + n + ' 条'
        : '字卡库为空，对方暂时不会写日记';
    }
  }

  // ── UI 绑定 ──
  let bound = false;
  function bindUI() {
    if (bound) return;
    bound = true;

    const btn = document.getElementById('diary-btn');
    if (btn) btn.addEventListener('click', function () { open(); });

    const closeBtn = document.getElementById('diary-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    const writeBtn = document.getElementById('diary-write-btn');
    if (writeBtn) writeBtn.addEventListener('click', showEditor);

    const saveBtn = document.getElementById('diary-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', submitEntry);

    const cancelBtn = document.getElementById('diary-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', hideEditor);

    const input = document.getElementById('diary-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitEntry(); }
      });
    }

    const modal = document.getElementById('diary-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) close();
      });
    }

    const list = document.getElementById('diary-list');
    if (list) {
      list.addEventListener('click', function (e) {
        const del = e.target.closest('[data-diary-del]');
        if (del) { e.stopPropagation(); deleteEntry(del.getAttribute('data-diary-del')); return; }

        const cmtBtn = e.target.closest('[data-diary-cmt]');
        if (cmtBtn) {
          const card = cmtBtn.closest('.diary-entry');
          if (!card) return;
          const field = card.querySelector('.diary-cmt-input');
          addComment(card.getAttribute('data-id'), cmtBtn.getAttribute('data-diary-cmt'), field ? field.value : '');
          return;
        }

        if (e.target.closest('input, textarea, button, a')) return;
        const card = e.target.closest('.diary-entry');
        if (card) toggleExpand(card.getAttribute('data-id'));
      });

      list.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        const field = e.target.closest('.diary-cmt-input');
        if (!field) return;
        e.preventDefault();
        const card = field.closest('.diary-entry');
        if (card) addComment(card.getAttribute('data-id'), 'reply', field.value);
      });
    }

    const groupSel = document.getElementById('diary-group-select');
    if (groupSel) {
      groupSel.addEventListener('change', function () {
        settings.diaryGroupName = groupSel.value || '';
        if (typeof throttledSaveData === 'function') throttledSaveData();
        refreshGroupSelect();
      });
    }

    // 聊天里的系统消息：点「写了一篇日记」跳进日记本
    document.addEventListener('click', function (e) {
      const link = e.target.closest('.diary-chat-link');
      if (!link) return;
      open(link.getAttribute('data-diary-entry'));
    });
  }

  // ── 初始化 ──
  function init(raw) {
    if (raw && Array.isArray(raw.entries)) {
      data = {
        entries: raw.entries,
        meta: Object.assign({ nextPartnerAt: 0 }, raw.meta || {})
      };
      // 兼容旧数据：补齐缺省字段
      data.entries.forEach(function (e) {
        if (!Array.isArray(e.comments)) e.comments = [];
        if (e.readByUser === undefined) e.readByUser = null;
        if (e.readByPartner === undefined) e.readByPartner = null;
      });
    }
    initialized = true;
    bindUI();
    updateBadge();
    refreshGroupSelect();
    // 还没有对方的日记时，先来一篇短的（90~300 秒），让功能能被看见
    const partnerEntries = data.entries.filter(function (e) { return e.author === 'partner'; }).length;
    if (partnerEntries === 0) schedulePartnerWrite(90 + Math.random() * 210);
    else schedulePartnerWrite();
  }

  window.SharedDiary = {
    init: init,
    open: open,
    close: close,
    exportData: exportData,
    reschedule: schedulePartnerWrite,
    updateBadge: updateBadge,
    refreshGroupSelect: refreshGroupSelect,
    // 调试 / 自测用
    previewText: getDiaryText,
    poolSize: function () { return getPool().length; },
    writePartnerEntryNow: function () { writePartnerEntry(); },
    state: function () { return data; }
  };
})();
