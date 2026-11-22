/**
 * ai-chat.js — AI 对话模式（独立于字卡 / 拼音的第三种回复方式）
 *
 * 设计约定：
 *  - 仅当 settings.replyMode === 'ai' 时才会发起任何网络请求；
 *    字卡模式与拼音模式完全不经过本模块的请求逻辑。
 *  - 不发送聊天记录原文：每轮请求只带 人设 + 检索到的记忆 + 本场窗口(最近2轮) + 你刚说的这句。
 *  - 每次进入 AI 模式窗口清零（话题中断，从新话题开始）；本地聊天记录照常保存。
 *  - API Key 存 localStorage('milk_ai_api_cfg')，备份引擎无条件跳过该键，绝不导出。
 */
(function () {
  'use strict';

  // ───────── 常量 ─────────
  const API_CFG_KEY = 'milk_ai_api_cfg';          // localStorage，备份跳过
  const PERSONA_KEY = 'aiPersona';                 // localforage，随会话，进备份
  const MEMORY_KEY = 'aiMemory';                   // localforage，随会话，进备份
  const REQUEST_TIMEOUT = 15000;
  const WINDOW_ROUNDS = 2;                         // 本场窗口保留最近 N 轮（1轮=1问1答2条）
  const MEMORY_TOP = 12;
  const MEMORY_MAX = 300;
  const MEM_TYPES = ['事实', '事件', '偏好', '约定'];

  // ───────── 状态 ─────────
  let apiCfg = { baseURL: '', model: '', apiKey: '' };
  let persona = null;
  let memory = { entries: [] };
  let sessionWindow = [];        // 本场窗口 [{role,content}]
  let lastTrackedMode = null;    // 窗口生命周期：上一次回合所处的模式
  let aiBusy = false;
  let pendingHandle = false;     // 请求期间又来了一条消息，结束后补一轮
  let backfillAbort = false;
  let saveMemoryTimer = null;

  // ───────── 小工具 ─────────
  function $(id) { return document.getElementById(id); }
  function randInt(n) { return Math.floor(Math.random() * n); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getStorageKey(name) {
    try { if (typeof window.getStorageKey === 'function') return window.getStorageKey(name); } catch (e) {}
    return 'CHAT_APP_V3_' + name;
  }

  // ───────── 存储 ─────────
  function loadApiCfg() {
    try {
      const raw = localStorage.getItem(API_CFG_KEY);
      if (raw) apiCfg = Object.assign({ baseURL: '', model: '', apiKey: '' }, JSON.parse(raw));
    } catch (e) { apiCfg = { baseURL: '', model: '', apiKey: '' }; }
  }
  function saveApiCfg() {
    try { localStorage.setItem(API_CFG_KEY, JSON.stringify(apiCfg)); } catch (e) {}
  }

  async function loadPersona() {
    try {
      const raw = await localforage.getItem(getStorageKey(PERSONA_KEY));
      persona = raw && typeof raw === 'object' ? raw : null;
    } catch (e) { persona = null; }
  }
  async function loadMemory() {
    try {
      const raw = await localforage.getItem(getStorageKey(MEMORY_KEY));
      if (raw && Array.isArray(raw.entries)) memory = { entries: raw.entries };
    } catch (e) { memory = { entries: [] }; }
  }
  function saveMemorySoon() {
    if (saveMemoryTimer) clearTimeout(saveMemoryTimer);
    saveMemoryTimer = setTimeout(() => {
      saveMemoryTimer = null;
      try { localforage.setItem(getStorageKey(MEMORY_KEY), memory); } catch (e) {}
    }, 600);
  }

  // ───────── 模式判定（与 core.js / listeners.js 同一套规则）─────────
  function currentMode() {
    if (typeof settings === 'undefined') return 'cards';
    if (settings.replyMode === 'ai') return 'ai';
    if (settings.pinyinTypingEnabled) return 'pinyin';
    return 'cards';
  }

  // 供 core.js 每回合调用：纯状态记录，无任何网络/AI 行为
  function noteMode(mode) {
    if (lastTrackedMode === 'ai' && mode !== 'ai') {
      // 离开 AI 模式：本场窗口作废（话题中断）
      sessionWindow = [];
    }
    lastTrackedMode = mode;
  }

  // ───────── 记忆：中文 2-gram 检索 ─────────
  function grams(s) {
    s = String(s || '');
    const out = new Set();
    for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
    // 英文单词整词
    const words = s.toLowerCase().match(/[a-z]{2,}/g);
    if (words) words.forEach(w => out.add(w));
    return out;
  }
  function gramCache(m) {
    if (!m._grams) m._grams = grams(m.text);
    return m._grams;
  }
  function retrieveMemory(query) {
    const q = grams(query);
    const now = Date.now();
    return memory.entries
      .map(m => {
        let sc = (m.weight || 1);
        let hit = 0;
        gramCache(m).forEach(g => { if (q.has(g)) hit++; });
        sc += hit * 3;
        const days = (now - (m.lastHitAt || m.createdAt)) / 86400000;
        sc += Math.max(0, 3 - days);
        return { m, sc, hit };
      })
      .filter(x => x.sc > (x.m.weight || 1) || x.hit > 0 || memory.entries.length <= MEMORY_TOP)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, MEMORY_TOP)
      .map(x => {
        if (x.hit > 0) x.m.lastHitAt = now;
        return x.m;
      });
  }

  function applyMemBlock(block) {
    if (!block) return;
    let changed = false;
    block.split(/\n+/).forEach(line => {
      line = line.trim();
      if (!line) return;
      const add = line.match(/^\+\s*(.*)$/);
      const del = line.match(/^-\s*(.*)$/);
      if (add) {
        const parts = add[1].split('|').map(s => s.trim());
        const type = MEM_TYPES.includes(parts[0]) ? parts[0] : '事件';
        const text = parts[1] || parts[0] || '';
        const weight = Math.max(1, Math.min(3, parseInt(parts[2], 10) || 2));
        if (text && text.length >= 3) {
          // 去重：完全相同的文本不重复记
          if (!memory.entries.some(m => m.text === text)) {
            memory.entries.push({
              id: Date.now() + '_' + randInt(99999),
              type: type, text: text, weight: weight,
              createdAt: Date.now(), lastHitAt: Date.now()
            });
            changed = true;
          }
        }
      } else if (del) {
        const t = del[1].trim();
        const before = memory.entries.length;
        memory.entries = memory.entries.filter(m => m.text !== t && m.id !== t);
        if (memory.entries.length !== before) changed = true;
      }
    });
    // 容量淘汰：最久未命中的低权重条目先走
    while (memory.entries.length > MEMORY_MAX) {
      let worst = -1, worstSc = Infinity;
      memory.entries.forEach((m, i) => {
        const sc = (m.weight || 1) * 1000000 + (m.lastHitAt || m.createdAt);
        if (m.type !== '约定' && sc < worstSc) { worstSc = sc; worst = i; }
      });
      if (worst < 0) break;
      memory.entries.splice(worst, 1);
      changed = true;
    }
    if (changed) saveMemorySoon();
    return changed;
  }

  // ───────── 提示词 ─────────
  function buildSystemPrompt(memoryLines) {
    const p = persona || {};
    const name = p.name || settings.partnerName || '对方';
    const L = [];
    L.push('你是「' + name + '」，' + (p.identity || '对方很重要的人') + '。');
    if (p.personality) L.push('你的性格：' + p.personality);
    if (p.style) L.push('你的说话风格：' + p.style);
    if (p.background) L.push('你的背景：' + p.background);
    if (p.taboos) L.push('你绝对不会：' + p.taboos);
    if (p.examples) L.push('你们的对话示例（模仿这种语气）：\n' + p.examples);
    L.push([
      '输出规则（必须遵守）：',
      '- 你在用手机和对方聊天。每次回复 1~3 条消息，每条不超过 30 个字，多条之间用 || 分隔。',
      '- 像真人发微信：不用列表、不用标题、不用 markdown、不解释自己是 AI、不复述记忆原文。',
      '- 常用动作描写：用中文全角括号包住外在动作，一条消息最多一个，不超过 12 个字，如（把手机扣在桌上）。不描写心理活动。',
      '- 你和对方认识很久。下面是关于对方的记忆，自然地使用它们，不要逐字引用。',
      '- 如果这轮对话里出现了值得长期记住的新信息，在回复最末尾输出一个 <mem> 块，每行格式：+ 类型|内容|权重。类型只能是：事实/事件/偏好/约定，权重 1~3。也可以用 - 内容 来删除过时的记忆。没有新信息就不输出 mem 块。',
      '',
      '关于对方的记忆：',
      memoryLines.length ? memoryLines.map(m => '- [' + m.type + '] ' + m.text).join('\n') : '（暂无，靠对话慢慢了解）'
    ].join('\n'));
    return L.join('\n\n');
  }

  // ───────── 请求层 ─────────
  function normalizeBaseURL(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (!url) return '';
    return url;
  }
  function endpoint() {
    let b = normalizeBaseURL(apiCfg.baseURL);
    if (!b) return '';
    if (/\/chat\/completions$/.test(b)) return b;
    return b + '/chat/completions';
  }

  async function callLLM(messages, opts) {
    opts = opts || {};
    const url = endpoint();
    if (!url) throw Object.assign(new Error('EMPTY_URL'), { kind: 'config' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || REQUEST_TIMEOUT);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiCfg.apiKey
        },
        body: JSON.stringify({
          model: apiCfg.model,
          messages: messages,
          temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.9,
          max_tokens: opts.max_tokens || 400
        }),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw Object.assign(new Error('超时'), { kind: 'timeout' });
      throw Object.assign(new Error('网络/CORS'), { kind: 'network' });
    }
    clearTimeout(timer);
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (e) {}
      const kind = res.status === 401 ? 'auth' : (res.status === 404 ? 'url' : 'api');
      throw Object.assign(new Error('HTTP ' + res.status + (detail ? '：' + detail : '')), { kind: kind, status: res.status });
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw Object.assign(new Error('空回复'), { kind: 'api' });
    return String(text);
  }

  function errorText(e) {
    switch (e.kind) {
      case 'config': return '还没填接口地址';
      case 'timeout': return '请求超时（15 秒无响应）';
      case 'network': return '连接失败——常见原因：接口不支持浏览器跨域(CORS)、地址写错、或网络不通';
      case 'auth': return 'API Key 无效或未授权（401）';
      case 'url': return '接口地址不对（404），检查是否少了 /v1';
      default: return e.message || '请求失败';
    }
  }

  // ───────── 回复解析与清洗 ─────────
  function parseReply(raw) {
    let memBlock = null;
    const memMatch = raw.match(/<mem>([\s\S]*?)<\/mem>/i);
    if (memMatch) {
      memBlock = memMatch[1];
      raw = raw.replace(/<mem>[\s\S]*?<\/mem>/gi, '');
    }
    raw = raw.replace(/<\/?(mem|think|thinking)>/gi, '');
    let parts = raw.split(/\|\|/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 1 && /\n/.test(parts[0]) && parts[0].length > 45) {
      parts = parts[0].split(/\n+/).map(s => s.trim()).filter(Boolean);
    }
    parts = parts.map(cleanBubble).filter(Boolean).slice(0, 4);
    return { parts: parts, memBlock: memBlock };
  }

  function cleanBubble(s) {
    s = String(s || '').trim();
    if (!s) return '';
    s = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
    s = s.replace(/^#{1,6}\s*/gm, '');
    s = s.replace(/^[-•*]\s+/gm, '');
    s = s.replace(/^["“](.*)["”]$/, '$1');
    // 半角括号包中文动作 → 全角
    s = s.replace(/\(([^()]*[\u4e00-\u9fa5][^()]*)\)/g, '（$1）');
    // 括号配平
    const open = (s.match(/（/g) || []).length;
    const close = (s.match(/）/g) || []).length;
    if (open > close) s = s + '）'.repeat(open - close);
    if (close > open) s = '（'.repeat(close - open) + s;
    // 嵌套括号展平
    s = s.replace(/（[^（）]*（/g, '（').replace(/）[^（）]*）/g, '）');
    if (s.length > 90) s = s.slice(0, 88) + '…';
    return s.trim();
  }

  // ───────── 发送一条对方消息（与拼音模式同一套通道）─────────
  function sendPartnerMsg(text) {
    addMessage({
      id: Date.now() + Math.random(),
      sender: settings.partnerName || '对方',
      text: text,
      timestamp: new Date(),
      status: 'received',
      favorited: false,
      note: null,
      replyTo: null,
      type: 'normal',
      aiMode: true
    });
    playSound('message');
    if (typeof window._sendPartnerNotification === 'function') {
      window._sendPartnerNotification(settings.partnerName || '对方', text);
    }
  }

  function showTyping() {
    if (!settings.typingIndicatorEnabled) return;
    const tiWrapper = $('typing-indicator-wrapper');
    const tiLabel = $('typing-indicator-label');
    const tiAvatar = $('typing-indicator-avatar');
    if (tiLabel) tiLabel.textContent = (settings.partnerName || '对方') + ' 正在输入';
    if (tiWrapper) {
      if (typeof positionTypingIndicator === 'function') positionTypingIndicator();
      tiWrapper.style.display = 'block';
    }
    if (tiAvatar) {
      let img = null;
      try { img = DOMElements.partner.avatar.querySelector('img'); } catch (e) {}
      tiAvatar.innerHTML = img ? '<img src="' + img.src + '">' : '<i class="fas fa-user"></i>';
    }
    if (DOMElements.chatContainer) DOMElements.chatContainer.scrollTop = DOMElements.chatContainer.scrollHeight;
  }
  function hideTyping() {
    try {
      if (window._typingIndicatorAutoHideTimer) { clearTimeout(window._typingIndicatorAutoHideTimer); window._typingIndicatorAutoHideTimer = null; }
    } catch (e) {}
    const tiWrapper = $('typing-indicator-wrapper');
    if (!tiWrapper) return;
    const inner = tiWrapper.querySelector('.typing-indicator');
    if (inner) tiWrapper.style.display = 'none';
  }

  // ───────── 主流程：AI 模式的一轮回复 ─────────
  function lastUserText() {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender === 'user' && messages[i].text) return messages[i].text;
    }
    return '';
  }

  function handleReply() {
    // 模式切换检测：从其他模式进来 → 本场开始，窗口清零
    if (lastTrackedMode !== 'ai') {
      sessionWindow = [];
      lastTrackedMode = 'ai';
    }
    if (aiBusy) { pendingHandle = true; return; }
    if (!apiCfg.baseURL || !apiCfg.model || !apiCfg.apiKey) {
      showNotification('AI 模式未配置：请到 聊天设置 → AI 对话 填写接口地址、模型名和 Key', 'info', 4000);
      return;
    }
    const userNow = lastUserText();
    if (!userNow) return;

    aiBusy = true;
    showTyping();

    const memLines = retrieveMemory(userNow);
    const sys = buildSystemPrompt(memLines);
    const convo = sessionWindow.slice(-(WINDOW_ROUNDS * 2)).map(m => ({ role: m.role, content: m.content }));
    convo.push({ role: 'user', content: userNow });

    callLLM([{ role: 'system', content: sys }].concat(convo), { max_tokens: 420 })
      .then(raw => {
        const { parts, memBlock } = parseReply(raw);
        if (memBlock) applyMemBlock(memBlock);
        hideTyping();
        if (!parts.length) {
          showNotification('对方没说出话来，再试一句吧', 'info', 2500);
          return;
        }
        // 本场窗口滚动（原文只在本场内存中使用，不落盘、不进备份）
        sessionWindow.push({ role: 'user', content: userNow });
        let delay = 0;
        parts.forEach((t, i) => {
          delay += i === 0 ? 0 : 700 + randInt(1600);
          setTimeout(() => {
            try { sendPartnerMsg(t); } catch (e) { console.error('[ai] 发送失败', e); }
          }, delay);
        });
        sessionWindow.push({ role: 'assistant', content: parts.join(' || ') });
        if (sessionWindow.length > 40) sessionWindow = sessionWindow.slice(-40);
      })
      .catch(e => {
        hideTyping();
        showNotification('AI 没能回复：' + errorText(e), 'error', 5000);
      })
      .then(() => {
        aiBusy = false;
        if (pendingHandle) {
          pendingHandle = false;
          setTimeout(() => { if (currentMode() === 'ai' && !aiBusy) handleReply(); }, 300);
        }
      });
  }

  // ───────── 测试连接 ─────────
  function testConnection() {
    if (!endpoint() || !apiCfg.model || !apiCfg.apiKey) {
      setAiStatus('请先填好接口地址、模型名和 Key', 'err');
      return;
    }
    setAiStatus('正在连接…', '');
    callLLM([{ role: 'user', content: '回复两个字：收到' }], { max_tokens: 8, temperature: 0.1, timeout: 12000 })
      .then(() => setAiStatus('✓ 连接成功', 'ok'))
      .catch(e => setAiStatus('✗ ' + errorText(e), 'err'));
  }

  // ───────── 历史回灌 ─────────
  function collectHistoryBatches(batchSize) {
    const texts = [];
    (typeof messages !== 'undefined' ? messages : []).forEach(m => {
      if (m.type !== 'normal' || !m.text) return;
      const who = m.sender === 'user' ? '我' : '对方';
      texts.push(who + '：' + String(m.text).slice(0, 200));
    });
    const batches = [];
    for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
    return batches;
  }

  async function backfillFromHistory() {
    if (!endpoint() || !apiCfg.model || !apiCfg.apiKey) { setAiStatus('先填好接口配置再回灌', 'err'); return; }
    const batches = collectHistoryBatches(100);
    if (!batches.length) { setAiStatus('当前会话没有可提炼的聊天记录', 'err'); return; }
    backfillAbort = false;
    let added = 0;
    for (let i = 0; i < batches.length; i++) {
      if (backfillAbort) { setAiStatus('已中断（已写入 ' + added + ' 条）', 'err'); return; }
      setAiStatus('提炼记忆中… 第 ' + (i + 1) + '/' + batches.length + ' 批', '');
      const sys = '你是记忆提炼器。从聊天记录中提炼值得长期记住的信息。规则：\n' +
        '- 重点记「我」这边的事实、偏好、事件、约定；「对方」的话只记事件性内容，绝不推断对方的性格或喜好。\n' +
        '- 每行输出一条，格式：类型|内容|权重。类型只能是 事实/事件/偏好/约定。权重 1~3（越重要越高）。\n' +
        '- 只输出行，不要解释。没有值得记的就只输出一个字：无。';
      const user = '以下是第 ' + (i + 1) + ' 批聊天记录：\n' + batches[i].join('\n');
      try {
        const out = await callLLM(
          [{ role: 'system', content: sys }, { role: 'user', content: user }],
          { max_tokens: 500, temperature: 0.3, timeout: 30000 }
        );
        const block = out.trim();
        if (block && !/^无\s*$/.test(block)) applyMemBlock(block);
      } catch (e) {
        setAiStatus('第 ' + (i + 1) + ' 批失败：' + errorText(e) + '，已中断', 'err');
        return;
      }
      added = memory.entries.length;
      renderMemoryList();
    }
    setAiStatus('✓ 回灌完成，记忆库现有 ' + memory.entries.length + ' 条', 'ok');
    renderMemoryList();
  }

  // ───────── UI 注入 ─────────
  function injectSegOption() {
    const seg = $('reply-mode-seg');
    if (!seg || $('reply-mode-opt-ai')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reply-mode-opt';
    btn.id = 'reply-mode-opt-ai';
    btn.dataset.mode = 'ai';
    btn.innerHTML = '<i class="fas fa-robot"></i> AI 对话';
    seg.appendChild(btn);
  }

  const AI_CARD_HTML =
    '<div class="cs-card" id="ai-mode-card" style="display:none;flex-direction:column;gap:8px;">' +
      '<div class="ai-row"><label>接口地址</label><input id="ai-base-url" type="text" placeholder="https://api.deepseek.com/v1"></div>' +
      '<div class="ai-row"><label>模型名</label><input id="ai-model" type="text" placeholder="deepseek-chat"></div>' +
      '<div class="ai-row"><label>API Key</label><div class="ai-key-wrap"><input id="ai-key" type="password" placeholder="sk-…"><span id="ai-key-mask" class="ai-key-mask"></span><button type="button" id="ai-key-clear" title="清除 Key">×</button></div></div>' +
      '<div class="ai-actions">' +
        '<button type="button" id="ai-test-btn"><i class="fas fa-plug"></i> 测试连接</button>' +
        '<button type="button" id="ai-persona-btn"><i class="fas fa-user-pen"></i> 编辑人设</button>' +
        '<button type="button" id="ai-memory-btn"><i class="fas fa-brain"></i> 记忆库 <span id="ai-mem-count"></span></button>' +
        '<button type="button" id="ai-backfill-btn"><i class="fas fa-database"></i> 从历史生成记忆</button>' +
      '</div>' +
      '<p class="ai-status" id="ai-status"></p>' +
      '<p class="ai-hint">仅 AI 模式会调用接口，字卡与拼音模式零 AI 参与。每次进入 AI 模式从你的新话题开始，之前话题不延续；记忆持续保留。Key 只存本机、不进备份。</p>' +
    '</div>';

  function injectSettingsCard() {
    if ($('ai-mode-card')) return;
    const seg = $('reply-mode-seg');
    if (!seg || !seg.parentElement) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = AI_CARD_HTML;
    const card = wrap.firstElementChild;
    // 插在分段控件所在卡片之后
    const segCard = seg.closest('.cs-card');
    if (segCard && segCard.nextElementSibling) segCard.parentElement.insertBefore(card, segCard.nextElementSibling);
    else if (segCard) segCard.parentElement.appendChild(card);
    else seg.parentElement.appendChild(card);
  }

  const PERSONA_MODAL_HTML =
    '<div class="modal" id="ai-persona-modal">' +
      '<div class="modal-content ai-modal-content">' +
        '<h3 class="modal-title">对方人设</h3>' +
        '<p class="ai-form-hint">「示例对话」效果最好：写 2~3 组一问一答，模型模仿语气远强于理解形容词。</p>' +
        '<div class="ai-form">' +
          '<label>名字</label><input id="ap-name" type="text" placeholder="留空则用顶栏名字">' +
          '<label>身份关系</label><input id="ap-identity" type="text" placeholder="如：大学同学，现在在杭州">' +
          '<label>性格</label><input id="ap-personality" type="text" placeholder="如：慢热，嘴硬，会照顾人">' +
          '<label>说话风格</label><textarea id="ap-style" rows="2" placeholder="如：短句，很少用句号，常留「…」，不说教"></textarea>' +
          '<label>背景与经历</label><textarea id="ap-background" rows="3" placeholder="自由发挥"></textarea>' +
          '<label>禁区（绝不会做的事）</label><textarea id="ap-taboos" rows="2" placeholder="如：不说教，不问工作，不自称 AI"></textarea>' +
          '<label>示例对话</label><textarea id="ap-examples" rows="4" placeholder="我：今天好累&#10;她：那就别做饭了&#10;她：点个外卖吧，我给你挑"></textarea>' +
        '</div>' +
        '<div class="modal-actions"><button type="button" class="btn-secondary" id="ap-cancel">取消</button><button type="button" class="btn-primary" id="ap-save">保存</button></div>' +
      '</div>' +
    '</div>';

  const MEMORY_MODAL_HTML =
    '<div class="modal" id="ai-memory-modal">' +
      '<div class="modal-content ai-modal-content">' +
        '<h3 class="modal-title">记忆库 <span id="am-count" class="ai-mem-title-count"></span></h3>' +
        '<div class="ai-mem-toolbar"><button type="button" id="am-clear" class="ai-btn-danger">清空全部</button></div>' +
        '<div class="ai-mem-list" id="am-list"></div>' +
        '<div class="modal-actions"><button type="button" class="btn-secondary" id="am-close">关闭</button></div>' +
      '</div>' +
    '</div>';

  function injectModals() {
    if (!$('ai-persona-modal')) document.body.insertAdjacentHTML('beforeend', PERSONA_MODAL_HTML);
    if (!$('ai-memory-modal')) document.body.insertAdjacentHTML('beforeend', MEMORY_MODAL_HTML);
  }

  // ───────── 人设弹层逻辑 ─────────
  function openPersona() {
    const p = persona || {};
    $('ap-name').value = p.name || '';
    $('ap-identity').value = p.identity || '';
    $('ap-personality').value = p.personality || '';
    $('ap-style').value = p.style || '';
    $('ap-background').value = p.background || '';
    $('ap-taboos').value = p.taboos || '';
    $('ap-examples').value = p.examples || '';
    if (typeof showModal === 'function') showModal($('ai-persona-modal'));
    else $('ai-persona-modal').style.display = 'flex';
  }
  function savePersona() {
    persona = {
      name: $('ap-name').value.trim(),
      identity: $('ap-identity').value.trim(),
      personality: $('ap-personality').value.trim(),
      style: $('ap-style').value.trim(),
      background: $('ap-background').value.trim(),
      taboos: $('ap-taboos').value.trim(),
      examples: $('ap-examples').value.trim()
    };
    try { localforage.setItem(getStorageKey(PERSONA_KEY), persona); } catch (e) {}
    hideModalById('ai-persona-modal');
    showNotification('人设已保存', 'success', 2000);
  }

  // ───────── 记忆弹层逻辑 ─────────
  function renderMemoryList() {
    const list = $('am-list');
    if (!list) return;
    const cnt = $('am-count');
    if (cnt) cnt.textContent = memory.entries.length ? '（' + memory.entries.length + ' 条）' : '（空）';
    const badge = $('ai-mem-count');
    if (badge) badge.textContent = memory.entries.length ? '(' + memory.entries.length + ')' : '';
    if (!memory.entries.length) {
      list.innerHTML = '<p class="ai-mem-empty">还没有记忆。聊天会自动积累，也可以点「从历史生成记忆」把字卡聊天记录炼成记忆。</p>';
      return;
    }
    const sorted = memory.entries.slice().sort((a, b) => (b.lastHitAt || b.createdAt) - (a.lastHitAt || a.createdAt));
    list.innerHTML = sorted.map(m =>
      '<div class="ai-mem-item" data-id="' + esc(m.id) + '">' +
        '<span class="ai-mem-type t' + MEM_TYPES.indexOf(m.type) + '">' + esc(m.type) + '</span>' +
        '<span class="ai-mem-text">' + esc(m.text) + '</span>' +
        '<span class="ai-mem-w">w' + (m.weight || 1) + '</span>' +
        '<button type="button" class="ai-mem-del" data-id="' + esc(m.id) + '" title="删除"><i class="fas fa-xmark"></i></button>' +
      '</div>'
    ).join('');
    list.querySelectorAll('.ai-mem-del').forEach(btn => {
      btn.addEventListener('click', () => {
        memory.entries = memory.entries.filter(m => m.id !== btn.dataset.id);
        saveMemorySoon(); renderMemoryList();
      });
    });
  }
  function openMemory() { renderMemoryList(); showModalById('ai-memory-modal'); }

  function showModalById(id) {
    const m = $(id);
    if (!m) return;
    if (typeof showModal === 'function') showModal(m); else m.style.display = 'flex';
  }
  function hideModalById(id) {
    const m = $(id);
    if (!m) return;
    if (typeof hideModal === 'function') hideModal(m); else m.style.display = 'none';
  }

  // ───────── 设置卡片输入同步 ─────────
  function syncCardFromCfg() {
    if (!$('ai-base-url')) return;
    $('ai-base-url').value = apiCfg.baseURL || '';
    $('ai-model').value = apiCfg.model || '';
    $('ai-key').value = apiCfg.apiKey || '';
    updateKeyMask();
  }
  function updateKeyMask() {
    const mask = $('ai-key-mask');
    if (!mask) return;
    const k = apiCfg.apiKey || '';
    mask.textContent = k ? ('已保存 …' + k.slice(-4)) : '';
  }
  function setAiStatus(text, cls) {
    const el = $('ai-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'ai-status' + (cls ? ' ' + cls : '');
  }

  function bindUI() {
    injectSegOption();
    injectSettingsCard();
    injectModals();

    // 分段控件委托：第三项（AI）由本模块负责切换（listeners.js 绑定时第三项尚未注入）；
    // 对前两项幂等——若 listeners.js 已处理过，此处直接跳过。
    const seg = $('reply-mode-seg');
    if (seg) {
      seg.addEventListener('click', e => {
        const btn = e.target.closest('.reply-mode-opt');
        if (!btn) return;
        if (currentMode() === btn.dataset.mode) { updateCardVisibility(); return; }
        if (btn.dataset.mode === 'ai') {
          settings.replyMode = 'ai';
          settings.pinyinTypingEnabled = false;
          throttledSaveData();
          if (typeof window.updateReplyModeSeg === 'function') window.updateReplyModeSeg();
          showNotification('已切换到 AI 对话模式', 'success');
        }
        updateCardVisibility();
      });
    }
    // 通用兜底：每次打开聊天设置也刷一次显隐
    const chatSettingsBtn = $('chat-settings');
    if (chatSettingsBtn) chatSettingsBtn.addEventListener('click', updateCardVisibility);

    const card = $('ai-mode-card');
    if (card) {
      $('ai-base-url').addEventListener('change', () => { apiCfg.baseURL = $('ai-base-url').value.trim(); saveApiCfg(); });
      $('ai-model').addEventListener('change', () => { apiCfg.model = $('ai-model').value.trim(); saveApiCfg(); });
      $('ai-key').addEventListener('input', () => { apiCfg.apiKey = $('ai-key').value.trim(); saveApiCfg(); updateKeyMask(); });
      $('ai-key-clear').addEventListener('click', () => {
        apiCfg.apiKey = ''; saveApiCfg(); $('ai-key').value = ''; updateKeyMask();
        setAiStatus('已清除本机保存的 Key', '');
      });
      $('ai-test-btn').addEventListener('click', testConnection);
      $('ai-persona-btn').addEventListener('click', openPersona);
      $('ai-memory-btn').addEventListener('click', openMemory);
      $('ai-backfill-btn').addEventListener('click', () => {
        if (!backfillAbort && backfillRunning) { backfillAbort = true; setAiStatus('正在中断…', ''); return; }
        backfillFromHistory();
      });
    }

    const pm = $('ai-persona-modal');
    if (pm) {
      $('ap-save').addEventListener('click', savePersona);
      $('ap-cancel').addEventListener('click', () => hideModalById('ai-persona-modal'));
    }
    const mm = $('ai-memory-modal');
    if (mm) {
      $('am-close').addEventListener('click', () => hideModalById('ai-memory-modal'));
      $('am-clear').addEventListener('click', () => {
        memory.entries = []; saveMemorySoon(); renderMemoryList();
        showNotification('记忆库已清空', 'success', 2000);
      });
    }
    updateCardVisibility();
    updateMemBadge();
  }

  let backfillRunning = false;
  const _origBackfill = backfillFromHistory;
  backfillFromHistory = async function () {
    backfillRunning = true;
    $('ai-backfill-btn').innerHTML = '<i class="fas fa-stop"></i> 停止回灌';
    try { await _origBackfill(); }
    finally { backfillRunning = false; $('ai-backfill-btn').innerHTML = '<i class="fas fa-database"></i> 从历史生成记忆'; }
  };

  function updateCardVisibility() {
    const card = $('ai-mode-card');
    if (card) card.style.display = currentMode() === 'ai' ? 'flex' : 'none';
  }
  function updateMemBadge() {
    const badge = $('ai-mem-count');
    if (badge) badge.textContent = memory.entries.length ? '(' + memory.entries.length + ')' : '';
  }

  // ───────── 启动：等 settings 就绪后加载持久数据并绑定 UI ─────────
  function waitSettingsReady(cb) {
    if (typeof settings !== 'undefined' && settings && settings.partnerName !== undefined) return cb();
    setTimeout(() => waitSettingsReady(cb), 100);
  }

  function init() {
    loadApiCfg();
    waitSettingsReady(() => {
      loadPersona().then(() => loadMemory()).then(() => {
        bindUI();
        // 首次使用给一个空人设骨架，方便直接编辑
        if (!persona) persona = {};
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ───────── 导出 ─────────
  window.AIChat = {
    handleReply: handleReply,
    noteMode: noteMode,
    currentMode: currentMode,
    memorySize: () => memory.entries.length,
    persona: () => persona,
    openPersona: openPersona,
    openMemory: openMemory
  };
})();
