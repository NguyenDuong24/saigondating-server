/**
 * AI Matchmaker Routes
 * Turns a natural-language dating prompt into ranked Firestore user matches.
 * Now supports casual ChatGPT-like conversation.
 */

const express = require('express');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const db = getFirestore();

const DEFAULT_MATCH_LIMIT = 6;
const MAX_MATCH_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 180;
const MAX_CANDIDATE_LIMIT = 500;
const MATCHMAKER_TIMEZONE = process.env.AI_MATCHMAKER_TIMEZONE || 'Asia/Ho_Chi_Minh';

const INTEREST_ALIASES = [
  { value: 'Cafe', terms: ['cafe', 'coffee', 'ca phe', 'caphe', 'tra sua', 'highlands', 'starbucks'] },
  { value: 'Du lich', terms: ['du lich', 'travel', 'phuot', 'trip', 'di choi xa', 'backpacking', 'xuyen viet', 'nhat ban', 'han quoc', 'thai lan', 'chau au', 'trung quoc', 'du lich nuoc ngoai'] },
  { value: 'Am nhac', terms: ['am nhac', 'music', 'hat', 'karaoke', 'concert', 'nhac', 'rap', 'hiphop', 'rock', 'pop', 'bolero', 'nhac tre', 'ballad', 'nhac viet', 'edmviet', 'dj', 'piano', 'guitar', 'ukulele', 'violin'] },
  { value: 'Phim', terms: ['phim', 'movie', 'cinema', 'netflix', 'phim han', 'phim nhat', 'phim my', 'marvel', 'anime', 'manga', 'disney', 'phim rap'] },
  { value: 'Game', terms: ['game', 'gaming', 'esport', 'lol', 'lien minh', 'lien quan', 'pubg', 'free fire', 'valorant', 'genshin', 'tft', 'steam', 'playstation', 'nintendo'] },
  { value: 'Gym', terms: ['gym', 'fitness', 'tap gym', 'the thao', 'bong da', 'bong ro', 'cau long', 'tennis', 'boi loi', 'boxing', 'muay thai', 'martial arts', 'taekwondo', 'badminton', 'basketball', 'football'] },
  { value: 'Yoga', terms: ['yoga', 'thien', 'meditation', 'mindfulness', 'pilates'] },
  { value: 'Chay bo', terms: ['chay bo', 'running', 'marathon', 'jogging', 'trail running'] },
  { value: 'Sach', terms: ['sach', 'book', 'doc sach', 'novel', 'tieu thuyet', 'trinh tham', 'light novel', 'self help', 'manga', 'webtoon', 'komik', 'van hoc', 'tho', 'blog'].map(w => w.toLowerCase()) },
  { value: 'Chup anh', terms: ['chup anh', 'photography', 'photo', 'may anh', 'canon', 'sony', 'nikon', 'chinh sua anh', 'lightroom', 'photoshop', 'film', 'instax'] },
  { value: 'An uong', terms: ['an uong', 'food', 'foodie', 'nau an', 'am thuc', 'mon ngon', 'buffet', 'lau', 'nuong', 'sushi', 'pizza', 'bbq', 'street food', 'quan nhau', 'bar', 'mixology'] },
  { value: 'Thu cung', terms: ['thu cung', 'pet', 'cho', 'meo', 'dog', 'cat', 'hamster', 'shiba', 'corgi', 'husky', 'golden'] },
  { value: 'Nghe thuat', terms: ['nghe thuat', 'art', 've tranh', 'design', 'digital art', 'illustration', 'fashion', 'thoi trang', 'makeup', 'sketch', ' acrylic', 'watercolor'] },
  { value: 'Startup', terms: ['startup', 'kinh doanh', 'business', 'entrepreneur', 'crypto', 'blockchain', 'nft', 'marketing', 'seo', 'content creator', 'influencer', 'streamer', 'freelance', 'remote'] },
];

const CITY_ALIASES = [
  { value: 'Ho Chi Minh', terms: ['ho chi minh', 'hcm', 'sai gon', 'saigon', 'tphcm', 'tp hcm', 'sg', 'quan 1', 'quan 2', 'quan 3', 'quan 7', 'quan 9', 'thu duc', 'binh thanh', 'go vap', 'tan binh', 'phu nhuan', 'district 1', 'district 2', 'thao dien'] },
  { value: 'Ha Noi', terms: ['ha noi', 'hanoi', 'hn', 'ba dinh', 'hoan kiem', 'dong da', 'cau giay', 'tay ho', 'nam tu liem', 'bac tu liem', 'hoang mai', 'long bien', 'ha dong'] },
  { value: 'Da Nang', terms: ['da nang', 'danang', 'hai chau', 'son tra', 'ngu hanh son', 'lien chieu', 'cam le', 'hoa khanh'] },
  { value: 'Can Tho', terms: ['can tho', 'cai rang', 'binh thuy', 'ninh kieu'] },
  { value: 'Nha Trang', terms: ['nha trang', 'khanh hoa'] },
  { value: 'Da Lat', terms: ['da lat', 'dalat', 'lam dong'] },
  { value: 'Hai Phong', terms: ['hai phong', 'hp'] },
  { value: 'Bien Hoa', terms: ['bien hoa', 'dong nai'] },
  { value: 'Vung Tau', terms: ['vung tau', 'brvt', 'ba ria'] },
];

const STOPWORDS = new Set([
  'toi', 'minh', 'muon', 'tim', 'kiem', 'nguoi', 'ban', 'mot', 'ai', 'voi',
  'de', 'di', 'cho', 'co', 'la', 'o', 'gan', 'thich', 'hop', 'vui', 'nay',
  'hom', 'nay', 'can', 'gap', 'neu', 'nhung', 'cac', 'va', 'hoac', 'the',
]);

const ADULT_ONLY_MATCHMAKER_MESSAGE = 'Để an toàn, ChappAt chỉ gợi ý hồ sơ từ 18 tuổi trở lên. Bạn chọn một khoảng tuổi 18+ nhé.';
const ADULT_AGE_REPLIES = ['18-25 tuổi', '22-28 tuổi', '25-32 tuổi'];

/* Rate Limiting & Dedup */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_AI_REQUESTS = 15;
const REQUEST_DEDUP_WINDOW_MS = 5_000;

const requestLog = new Map();
const dedupMap = new Map();

function getRequestLog(uid) {
  const now = Date.now();
  const log = requestLog.get(uid) || [];
  const fresh = log.filter((entry) => now - entry.timestamp < RATE_LIMIT_WINDOW_MS);
  requestLog.set(uid, fresh);
  return fresh;
}

function isRateLimited(uid, isAiCall = false) {
  return getRequestLog(uid).length >= (isAiCall ? RATE_LIMIT_AI_REQUESTS : RATE_LIMIT_MAX_REQUESTS);
}

function recordRequest(uid) {
  const log = requestLog.get(uid) || [];
  log.push({ timestamp: Date.now() });
  requestLog.set(uid, log);
}

function makeDedupKey(uid, prompt, excludeIds = []) {
  const base = `${uid}::${prompt}::${excludeIds.slice(0, 5).join(',')}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash) + base.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function getDedupedPromise(key, factory) {
  const now = Date.now();
  for (const [k, v] of dedupMap.entries()) {
    if (now - v.timestamp > REQUEST_DEDUP_WINDOW_MS) dedupMap.delete(k);
  }
  const existing = dedupMap.get(key);
  if (existing && now - existing.timestamp < REQUEST_DEDUP_WINDOW_MS) {
    return existing.promise;
  }
  const promise = factory();
  dedupMap.set(key, { timestamp: now, promise });
  return promise;
}

router.use(authMiddleware);

router.post('/search', async (req, res) => {
  const startedAt = Date.now();
  try {
    const uid = req.user.uid;
    const prompt = String(req.body?.prompt || '').trim();
    const conversation = normalizeConversation(req.body?.messages);
    const limit = clamp(Number(req.body?.limit) || DEFAULT_MATCH_LIMIT, 1, MAX_MATCH_LIMIT);
    const location = normalizeLocation(req.body?.location);
    const excludeIds = new Set(normalizeStringArray(req.body?.excludeIds).map(id => String(id).trim()).filter(Boolean).slice(0, 50));

    if (isRateLimited(uid)) {
      return res.status(429).json({ success: false, code: 'RATE_LIMITED', error: 'Bạn gửi yêu cầu hơi nhanh. Đợi một chút rồi thử lại nhé.' });
    }
    recordRequest(uid);

    const dedupKey = makeDedupKey(uid, prompt, Array.from(excludeIds));
    const dedupedResult = await getDedupedPromise(dedupKey, async () => {
      await _processSearch({ uid, prompt, conversation, limit, location, excludeIds, startedAt, res });
      return null;
    });

    if (dedupedResult !== null) res.json(dedupedResult);
  } catch (error) {
    console.error('[AI_MATCHMAKER] Search error:', error);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'AI_MATCHMAKER_ERROR', error: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
});

async function _processSearch({ uid, prompt, conversation, limit, location, excludeIds, startedAt, res }) {
  try {
    if (prompt.length < 1) return res.status(400).json({ success: false, code: 'PROMPT_REQUIRED', error: 'Vui lòng nhập tin nhắn.' });
    if (prompt.length > 1000) return res.status(400).json({ success: false, code: 'PROMPT_TOO_LONG', error: 'Tin nhắn quá dài.' });

    const viewerSnap = await db.collection('users').doc(uid).get();
    if (!viewerSnap.exists) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', error: 'User not found' });

    const viewer = { id: uid, ...viewerSnap.data() };
    
    // 1. Safety Check (Underage)
    if (hasUnderageDatingRequest(prompt)) {
      return res.json({
        success: true,
        mode: 'chat',
        needsMoreInfo: false,
        assistantMessage: ADULT_ONLY_MATCHMAKER_MESSAGE,
        suggestedReplies: ADULT_AGE_REPLIES,
        suggestedAction: null,
        count: 0,
        matches: []
      });
    }

    // 2. Determine if user wants to search or just chat
    const shouldSearch = shouldRunMatchSearch(prompt, conversation);

    if (!shouldSearch) {
      // CHAT MODE: Gọi AI trò chuyện như ChatGPT
      const fallback = buildCasualAssistantFallback(prompt, viewer);
      const assistantMessage = await composeAiChatMessage({ conversation, prompt, viewer, fallback });

      return res.json({
        success: true,
        mode: 'chat',
        needsMoreInfo: false,
        assistantMessage,
        suggestedReplies: [], // Để AI tự quyết định hoặc để trống cho gọn
        suggestedAction: null,
        count: 0,
        matches: []
      });
    }

    // SEARCH MODE: Trích xuất ý định và tìm kiếm
    const rawIntent = buildHeuristicIntent(prompt);
    const analysis = await analyzePromptWithAi(prompt, viewer, rawIntent);
    
    const candidates = (await loadCandidates(uid, viewer, analysis.intent))
      .filter((candidate) => !isExcludedCandidate(candidate, excludeIds));
      
    const ranked = rankCandidates(candidates, viewer, analysis.intent, prompt, location).slice(0, limit);
    const matches = ranked.map(({ user, percent, reasons, distanceKm }) => ({
      ...toPublicUser(user),
      matchPercent: percent,
      matchScore: percent,
      matchReasons: reasons,
      distanceKm,
    }));

    const assistantMessage = await composeAiResultMessage({
      conversation, prompt, viewer, intent: analysis.intent, matches, fallback: buildAssistantMessage(matches, analysis.intent)
    });

    return res.json({
      success: true,
      mode: 'results',
      needsMoreInfo: false,
      assistantMessage,
      suggestedReplies: matches.length > 0 ? ['Tìm thêm người khác', 'Ẩn kết quả'] : [],
      suggestedAction: null,
      count: matches.length,
      matches
    });

  } catch (error) {
    console.error('[AI_MATCHMAKER] Process error:', error);
    if (!res.headersSent) res.status(500).json({ success: false, code: 'AI_MATCHMAKER_ERROR', error: 'Lỗi xử lý AI.' });
  }
}

// --- AI Text Generation ---
async function analyzePromptWithAi(prompt, viewer, fallbackIntent) {
  const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return { intent: fallbackIntent, source: 'heuristic' };

  try {
    const baseUrl = getAiBaseUrl();
    const model = process.env.AI_MODEL || (baseUrl.includes('deepseek.com') ? 'deepseek-chat' : 'openai/gpt-4o-mini');
    const response = await postAiChatCompletion({
      baseUrl, apiKey, timeoutMs: 8000,
      payload: {
        model, temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Extract dating search intent. Return JSON. Schema: genders string[], minAge number|null, maxAge number|null, interests string[], cities string[], relationshipGoals string[], radiusKm number|null. Gender must be male/female. Never create under-18 intent.' },
          { role: 'user', content: JSON.stringify({ prompt, viewer: { gender: viewer?.gender, age: getAgeNumber(viewer?.age), city: viewer?.city } }) }
        ]
      }
    });
    if (response.ok) {
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content) return { intent: normalizeIntent({ ...fallbackIntent, ...extractJson(content) }), source: 'ai' };
    }
    return { intent: fallbackIntent, source: 'heuristic' };
  } catch (e) {
    return { intent: fallbackIntent, source: 'heuristic' };
  }
}

async function composeAiChatMessage({ conversation, prompt, viewer, fallback }) {
  const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.AI_CHAT_ENABLED === 'false') return fallback;

  try {
    const recentMessages = normalizeConversation(conversation).slice(-6).map(item => ({
      role: item.role,
      content: item.text.slice(0, 500)
    }));

    const baseUrl = getAiBaseUrl();
    const model = process.env.AI_CHAT_MODEL || process.env.AI_MODEL || (baseUrl.includes('deepseek.com') ? 'deepseek-chat' : 'openai/gpt-4o-mini');
    
    const response = await postAiChatCompletion({
      baseUrl, apiKey, timeoutMs: 10000,
      payload: {
        model,
        temperature: 0.8, // Tăng tính sáng tạo
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: [
              'Bạn là một trợ lý AI thông minh, duyên dáng và ấm áp trong ứng dụng hẹn hò ChappAt.',
              'Bạn có thể trò chuyện tự nhiên về BẤT KỲ chủ đề nào (giống ChatGPT) như một người bạn thực sự: tâm sự, hỏi đáp kiến thức, kể chuyện, đùa giỡn.',
              'Bạn đặc biệt giỏi trong việc lắng nghe và tư vấn tình cảm, gu hẹn hò.',
              'Nếu người dùng hỏi những câu ngoài lề (thời tiết, triết lý, công nghệ...), hãy trả lời thông minh và tự nhiên.',
              'Chỉ khi người dùng RÕ RÀNG muốn tìm kiếm, gợi ý hoặc lọc người phù hợp, bạn mới nhắc đến việc tìm hồ sơ (nhưng ở lượt này user chưa yêu cầu rõ, nên cứ trò chuyện tự nhiên).',
              'Không nhắc tới hệ thống, JSON, prompt, thuật toán hay backend. Chỉ hỗ trợ mối quan hệ 18+.',
              'Trả lời ngắn gọn, tự nhiên, có cảm xúc như chat thật, dưới 80 từ.'
            ].join(' ')
          },
          ...recentMessages,
          { role: 'user', content: prompt }
        ]
      }
    });

    if (response.ok) {
      const data = await response.json();
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      return cleanAssistantMessage(content, fallback);
    }
    return fallback;
  } catch (error) {
    console.warn('[AI_MATCHMAKER] Chat reply failed:', error.message);
    return fallback;
  }
}

async function composeAiResultMessage({ conversation, prompt, viewer, intent, matches, fallback }) {
  const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.AI_CHAT_ENABLED === 'false') return fallback;

  try {
    const recentMessages = normalizeConversation(conversation).slice(-4).map(item => ({
      role: item.role, content: item.text.slice(0, 400)
    }));

    const baseUrl = getAiBaseUrl();
    const model = process.env.AI_CHAT_MODEL || process.env.AI_MODEL || (baseUrl.includes('deepseek.com') ? 'deepseek-chat' : 'openai/gpt-4o-mini');

    const response = await postAiChatCompletion({
      baseUrl, apiKey, timeoutMs: 8000,
      payload: {
        model, temperature: 0.7, max_tokens: 150,
        messages: [
          {
            role: 'system',
            content: [
              'Bạn là AI Matchmaker trong app hẹn hò. Bạn vừa tìm được hồ sơ cho user.',
              'Hãy giới thiệu nhẹ nhàng, tự nhiên như một người bạn giới thiệu người ta cho nhau.',
              'Nêu số lượng và điểm nổi bật (vibe, sở thích) để user cảm thấy hứng thú.',
              'Giữ thái độ ấm áp, không dùng bullet point, dưới 60 từ.'
            ].join(' ')
          },
          ...recentMessages,
          {
            role: 'user',
            content: JSON.stringify({ latestUserMessage: prompt, task: 'respond_to_match_results', intent, result: { count: matches.length, topReasons: summarizeMatchReasons(matches) } })
          }
        ]
      }
    });

    if (response.ok) {
      const data = await response.json();
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      return cleanAssistantMessage(content, fallback);
    }
    return fallback;
  } catch (error) {
    return fallback;
  }
}

// --- Heuristics & DB ---
function shouldRunMatchSearch(prompt, conversation) {
  const text = normalize(prompt);
  if (!text || hasUnderageDatingRequest(text)) return false;

  const explicitSearchRegex = /\b(tim|kiem|loc|goi y|de xuat|gioi thieu|match|mai moi|ket noi|recommend|suggest|find|search|show|kiem ban|kiem nguoi yeu|co ai|ai do|crush|muon hen ho|muon tim hieu)\b/;
  const moreResultsRegex = /\b(them|xem them|loc tiep|goi y tiep|nguoi khac|ho so khac|ket qua moi|khac nua|nua di|them nua|more|another|next)\b/;
  
  if (explicitSearchRegex.test(text) || moreResultsRegex.test(text)) return true;
  
  // Nếu user trả lời "ok", "được", "tìm đi" sau khi AI vừa gợi ý
  const lastAssistantMsg = conversation.filter(m => m.role === 'assistant').pop();
  if (lastAssistantMsg && /tìm|lọc|gợi ý|hồ sơ/i.test(lastAssistantMsg.text)) {
      if (/\b(ok|duoc|ung ho|di|lam di|yes|co)\b/.test(text)) return true;
  }
  
  return false;
}

function buildHeuristicIntent(prompt) {
  const text = normalize(prompt);
  const genders = [];
  if (/\b(nu|gai|ban gai|female|girl|woman|co gai|em gai)\b/.test(text)) genders.push('female');
  if (/\b(nam|trai|ban trai|male|boy|man|anh trai)\b/.test(text)) genders.push('male');

  let minAge = null, maxAge = null;
  const range = text.match(/\b(1[8-9]|[2-5]\d)\s*(?:-|den|toi|->)\s*(1[8-9]|[2-5]\d)\b/);
  if (range) { minAge = Number(range[1]); maxAge = Number(range[2]); }
  else {
    const under = text.match(/\b(?:duoi|nho han|under)\s*(1[8-9]|[2-5]\d)\b/);
    const over = text.match(/\b(?:tren|lon hon|over)\s*(1[8-9]|[2-5]\d)\b/);
    const near = text.match(/\b(1[8-9]|[2-5]\d)\s*(?:tuoi)?\b/);
    if (under) maxAge = Number(under[1]);
    if (over) minAge = Number(over[1]);
    if (!under && !over && near) { const age = Number(near[1]); minAge = Math.max(18, age - 3); maxAge = age + 3; }
  }

  const interests = INTEREST_ALIASES.filter(e => e.terms.some(t => text.includes(t))).map(e => e.value);
  const cities = CITY_ALIASES.filter(e => e.terms.some(t => text.includes(t))).map(e => e.value);
  const keywords = text.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOPWORDS.has(w)).slice(0, 12);
  const radiusMatch = text.match(/\b(\d{1,3})\s*(?:km|kilomet)/);

  return normalizeIntent({ genders, minAge, maxAge, interests, cities, keywords, radiusKm: radiusMatch ? Number(radiusMatch[1]) : null });
}

async function loadCandidates(uid, viewer, intent) {
  const limit = clamp(Number(process.env.AI_MATCHMAKER_CANDIDATE_LIMIT) || DEFAULT_CANDIDATE_LIMIT, 50, MAX_CANDIDATE_LIMIT);
  const usersRef = db.collection('users');
  const byId = new Map();
  const addSnap = (snap) => snap.docs.forEach(d => { if (d.id !== uid) byId.set(d.id, { id: d.id, ...d.data() }); });
  
  const queries = [];
  if (intent.interests.length > 0) queries.push(usersRef.where('interests', 'array-contains-any', intent.interests.slice(0, 10)).limit(limit).get());
  if (intent.genders.length === 1) queries.push(usersRef.where('gender', '==', intent.genders[0]).limit(limit).get());
  
  try { await Promise.all(queries.map(q => q.then(addSnap).catch(e => console.warn(e.message)))); } catch (_) {}
  
  if (byId.size < 80) { try { const snap = await usersRef.limit(limit).get(); addSnap(snap); } catch (_) {} }
  
  return Array.from(byId.values()).filter(c => isDiscoverableCandidate(c, viewer, uid));
}

function rankCandidates(candidates, viewer, intent, prompt, viewerLocation) {
  return candidates.map(c => {
    const cText = getSearchText(c);
    const cAge = getAgeNumber(c.age);
    const cGender = normalizeGender(c.gender);
    const cInterests = normalizeStringArray(c.interests).map(normalize);
    let score = 36; const reasons = [];

    if (intent.genders.length > 0) {
      if (cGender && intent.genders.includes(cGender)) { score += 20; reasons.push('Đúng giới tính'); } else { score -= 35; }
    } else if (viewer?.gender && cGender && viewer.gender !== cGender) { score += 3; }

    if (cAge) {
      if (intent.minAge && cAge >= intent.minAge) score += 5;
      if (intent.maxAge && cAge <= intent.maxAge) score += 5;
      if (intent.minAge && cAge < intent.minAge) score -= 15;
      if (intent.maxAge && cAge > intent.maxAge) score -= 15;
    }

    const hits = intent.interests.filter(i => cInterests.some(ci => ci.includes(normalize(i)) || normalize(i).includes(ci)) || cText.includes(normalize(i)));
    if (hits.length) { score += Math.min(28, hits.length * 9); reasons.push(`Cùng vibe ${hits.slice(0,2).join(', ')}`); }

    const dist = getDistanceKm(viewerLocation || normalizeLocation(viewer?.location), normalizeLocation(c?.location));
    if (dist !== null && dist <= (intent.radiusKm || 30)) { score += Math.max(4, 16 - dist / 3); reasons.push(`${Math.round(dist)}km gần bạn`); }

    if (c.isOnline) score += 4;
    if (c.profileUrl || c.photoURL) score += 4;

    return { user: c, percent: clamp(Math.round(score), 1, 99), distanceKm: dist ? Number(dist.toFixed(1)) : undefined, reasons: unique(reasons).slice(0, 3) };
  }).filter(e => e.percent >= 35).sort((a, b) => b.percent - a.percent);
}

// --- Utils ---
function postAiChatCompletion({ baseUrl, apiKey, timeoutMs, payload }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(baseUrl.includes('openrouter.ai') ? { 'HTTP-Referer': 'https://saigondating.com', 'X-Title': 'ChappAt' } : {}) },
    body: JSON.stringify(payload)
  }).finally(() => clearTimeout(timeout));
}

function getAiBaseUrl() {
  if (process.env.AI_BASE_URL) return process.env.AI_BASE_URL.replace(/\/$/, '');
  if (process.env.DEEPSEEK_API_KEY) return 'https://api.deepseek.com/v1';
  if (process.env.OPENROUTER_API_KEY) return 'https://openrouter.ai/api/v1';
  if (process.env.OPENAI_API_KEY) return 'https://api.openai.com/v1';
  return '';
}

function buildCasualAssistantFallback(prompt, viewer) {
  return 'Mình đang nghe bạn đây. Bạn cứ chia sẻ tự nhiên nhé, hoặc nếu cần tìm ai đó hợp gu thì cứ bảo mình lọc cho.';
}

function buildAssistantMessage(matches, intent) {
  if (!matches.length) return 'Mình chưa thấy hồ sơ nào thật sự hợp. Bạn thử nới rộng tuổi hoặc khu vực nhé.';
  return `Mình tìm được ${matches.length} hồ sơ khá hợp gu. Bạn xem thử vibe nào chạm nhất nhé.`;
}

function hasUnderageDatingRequest(text = '') {
  const t = normalize(text);
  if (/\b(?:duoi|nho hon|under)\s*(1[0-7]|18)\b/.test(t)) return true;
  if (/\b(1[0-7])\s*(?:-|den|toi|->)\s*(1[0-7])\b/.test(t)) return true;
  const m = t.match(/\b(1[0-7])\s*(?:tuoi)?\b/);
  if (!m) return false;
  const age = Number(m[1]); const p = t.slice(Math.max(0, m.index - 16), m.index);
  return !(age === 17 && /\b(?:tren|lon hon|over)\s*$/.test(p));
}

function normalizeIntent(raw = {}) {
  let minAge = toNullableNumber(raw.minAge), maxAge = toNullableNumber(raw.maxAge);
  if (minAge && maxAge && minAge > maxAge) [minAge, maxAge] = [maxAge, minAge];
  return {
    genders: unique(normalizeStringArray(raw.genders).map(normalizeGender).filter(Boolean)),
    minAge: minAge && minAge >= 18 ? minAge : null,
    maxAge: maxAge && maxAge > 18 ? maxAge : null,
    interests: unique(normalizeStringArray(raw.interests)).slice(0, 12),
    cities: unique(normalizeStringArray(raw.cities)).slice(0, 6),
    keywords: unique(normalizeStringArray(raw.keywords)).slice(0, 14),
    radiusKm: toNullableNumber(raw.radiusKm)
  };
}

function isDiscoverableCandidate(c, viewer, uid) {
  if (!c || c.isDeleted || c.banned || c.profileVisible === false) return false;
  if (isUidIncluded(viewer?.blockedUsers, c.id) || isUidIncluded(c?.blockedUsers, uid)) return false;
  const age = getAgeNumber(c.age);
  if (!age || age < 18) return false;
  return Boolean(c.username && c.gender && (c.profileUrl || c.photoURL));
}

function isExcludedCandidate(c, excludeIds) {
  if (!excludeIds?.size) return false;
  return [c?.id, c?.uid].filter(Boolean).some(id => excludeIds.has(String(id).trim()));
}

function toPublicUser(u) {
  return {
    id: u.id || u.uid, uid: u.uid || u.id,
    username: u.username || 'ChappAt user', displayName: u.displayName || u.username || '',
    age: getAgeNumber(u.age) || null, gender: normalizeGender(u.gender) || null,
    profileUrl: u.profileUrl || '', photoURL: u.photoURL || '', avatarUrl: u.avatarUrl || '',
    bio: u.bio || '', job: u.job || '', city: u.city || '',
    interests: normalizeStringArray(u.interests).slice(0, 12),
    isOnline: Boolean(u.isOnline),
    location: normalizeLocation(u.location)
  };
}

function summarizeMatchReasons(matches) { return unique(matches.flatMap(m => normalizeStringArray(m.matchReasons)).slice(0, 8)); }
function cleanAssistantMessage(c, f) { const m = String(c || '').replace(/^["'`]+|["'`]+$/g, '').trim(); return (!m || /xin loi|sorry/i.test(normalize(m))) ? f : (m.length > 420 ? m.slice(0,417)+'...' : m); }
function normalizeConversation(v) { return Array.isArray(v) ? v.slice(-8).map(i => ({ role: i?.role === 'assistant' ? 'assistant' : 'user', text: String(i?.text || i?.content || '').trim() })).filter(i => i.text) : []; }
function getSearchText(u) { return normalize([u?.username, u?.bio, u?.job, u?.city, u?.interests?.join(' ')].join(' ')); }
function extractJson(c) { try { return JSON.parse(c); } catch (_) { const m = c.match(/\{[\s\S]*\}/); if (!m) throw new Error('No JSON'); return JSON.parse(m[0]); } }
function normalize(v) { return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim(); }
function normalizeGender(v) { const g = normalize(v); return ['female','f','nu','girl','woman'].includes(g) ? 'female' : ['male','m','nam','boy','man'].includes(g) ? 'male' : ''; }
function normalizeStringArray(v) { return !v ? [] : (Array.isArray(v) ? v : [v]).map(i => String(i || '').trim()).filter(Boolean); }
function normalizeLocation(v) { if (!v) return null; const lat = Number(v.latitude ?? v._latitude ?? v.lat), lng = Number(v.longitude ?? v._longitude ?? v.lng ?? v.lon); return (Number.isFinite(lat) && Number.isFinite(lng)) ? { latitude: lat, longitude: lng } : null; }
function getDistanceKm(f, t) { if (!f || !t) return null; const R = 6371, dLat = (t.latitude-f.latitude)*Math.PI/180, dLon = (t.longitude-f.longitude)*Math.PI/180, a = Math.sin(dLat/2)**2 + Math.cos(f.latitude*Math.PI/180)*Math.cos(t.latitude*Math.PI/180)*Math.sin(dLon/2)**2; return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
function getAgeNumber(v) { if (typeof v === 'number') return v; if (typeof v === 'string') { const n = Number(v); if (Number.isFinite(n)) return n; const d = new Date(v); if (!isNaN(d.getTime())) return ageFromDate(d); } if (v instanceof Date) return ageFromDate(v); if (v?.toDate) return ageFromDate(v.toDate()); return null; }
function ageFromDate(d) { const n = new Date(); let y = n.getFullYear() - d.getFullYear(); if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) y--; return y > 0 ? y : null; }
function toNullableNumber(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function isUidIncluded(v, u) { if (!u || !v) return false; return Array.isArray(v) ? v.includes(u) : (typeof v === 'object' ? Boolean(v[u]) : v === u); }
function unique(v) { return Array.from(new Set(v.filter(Boolean))); }
function clamp(v, m, M) { return Math.min(M, Math.max(m, v)); }

module.exports = router;