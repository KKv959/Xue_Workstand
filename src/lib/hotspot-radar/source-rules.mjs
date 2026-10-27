// 从用户提供的热点雷达源码提取的无副作用解析与编辑规则。网络、模型和存储由 TypeScript 调用层负责。
const THREE_DAYS_MS = 72 * 60 * 60 * 1000;



function coarseFilter(signals) {
  const popular = /英雄联盟|league of legends|lol\b|cs2|counter-strike|valorant|无畏契约|王者荣耀|逆水寒|米哈游|原神|崩坏|星穹铁道|恋与深空|叠纸|乙游|二游|任天堂|nintendo|playstation|xbox|steam|gta|怪物猎人|monster hunter|腾讯|网易|faker|t1\b|blg|edg|tes|donk|niko|kojima|小岛秀夫/i;
  const people = /选手|主播|教练|战队|俱乐部|player|streamer|coach|team|creator|director|producer|ceo|明星|夺冠|冠军|转会|退役|回应|道歉/i;
  const conflict = /争议|翻车|离谱|炸裂|逆天|草台班子|乌龙|公关|节奏|差评|投诉|爆冷|惨败|淘汰|封禁|下架|停更|停服|关服|泄露|取消|延迟|故障|漏洞|外挂|抄袭|起诉|罚款|抵制|道歉|controvers|ban\b|banned|lawsuit|delay|cancel|shutdown|outage|leak|cheat|apolog|backlash|upset/i;
  const announcement = /官宣|公布|发布|上线|测试|联动|更新|降价|销量|纪录|announc|release|launch|update|collab|sales|record/i;
  return signals.filter(function(signal) {
    return !isLowValueRoutineSports(signal);
  }).map(function(signal) {
    const text = [signal.title, signal.summary, signal.category].join(' ');
    const hours = signal.publishedAt ? Math.max(0, (Date.now() - dateValue(signal.publishedAt)) / 3600000) : 120;
    let score = Math.max(0, 30 - Math.min(hours, 144) / 6);
    const reasons = [];
    if (signal.sourceId === 'mrs-today') { score += 24; reasons.push('中文人工聚合源'); }
    if (signal.sourceId === 'sample-web-seeds') { score += 30; reasons.push('人工样本反查网页'); }
    if (popular.test(text)) { score += 20; reasons.push('国内玩家有认知'); }
    if (people.test(text)) { score += 18; reasons.push('有人物或赛事主体'); }
    if (conflict.test(text)) { score += 22; reasons.push('存在冲突/反差/舆论点'); }
    if (announcement.test(text)) { score += 9; reasons.push('存在明确事件节点'); }
    if (signal.summary && signal.url) { score += 8; reasons.push('原文素材完整'); }
    if (!/[\u3400-\u9fff]/.test(signal.title || '')) { score -= 8; reasons.push('需翻译和本土化'); }
    if (hours > 96) { score -= 24; reasons.push('时效偏弱'); }
    return Object.assign({}, signal, { coarseScore: Math.max(0, Math.round(score)), coarseReasons: reasons });
  }).filter(function(item) {
    return item.coarseScore >= 34;
  }).sort(function(a, b) {
    return b.coarseScore - a.coarseScore || dateValue(b.publishedAt) - dateValue(a.publishedAt);
  });
}


function isLowValueRoutineSports(item) {
  const text = cleanText([item && item.title, item && item.rawTitle, item && item.summary, item && item.category].filter(Boolean).join(' '));
  const realWorldSports = /世界杯|美加墨|足球国家队|男足|女足|英超|欧冠|西甲|意甲|德甲|法甲|中超|亚冠|NBA|CBA|篮球联赛|网球公开赛|温网|法网|美网|澳网|奥运会|世界锦标赛|F1|一级方程式/i;
  const gamingAnchor = /游戏|电竞|电子竞技|选手|战队|俱乐部|主播|玩家|赛事版本|英雄联盟|league of legends|\blol\b|cs2|counter-strike|valorant|无畏契约|王者荣耀|和平精英|dota|steam|xbox|playstation|switch|任天堂|ea sports|fifa\s*\d|足球经理|实况足球|nba\s*2k/i;
  const storyAnchor = /离谱|荒诞|奇闻|乌龙|争议|冲突|丑闻|反转|翻车|道歉|天价|账单|票价|退钱哥|出轨|恋情|两性|色情|情色|擦边|成人|裸照|裸体|性感|性暗示|onlyfans|porn|sex|nude|scandal|controvers|backlash/i;
  return realWorldSports.test(text) && !gamingAnchor.test(text) && !storyAnchor.test(text);
}


function editorialEventCluster(value) {
  const text = cleanText(value).toLowerCase();
  if (/saber/i.test(text)
    && /(ai|chatgpt|人工智能|编剧|作家|writer|rideshare\s+stimulator)/i.test(text)
    && /(ceo|老板|高管|声明|disclaimer|道歉|apolog|替代|替换|replace|互撕|争议|row|scrap|controvers)/i.test(text)) {
    return 'saber-rideshare-ai-writer-dispute';
  }
  if (/(bside|olivia\s*lin|林離|林离|ai女友|ai陪伴)/i.test(text) && /(停运|停運|停服|停止运营|結束營運|结束运营|离线版|離線版|offline|shutdown)/i.test(text)) return 'bside-olivia-lin-shutdown-offline';
  if (/(异形[：:]?火力小队|aliens?[:：]?\s*fireteam\s*elite)/i.test(text) && /(switch|云版本|雲端版|cloud|停服|下架|不能玩|无法游玩|unplayable|refund|退款)/i.test(text)) return 'aliens-fireteam-elite-switch-cloud-shutdown';
  if (/(战地(?:风云)?\s*6|battlefield\s*6)/i.test(text) && /(rush|突袭|突襲|模式.*删|下架.*模式|mode removal|470\s*小时|470\s*hours|退款|refund)/i.test(text)) return 'battlefield-6-rush-removal-refund';
  if (/(gta\s*6|gta6)/i.test(text) && /(netflix|网飞|網飛)/i.test(text) && /(8000\s*万|80\s*million|\$80m|支付|首播权|首播權)/i.test(text)) return 'gta6-netflix-80m-premiere-rights';
  if (/(gta\s*6|gta6)/i.test(text) && /(netflix|网飞|網飛)/i.test(text) && /(预告|預告|trailer|extended look|前瞻)/i.test(text)) return 'gta6-netflix-trailer-premiere';
  if (/小岛秀夫|hideo kojima/i.test(text) && /电影|电影院|影院|cinema|movie/i.test(text) && /死|去世|临终|death|die/i.test(text)) return 'hideo-kojima-cinema-death-wish';
  if (/(微软|microsoft|xbox)/i.test(text) && /(删号|清空|被盗|blocks? another user|own nothing|game library|onedrive|数字游戏.*归谁)/i.test(text)) return 'microsoft-account-library-deletion';
  if (/(英雄联盟|league of legends|\blol\b)/i.test(text) && /(经典|怀旧|classic|season\s*3|初期環境)/i.test(text)) return 'lol-classic-mode';
  if (/glen schofield/i.test(text) && /(退休|退役|retir)/i.test(text)) return 'glen-schofield-retirement';
  if (/(怪物猎人[：:]?荒野|monster hunter wilds)/i.test(text) && /(永久降价|降价|price cut)/i.test(text)) return 'monster-hunter-wilds-price-cut';
  return '';
}

const SEMANTIC_ENTITY_STOPWORDS = new Set([
  'after', 'before', 'finally', 'about', 'between', 'public', 'latest', 'update',
  'games', 'gaming', 'game', 'steam', 'writer', 'writers', 'chief', 'former',
  'interactive', 'studio', 'company', 'disclaimer', 'apologizes', 'apology',
  'replace', 'replaced', 'using', 'should', 'could', 'would', 'their', 'with'
]);

function semanticEventAnchors(value) {
  const text = cleanText(value).toLowerCase();
  const entities = new Set();
  (text.match(/[a-z][a-z0-9-]{3,}/g) || []).forEach(function(token) {
    if (!SEMANTIC_ENTITY_STOPWORDS.has(token)) entities.add(token);
  });
  [
    ['saber', /\bsaber\b/i],
    ['microsoft', /微软|microsoft/i],
    ['nintendo', /任天堂|nintendo/i],
    ['playstation', /playstation|索尼互动娱乐/i],
    ['ubisoft', /育碧|ubisoft/i],
    ['blizzard', /暴雪|blizzard/i],
    ['tencent', /腾讯|tencent/i],
    ['netease', /网易|netease/i]
  ].forEach(function(entry) {
    if (entry[1].test(text)) entities.add(entry[0]);
  });

  const topics = new Set();
  [
    ['ai', /\bai\b|chatgpt|人工智能|生成式/i],
    ['writer', /编剧|作家|作者|writer|scribe/i],
    ['executive', /ceo|老板|高管|首席执行官/i],
    ['replace', /替代|替换|取代|replace/i],
    ['apology', /道歉|致歉|apolog/i],
    ['disclosure', /声明|披露|标注|disclaimer|disclos/i],
    ['conflict', /互撕|争吵|冲突|争议|嘲讽|row|scrap|controvers|backlash/i],
    ['shutdown', /停运|停服|关服|shutdown|offline/i],
    ['layoff', /裁员|解雇|layoff|laid off|fired/i],
    ['ban', /封禁|封号|禁赛|banned|suspend/i],
    ['price', /涨价|降价|定价|price cut|price increase/i]
  ].forEach(function(entry) {
    if (entry[1].test(text)) topics.add(entry[0]);
  });
  return { entities, topics };
}

function sameSemanticEvent(leftText, rightText, leftDate, rightDate) {
  const at = dateValue(leftDate);
  const bt = dateValue(rightDate);
  if (at && bt && Math.abs(at - bt) > 4 * 86400000) return false;
  const left = semanticEventAnchors(leftText);
  const right = semanticEventAnchors(rightText);
  const hasSharedEntity = Array.from(left.entities).some(function(token) {
    return right.entities.has(token);
  });
  if (!hasSharedEntity) return false;
  const sharedTopicCount = Array.from(left.topics).filter(function(topic) {
    return right.topics.has(topic);
  }).length;
  return sharedTopicCount >= 2;
}

function sameHotspotEvent(left, right) {
  const leftText = [left && left.title, left && left.rawTitle, left && left.summary].filter(Boolean).join(' ');
  const rightText = [right && right.title, right && right.rawTitle, right && right.summary].filter(Boolean).join(' ');
  const leftCluster = editorialEventCluster(leftText);
  const rightCluster = editorialEventCluster(rightText);
  if (leftCluster && leftCluster === rightCluster) return true;
  if (sameSemanticEvent(leftText, rightText, left && left.publishedAt, right && right.publishedAt)) return true;
  const leftTitles = [left && left.title, left && left.rawTitle].filter(Boolean);
  const rightTitles = [right && right.title, right && right.rawTitle].filter(Boolean);
  return leftTitles.some(function(leftTitle) {
    return rightTitles.some(function(rightTitle) {
      return sameEvent(leftTitle, rightTitle, left && left.publishedAt, right && right.publishedAt);
    });
  });
}


function isRecentVerifiedSignal(item) {
  const time = dateValue(item && item.publishedAt);
  if (!time) return false;
  const age = Date.now() - time;
  return age >= -6 * 60 * 60 * 1000 && age <= THREE_DAYS_MS;
}


function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, function(all, token) {
    if (token[0] === '#') {
      const hex = token[1].toLowerCase() === 'x';
      const code = parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return named[token.toLowerCase()] || all;
  });
}

function dateValue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function sameEvent(left, right, leftDate, rightDate) {
  const a = normalizeEventText(left);
  const b = normalizeEventText(right);
  if (!a || !b) return false;
  const at = dateValue(leftDate), bt = dateValue(rightDate);
  if (at && bt && Math.abs(at - bt) > 4 * 86400000) return false;
  if (a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a)))) return true;
  const aTokens = eventTokens(a), bTokens = eventTokens(b);
  const intersection = Array.from(aTokens).filter(function(token) { return bTokens.has(token); }).length;
  const union = new Set(Array.from(aTokens).concat(Array.from(bTokens))).size || 1;
  if (intersection / union >= 0.52) return true;
  const aEntities = eventEntities(a), bEntities = eventEntities(b);
  const sharedEntities = Array.from(aEntities).filter(function(token) { return bEntities.has(token); }).length;
  const sharedEventWord = /冠军|夺冠|问鼎|停更|道歉|取消|降价|处罚|罚款|战胜|击败|不敌|淘汰|签约|加盟/.test(a) && /冠军|夺冠|问鼎|停更|道歉|取消|降价|处罚|罚款|战胜|击败|不敌|淘汰|签约|加盟/.test(b);
  return sharedEntities >= 3 && sharedEventWord;
}

function normalizeEventText(value) {
  return cleanText(value).toLowerCase().replace(/《|》|“|”|「|」|【|】/g, '').replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

function eventTokens(text) {
  const tokens = new Set(text.match(/[a-z0-9]{2,}/g) || []);
  const chinese = text.replace(/[a-z0-9]+/g, '');
  for (let index = 0; index < chinese.length - 1; index += 1) tokens.add(chinese.slice(index, index + 2));
  return tokens;
}

function eventEntities(text) {
  const entities = new Set(text.match(/[a-z]+\d*|\d+[a-z]+|\d{4}/g) || []);
  const known = ['广州', '恋与深空', '怪物猎人', '深空之眼', '英雄联盟', '无畏契约', '王者荣耀', '米哈游', '叠纸', '天禄', '小蜜蜂', '刘青松'];
  known.forEach(function(name) { if (text.includes(name.toLowerCase())) entities.add(name); });
  return entities;
}

export { coarseFilter, isLowValueRoutineSports, sameHotspotEvent, isRecentVerifiedSignal, sameEvent };
