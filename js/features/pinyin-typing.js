/**
 * pinyin-typing.js — 拼音打字模式
 *
 * 独立于「字卡回复」的另一套对方输出方式：
 *  - 不读取字卡库，从内置音节池随机取拼音音节
 *  - 像 26 键键盘一样逐键敲字母，允许错键、允许打到一半就发出去
 *  - 发送时按「最长音节匹配」上屏：命中的转汉字，没命中的原样保留字母
 *    例：w o x  →  「我x」；n i h a p o → 「你哈p哦」
 *
 * 由 simulateReply 在字卡逻辑之前分流调用：window.PinyinTyping.runTurn()
 */
(function () {
  'use strict';

  // ── 内置音节表：音节 → 高频字（第一个为最常用，取字时优先） ──
  const RAW =
    'a:啊阿|ai:爱哎|an:安按暗|ang:昂|ao:傲熬|' +
    'ba:吧把八爸|bai:白百拜摆|ban:半班办板|bang:帮棒邦|bao:宝抱报饱|bei:被北背杯|ben:本笨奔|beng:蹦崩|bi:比必笔闭|bian:边变便遍|biao:表标|bie:别憋|bin:宾滨|bing:病冰并饼|bo:波播博|bu:不步部补|' +
    'ca:擦|cai:才菜猜彩|can:惨参|cang:藏苍|cao:草操|ce:测侧册|ceng:层曾|cha:查差茶插|chai:拆柴|chan:产馋|chang:长常唱场|chao:超吵炒|che:车扯彻|chen:沉陈晨|cheng:成城称程|chi:吃迟池翅|chong:冲充|chou:抽丑愁|chu:出除初楚|chuai:揣|chuan:穿传船|chuang:床窗创|chui:吹垂|chun:春纯|chuo:戳|ci:次词此刺|cong:从聪葱|cou:凑|cu:粗醋促|cuan:窜|cui:催脆翠|cun:存村寸|cuo:错搓措|' +
    'da:大打答达|dai:带待呆代|dan:但单蛋淡|dang:当挡党|dao:到道倒刀|de:的得德|dei:得|deng:等灯登|di:地第低底|dian:点电店典|diao:掉调钓|die:跌爹叠|ding:定顶订丁|diu:丢|dong:动东懂冬|dou:都豆斗|du:读度独堵|duan:段短断端|dui:对队堆|dun:顿蹲盾|duo:多躲朵夺|' +
    'e:饿额恶鹅|ei:诶|en:嗯恩|er:二而儿耳|' +
    'fa:发法罚|fan:反饭烦犯|fang:放房方仿|fei:飞非费肥|fen:分粉份奋|feng:风封疯峰|fo:佛|fou:否|fu:服父复副|' +
    'ga:嘎|gai:该改盖|gan:干敢赶感|gang:刚钢岗|gao:高搞告糕|ge:个各哥歌|gei:给|gen:跟根|geng:更耕|gong:工公共功|gou:够狗沟构|gu:故古顾股|gua:挂瓜刮|guai:怪拐|guan:关管观官|guang:光广逛|gui:贵鬼归柜|gun:滚棍|guo:过国果锅|' +
    'ha:哈|hai:还海害孩|han:喊汉寒汗|hang:行航|hao:好号浩毫|he:和喝合河|hei:黑嘿|hen:很恨狠|heng:横哼|hong:红洪哄|hou:后吼厚候|hu:呼湖糊户|hua:话花画华|huai:坏怀|huan:换还缓欢|huang:黄慌荒皇|hui:会回灰挥|hun:混昏婚|huo:活火或货|' +
    'ji:几机急记|jia:家假加价|jian:见件简间|jiang:讲将江降|jiao:叫觉教交|jie:接姐解街|jin:今进紧近|jing:经静惊竟|jiong:窘|jiu:就九久酒|ju:局举句聚|juan:卷捐倦|jue:觉决绝|jun:军君均|' +
    'ka:卡咖|kai:开凯|kan:看砍刊|kang:抗康扛|kao:靠考烤|ke:可课克刻|ken:肯啃|keng:坑|kong:空控恐|kou:口扣抠|ku:苦哭库酷|kua:跨夸|kuai:快块筷|kuan:宽款|kuang:狂矿框|kui:亏愧|kun:困昆|kuo:阔扩|' +
    'la:啦拉辣蜡|lai:来赖|lan:蓝懒烂拦|lang:浪狼郎|lao:老劳唠|le:了乐|lei:累泪雷类|leng:冷愣|li:里离丽理|lian:连脸练恋|liang:两亮量凉|liao:聊料辽|lie:列裂劣|lin:林临淋|ling:另零领灵|liu:六留流溜|long:龙弄隆|lou:楼漏搂|lu:路露陆鹿|luan:乱卵|lun:论轮伦|luo:落罗逻|lv:绿旅律|lve:略掠|' +
    'ma:吗妈马骂|mai:买卖麦迈|man:满慢蛮漫|mang:忙盲芒|mao:猫毛冒帽|me:么|mei:没每美妹|men:们门闷|meng:梦猛蒙|mi:迷米密蜜|mian:面免棉眠|miao:秒妙苗|mie:灭咩|min:民敏|ming:名明命鸣|miu:谬|mo:摸莫末魔|mou:某谋|mu:木目母幕|' +
    'na:那拿哪纳|nai:奶耐乃|nan:难男南|nang:囊|nao:闹脑恼|ne:呢|nei:内|nen:嫩|neng:能|ni:你泥逆腻|nian:年念粘|niang:娘酿|niao:鸟尿|nie:捏聂|nin:您|ning:宁凝拧|niu:牛扭钮|nong:农弄浓|nu:努怒奴|nuan:暖|nuo:诺挪|nv:女|nve:虐|' +
    'o:哦噢|ou:偶欧呕|' +
    'pa:怕爬趴|pai:拍排派|pan:判盘盼攀|pang:旁胖庞|pao:跑泡炮抛|pei:陪配赔培|pen:喷盆|peng:朋碰捧棚|pi:皮屁批疲|pian:片骗偏篇|piao:飘票漂|pie:撇|pin:拼品贫聘|ping:平瓶评凭|po:破婆坡迫|pou:剖|pu:铺扑普谱|' +
    'qi:起气其七|qia:恰掐|qian:前钱千浅|qiang:强墙抢枪|qiao:瞧桥巧敲|qie:且切窃|qin:亲琴勤侵|qing:请情青清|qiong:穷琼|qiu:球求秋囚|qu:去取区曲|quan:全权圈劝|que:却缺确雀|qun:群裙|' +
    'ran:然染燃|rang:让嚷|rao:绕饶扰|re:热惹|ren:人认忍任|reng:扔仍|ri:日|rong:容荣融绒|rou:肉柔揉|ru:如入乳|ruan:软阮|rui:瑞锐|run:润|ruo:若弱|' +
    'sa:撒洒萨|sai:塞赛腮|san:三散伞|sang:桑嗓|sao:扫嫂骚|se:色涩|sen:森|seng:僧|sha:傻沙杀啥|shai:晒筛|shan:山闪善扇|shang:上伤商尚|shao:少烧稍哨|she:设社蛇舍|shei:谁|shen:什身深神|sheng:生声胜剩|shi:是时事十|shou:手收受守|shu:书数树叔|shua:刷耍|shuai:帅摔甩|shuan:拴|shuang:双爽霜|shui:水睡税|shun:顺瞬|shuo:说硕|si:死四思私|song:送松宋耸|sou:搜艘|su:素苏速诉|suan:算酸蒜|sui:岁随碎虽|sun:孙损笋|suo:所锁缩索|' +
    'ta:他她它塔|tai:太台抬态|tan:谈摊探毯|tang:躺糖汤唐|tao:套逃掏桃|te:特|teng:疼藤腾|ti:题体替提|tian:天甜填田|tiao:跳条挑|tie:铁贴帖|ting:听停挺厅|tong:同通痛桶|tou:头偷透投|tu:图土突兔|tuan:团|tui:推腿退|tun:吞屯|tuo:拖脱托妥|' +
    'wa:哇挖娃瓦|wai:外歪|wan:玩完晚万|wang:王忘网往|wei:为位未胃|wen:问文稳温|weng:翁嗡|wo:我窝握卧|wu:无五屋午|' +
    'xi:喜洗系西|xia:下吓夏虾|xian:先现线显|xiang:想向相香|xiao:小笑校晓|xie:写谢些鞋|xin:心新信欣|xing:行星醒性|xiong:熊胸兄|xiu:休修秀袖|xu:需许续徐|xuan:选悬宣旋|xue:学雪血穴|xun:寻训迅巡|' +
    'ya:呀压牙鸭|yan:眼烟严演|yang:样养阳洋|yao:要药摇咬|ye:也夜爷叶|yi:一已以意|yin:因音银印|ying:应硬影赢|yo:哟|yong:用永勇拥|you:有又右油|yu:于鱼语遇|yuan:远元原院|yue:月越约悦|yun:云运晕允|' +
    'za:咋砸杂|zai:在再灾|zan:咱赞|zang:脏葬|zao:早造遭|ze:则责泽|zei:贼|zen:怎|zeng:增赠|zha:炸眨渣扎|zhai:摘窄宅债|zhan:站占展战|zhang:张长章涨|zhao:找照招赵|zhe:这着者折|zhei:这|zhen:真针阵镇|zheng:正整争证|zhi:只知值直|zhong:中种重终|zhou:周州皱轴|zhu:住主猪竹|zhua:抓爪|zhuai:拽|zhuan:专转赚砖|zhuang:装撞壮庄|zhui:追坠|zhun:准|zhuo:桌捉卓|' +
    'zi:子自字紫|zong:总宗纵|zou:走揍奏|zu:组足祖租|zuan:钻|zui:最嘴醉罪|zun:尊遵|zuo:做作坐左';

  const SYL_CHARS = Object.create(null);   // 音节 → 字数组
  const SYLLABLES = [];                    // 全部音节

  RAW.split('|').forEach(function (part) {
    const sep = part.indexOf(':');
    if (sep < 0) return;
    const syl = part.slice(0, sep).trim();
    const chars = Array.from(part.slice(sep + 1).trim());
    if (!syl || !chars.length) return;
    if (SYL_CHARS[syl]) return;
    SYL_CHARS[syl] = chars;
    SYLLABLES.push(syl);
  });

  const MAX_SYL_LEN = 6;
  const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

  function randInt(n) { return Math.floor(Math.random() * n); }
  function pick(arr) { return arr[randInt(arr.length)]; }

  // ── 取字：第一个字是高频字，给它更高权重 ──
  function pickChar(syl) {
    const chars = SYL_CHARS[syl];
    if (!chars) return '';
    if (chars.length > 1 && Math.random() < 0.6) return chars[0];
    return pick(chars);
  }

  // ── 最长音节匹配上屏 ──
  // 返回 { text, hasLetters, raw }
  function parseBuffer(buf) {
    const src = String(buf || '').toLowerCase();
    let i = 0;
    let text = '';
    let hasLetters = false;
    while (i < src.length) {
      let matched = null;
      const maxLen = Math.min(MAX_SYL_LEN, src.length - i);
      for (let len = maxLen; len >= 1; len--) {
        const seg = src.slice(i, i + len);
        if (SYL_CHARS[seg]) { matched = seg; break; }
      }
      if (matched) {
        text += pickChar(matched);
        i += matched.length;
      } else {
        text += src[i];
        hasLetters = true;
        i += 1;
      }
    }
    return { text: text, hasLetters: hasLetters, raw: src };
  }

  // ── 错键：同排相邻键 ──
  function neighborKey(ch) {
    for (let r = 0; r < KEY_ROWS.length; r++) {
      const row = KEY_ROWS[r];
      const idx = row.indexOf(ch);
      if (idx === -1) continue;
      const dir = Math.random() < 0.5 ? -1 : 1;
      let ni = idx + dir;
      if (ni < 0 || ni >= row.length) ni = idx - dir;
      return row[ni] || ch;
    }
    return ch;
  }

  // ── 音节数量：偏短，像随手打一句 ──
  function pickSyllableCount() {
    const r = Math.random();
    if (r < 0.10) return 1;
    if (r < 0.32) return 2;
    if (r < 0.60) return 3;
    if (r < 0.80) return 4;
    if (r < 0.93) return 5;
    return 6;
  }

  // ── 生成一次「键盘缓冲区」内容 ──
  function buildBuffer() {
    // 偶尔完全没有成字，纯字母乱敲
    if (Math.random() < 0.09) {
      const len = 2 + randInt(5);
      let s = '';
      for (let i = 0; i < len; i++) s += ALPHABET[randInt(26)];
      return s;
    }

    const count = pickSyllableCount();
    let keys = '';
    const boundaries = [];
    for (let i = 0; i < count; i++) {
      keys += pick(SYLLABLES);
      boundaries.push(keys.length);
    }

    // 发送时机：多数在音节边界停手（整串都能成字），少数打到一半就发（留半截字母）
    let cut = pick(boundaries);
    if (keys.length >= 6 && Math.random() < 0.34) {
      const cands = [];
      for (let i = 0; i < boundaries.length; i++) {
        const start = i === 0 ? 0 : boundaries[i - 1];
        const end = boundaries[i];
        if (start >= 2 && end - start >= 2) cands.push({ start: start, end: end });
      }
      if (cands.length) {
        const seg = pick(cands);
        cut = seg.start + 1 + randInt(seg.end - seg.start - 1);
      }
    }
    cut = Math.max(1, Math.min(cut, keys.length));

    // 错键：把末尾附近的一个字母按成同排相邻键
    if (Math.random() < 0.22 && cut >= 3) {
      const pos = cut - 1 - randInt(Math.min(3, cut - 1));
      keys = keys.slice(0, pos) + neighborKey(keys.charAt(pos)) + keys.slice(pos + 1);
    }

    return keys.slice(0, cut);
  }

  // ── 一轮回复发几条 ──
  function pickTurnCount() {
    const r = Math.random();
    if (r < 0.62) return 1;
    if (r < 0.88) return 2;
    return 3;
  }

  // ── 正在输入指示器（与字卡通道表现一致） ──
  function showTyping() {
    if (!settings.typingIndicatorEnabled) return;
    const tiWrapper = document.getElementById('typing-indicator-wrapper');
    const tiLabel = document.getElementById('typing-indicator-label');
    const tiAvatar = document.getElementById('typing-indicator-avatar');
    if (tiLabel) tiLabel.textContent = (settings.partnerName || '对方') + ' 正在输入';
    if (tiWrapper) {
      if (typeof positionTypingIndicator === 'function') positionTypingIndicator();
      tiWrapper.style.display = 'block';
    }
    if (tiAvatar) {
      let partnerImg = null;
      try { partnerImg = DOMElements.partner.avatar.querySelector('img'); } catch (e) {}
      tiAvatar.innerHTML = partnerImg ? '<img src="' + partnerImg.src + '">' : '<i class="fas fa-user"></i>';
    }
    if (DOMElements.chatContainer) {
      DOMElements.chatContainer.scrollTop = DOMElements.chatContainer.scrollHeight;
    }
  }

  function hideTyping() {
    try {
      if (window._typingIndicatorAutoHideTimer) {
        clearTimeout(window._typingIndicatorAutoHideTimer);
        window._typingIndicatorAutoHideTimer = null;
      }
    } catch (e) {}
    const tiWrapper = document.getElementById('typing-indicator-wrapper');
    if (!tiWrapper) return;
    const inner = tiWrapper.querySelector('.typing-indicator');
    if (inner) {
      inner.classList.add('hiding');
      setTimeout(function () {
        tiWrapper.style.display = 'none';
        inner.classList.remove('hiding');
      }, 240);
    } else {
      tiWrapper.style.display = 'none';
    }
  }

  function sendOne(item) {
    addMessage({
      id: Date.now() + Math.random(),
      sender: settings.partnerName || '对方',
      text: item.text,
      timestamp: new Date(),
      status: 'received',
      favorited: false,
      note: null,
      replyTo: null,
      type: 'normal',
      pinyinMode: true,
      pinyinLetters: !!item.hasLetters
    });
    playSound('message');
    if (typeof window._sendPartnerNotification === 'function') {
      window._sendPartnerNotification(settings.partnerName || '对方', item.text);
    }
  }

  // ── 一轮完整的拼音打字回复 ──
  function runTurn() {
    const count = pickTurnCount();
    const items = [];
    for (let i = 0; i < count; i++) {
      const buf = buildBuffer();
      if (!buf) continue;
      const parsed = parseBuffer(buf);
      if (!parsed.text) continue;
      items.push(parsed);
    }
    if (!items.length) {
      hideTyping();
      return;
    }

    showTyping();

    let delay = 0;
    items.forEach(function (item, i) {
      // 打字耗时：基础思考 + 每个键 70~125ms
      delay += 480 + Math.random() * 620 + Math.min(item.raw.length, 24) * (70 + Math.random() * 55);
      setTimeout(function () {
        try {
          sendOne(item);
        } catch (e) {
          console.error('[pinyinTyping] 发送失败:', e);
        }
        if (i === items.length - 1) hideTyping();
      }, delay);
    });
  }

  window.PinyinTyping = {
    runTurn: runTurn,
    parseBuffer: parseBuffer,
    buildBuffer: buildBuffer,
    syllableCount: SYLLABLES.length
  };
})();
