/**
 * AI Matchmaker Routes
 * ChatGPT-like conversation + Matchmaker search.
 */

const express = require('express');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const db = getFirestore();

const DEFAULT_MATCH_LIMIT = 6;
const MAX_MATCH_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 150;
const MATCHMAKER_TIMEZONE = process.env.AI_MATCHMAKER_TIMEZONE || 'Asia/Ho_Chi_Minh';

const INTEREST_ALIASES = [
  { value: 'Cafe', terms: ['cafe', 'coffee', 'ca phe', 'caphe', 'tra sua'] },
  { value: 'Du lich', terms: ['du lich', 'travel', 'phuot', 'trip', 'xuyen viet'] },
  { value: 'Am nhac', terms: ['am nhac', 'music', 'hat', 'karaoke', 'rap', 'rock', 'pop', 'edmviet'] },
  { value: 'Phim', terms: ['phim', 'movie', 'cinema', 'netflix', 'anime'] },
  { value: 'Game', terms: ['game', 'gaming', 'esport', 'lol', 'lien minh', 'pubg', 'genshin'] },
  { value: 'Gym', terms: ['gym', 'fitness', 'the thao', 'bong da', 'bong ro', 'yoga', 'chay bo'] },
  { value: 'Sach', terms: ['sach', 'book', 'doc sach', 'novel', 'trinh tham'] },
  { value: 'An uong', terms: ['an uong', 'food', 'foodie', 'nau an', 'am thuc', 'sushi', 'pizza'] },
  { value: 'Thu cung', terms: ['thu cung', 'pet', 'cho', 'meo', 'dog', 'cat'] },
];

const CITY_ALIASES = [
  { value: 'Ho Chi Minh', terms: ['ho chi minh', 'hcm', 'sai gon', 'saigon', 'tphcm', 'sg', 'thu duc'] },
  { value: 'Ha Noi', terms: ['ha noi', 'hanoi', 'hn', 'ba dinh', 'hoan kiem', 'dong da'] },
  { value: 'Da Nang', terms: ['da nang', 'danang', 'hai chau', 'son tra'] },
];

const ADULT_ONLY_MATCHMAKER_MESSAGE = 'Để an toàn, ChappAt chỉ gợi ý hồ sơ từ 18 tuổi trở lên. Bạn chọn một khoảng tuổi 18+ nhé.';

/* Rate Limiting & Dedup */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestLog = new Map();
const dedupMap = new Map();

function isRateLimited(uid) {
  const now = Date.now();
  const log = (requestLog.get(uid) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  requestLog.set(uid, log);
  return log.length >= RATE_LIMIT_MAX_REQUESTS;
}

router.use(authMiddleware);

router.post('/search', async (req, res) => {
  try {
    const uid = req.user.uid;
    const prompt = String(req.body?.prompt || '').trim();
    const conversation = normalizeConversation(req.body?.messages);
    const limit = Math.min(Math.max(Number(req.body?.limit) || DEFAULT_MATCH_LIMIT, 1), MAX_MATCH_LIMIT);
    const location = normalizeLocation(req.body?.location);
    const excludeIds = new Set(normalizeStringArray(req.body?.excludeIds).map(id => String(id).trim()).filter(Boolean));

    if (isRateLimited(uid)) {
      return res.status(429).json({ success: false, error: 'Bạn gửi yêu cầu hơi nhanh. Đợi một chút rồi thử lại nhé.' });
    }
    requestLog.set(uid, [...(requestLog.get(uid) || []), Date.now()]);

    if (prompt.length < 1) return res.status(400).json({ error: 'Vui lòng nhập tin nhắn.' });

    const viewerSnap = await db.collection('users').doc(uid).get();
    if (!viewerSnap.exists) return res.status(404).json({ error: 'User not found' });
    const viewer = { id: uid, ...viewerSnap.data() };

    // 1. Safety Check
    if (hasUnderageDatingRequest(prompt)) {
      return res.json({ mode: 'chat', assistantMessage: ADULT_ONLY_MATCHMAKER_MESSAGE, suggestedReplies: ['18-25 tuổi', '22-28 tuổi'], matches: [] });
    }

    // 2. Kiểm tra có muốn tìm người không
    const shouldSearch = shouldRunMatchSearch(prompt, conversation);

    if (!shouldSearch) {
      // CHAT MODE CHATGPT
      const assistantMessage = await composeAiChatMessage({ conversation, prompt, viewer });
      return res.json({ mode: 'chat', assistantMessage, suggestedReplies: [], matches: [] });
    }

    // SEARCH MODE
    const rawIntent = buildHeuristicIntent(prompt);
    const candidates = (await loadCandidates(uid, viewer, rawIntent))
      .filter(c => !excludeIds.has(String(c.id || c.uid || '').trim()));
      
    const ranked = rankCandidates(candidates, viewer, rawIntent, prompt, location).slice(0, limit);
    const matches = ranked.map(({ user, percent, reasons, distanceKm }) => ({
      ...toPublicUser(user), matchPercent: percent, matchScore: percent, matchReasons: reasons, distanceKm
    }));

    const assistantMessage = await composeAiResultMessage({ conversation, prompt, viewer, matches });
    
    return res.json({
      mode: 'results',
      assistantMessage,
      suggestedReplies: matches.length > 0 ? ['Tìm thêm người khác', 'Ẩn kết quả'] : [],
      matches
    });

  } catch (error) {
    console.error('[AI_MATCHMAKER] Error:', error);
    res.status(500).json({ error: 'Lỗi hệ thống AI.' });
  }
});

// --- AI Text Generation ---
async function composeAiChatMessage({ conversation, prompt, viewer }) {
  const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const fallback = "Xin lỗi, hệ thống kết nối tới AI đang hơi trục trặc. Bạn nhắn lại thử nhé!";
  if (!apiKey) {
    console.error('[AI_MATCHMAKER] Missing API Key in .env');
    return fallback;
  }

  try {
    const baseUrl = getAiBaseUrl();
    const model = process.env.AI_CHAT_MODEL || process.env.AI_MODEL || (baseUrl.includes('deepseek.com') ? 'deepseek-chat' : 'openai/gpt-4o-mini');
    const recentMessages = normalizeConversation(conversation).slice(-6).map(item => ({
      role: item.role,
      content: item.text.slice(0, 500)
    }));

    const response = await postAiChatCompletion({
      baseUrl, apiKey, timeoutMs: 15000,
      payload: {
        model,
        temperature: 0.85,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content: `Bạn là một trợ lý AI ảo thông minh, duyên dáng, hài hước và hiểu biết. 
            Bạn đang hoạt động trong app hẹn hò ChappAt.
            Bạn CÓ THỂ trò chuyện tự nhiên về BẤT KỲ chủ đề nào (khoa học, đời sống, tâm sự, triết lý, công nghệ) giống hệt ChatGPT. 
            Hãy trả lời câu hỏi của người dùng một cách chân thành, thông minh và hữu ích.
            Không cần phải lúc nào cũng nói về hẹn hò. Chỉ khi người dùng muốn tìm người, bạn mới đóng vai trò Matchmaker.
            Trả lời ngắn gọn, tự nhiên, giống như nhắn tin với bạn bè.`
          },
          ...recentMessages,
          { role: 'user', content: prompt }
        ]
      }
    });

    if (response.ok) {
      const data = await response.json();
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      return content || fallback;
    } else {
      const errBody = await response.text();
      console.error('[AI_MATCHMAKER] AI API Error:', response.status, errBody);
      return fallback;
    }
  } catch (error) {
    console.error('[AI_MATCHMAKER] Chat reply failed:', error.message);
    return fallback;
  }
}

async function composeAiResultMessage({ conversation, prompt, viewer, matches }) {
  const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const fallback = matches.length > 0 ? `Mình tìm được ${matches.length} hồ sơ khá hợp gu. Bạn xem thử nhé!` : 'Mình chưa thấy ai thật sự hợp, thử đổi tiêu chí nhé.';

  if (!apiKey) return fallback;

  try {
    const baseUrl = getAiBaseUrl();
    const model = process.env.AI_CHAT_MODEL || process.env.AI_MODEL || (baseUrl.includes('deepseek.com') ? 'deepseek-chat' : 'openai/gpt-4o-mini');
    const recentMessages = normalizeConversation(conversation).slice(-4).map(item => ({
      role: item.role, content: item.text.slice(0, 400)
    }));

    const response = await postAiChatCompletion({
      baseUrl, apiKey, timeoutMs: 10000,
      payload: {
        model, temperature: 0.7, max_tokens: 150,
        messages: [
          { role: 'system', content: 'Bạn là AI Matchmaker. Bạn vừa tìm được hồ sơ cho user. Hãy giới thiệu nhẹ nhàng, tự nhiên trong 1-2 câu.' },
          ...recentMessages,
          { role: 'user', content: JSON.stringify({ task: 'introduce_matches', count: matches.length, topReasons: [...new Set(matches.flatMap(m => m.matchReasons))].slice(0, 3) }) }
        ]
      }
    });

    if (response.ok) {
      const data = await response.json();
      return String(data?.choices?.[0]?.message?.content || '').trim() || fallback;
    }
    return fallback;
  } catch (error) {
    return fallback;
  }
}

async function postAiChatCompletion({ baseUrl, apiKey, timeoutMs, payload }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(baseUrl.includes('openrouter.ai') ? { 'HTTP-Referer': 'https://chappat.com', 'X-Title': 'ChappAt' } : {}) },
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

// --- Heuristics & DB ---
function shouldRunMatchSearch(prompt, conversation) {
  const text = normalize(prompt);
  if (!text || hasUnderageDatingRequest(text)) return false;

  const explicitSearchRegex = /\b(tim|kiem|loc|goi y|de xuat|gioi thieu|match|mai moi|ket noi|recommend|suggest|find|search|show|kiem ban|kiem nguoi yeu|co ai|ai do|crush|muon hen ho|muon tim hieu)\b/;
  const moreResultsRegex = /\b(them|xem them|loc tiep|goi y tiep|nguoi khac|ho so khac|ket qua moi|khac nua|nua di|them nua|more|another|next)\b/;
  
  if (explicitSearchRegex.test(text) || moreResultsRegex.test(text)) return true;
  
  const lastAssistantMsg = conversation.filter(m => m.role === 'assistant').pop();
  if (lastAssistantMsg && /tìm|lọc|gợi ý|hồ sơ/i.test(lastAssistantMsg.text)) {
      if (/\b(ok|duoc|ung ho|di|lam di|yes|co)\b/.test(text)) return true;
  }
  return false;
}

function buildHeuristicIntent(prompt) {
  const text = normalize(prompt);
  const genders = [];
  if (/\b(nu|gai|ban gai|female|girl|woman)\b/.test(text)) genders.push('female');
  if (/\b(nam|trai|ban trai|male|boy|man)\b/.test(text)) genders.push('male');

  let minAge = null, maxAge = null;
  const range = text.match(/\b(1[8-9]|[2-5]\d)\s*(?:-|den|toi|->)\s*(1[8-9]|[2-5]\d)\b/);
  if (range) { minAge = Number(range[1]); maxAge = Number(range[2]); }
  else {
    const near = text.match(/\b(1[8-9]|[2-5]\d)\s*(?:tuoi)?\b/);
    if (near) { const age = Number(near[1]); minAge = Math.max(18, age - 3); maxAge = age + 3; }
  }

  const interests = INTEREST_ALIASES.filter(e => e.terms.some(t => text.includes(t))).map(e => e.value);
  const cities = CITY_ALIASES.filter(e => e.terms.some(t => text.includes(t))).map(e => e.value);
  const radiusMatch = text.match(/\b(\d{1,3})\s*(?:km|kilomet)/);

  return { genders, minAge, maxAge, interests, cities, radiusKm: radiusMatch ? Number(radiusMatch[1]) : null };
}

async function loadCandidates(uid, viewer, intent) {
  const limit = DEFAULT_CANDIDATE_LIMIT;
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
    const cText = normalize([c?.username, c?.bio, c?.job, c?.city, c?.interests?.join(' ')].join(' '));
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

    const hits = intent.interests.filter(i => cInterests.some(ci => ci.includes(normalize(i))) || cText.includes(normalize(i)));
    if (hits.length) { score += Math.min(28, hits.length * 9); reasons.push(`Cùng vibe ${hits.slice(0,2).join(', ')}`); }

    const dist = getDistanceKm(viewerLocation || normalizeLocation(viewer?.location), normalizeLocation(c?.location));
    if (dist !== null && dist <= (intent.radiusKm || 30)) { score += Math.max(4, 16 - dist / 3); reasons.push(`${Math.round(dist)}km gần bạn`); }

    if (c.isOnline) score += 4;
    if (c.profileUrl || c.photoURL) score += 4;

    return { user: c, percent: Math.min(99, Math.max(1, Math.round(score))), distanceKm: dist ? Number(dist.toFixed(1)) : undefined, reasons: [...new Set(reasons)].slice(0, 3) };
  }).filter(e => e.percent >= 35).sort((a, b) => b.percent - a.percent);
}

// --- Utils ---
function hasUnderageDatingRequest(text = '') {
  const t = normalize(text);
  if (/\b(?:duoi|nho hon|under)\s*(1[0-7]|18)\b/.test(t)) return true;
  if (/\b(1[0-7])\s*(?:-|den|toi|->)\s*(1[0-7])\b/.test(t)) return true;
  const m = t.match(/\b(1[0-7])\s*(?:tuoi)?\b/);
  if (!m) return false;
  return !(Number(m[1]) === 17 && /\b(?:tren|lon hon|over)\s*$/.test(t.slice(Math.max(0, m.index - 16), m.index)));
}
function normalize(v) { return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim(); }
function normalizeGender(v) { const g = normalize(v); return ['female','f','nu','girl'].includes(g) ? 'female' : ['male','m','nam','boy'].includes(g) ? 'male' : ''; }
function normalizeStringArray(v) { return !v ? [] : (Array.isArray(v) ? v : [v]).map(i => String(i || '').trim()).filter(Boolean); }
function normalizeLocation(v) { if (!v) return null; const lat = Number(v.latitude ?? v._latitude ?? v.lat), lng = Number(v.longitude ?? v._longitude ?? v.lng ?? v.lon); return (Number.isFinite(lat) && Number.isFinite(lng)) ? { latitude: lat, longitude: lng } : null; }
function getDistanceKm(f, t) { if (!f || !t) return null; const R = 6371, dLat = (t.latitude-f.latitude)*Math.PI/180, dLon = (t.longitude-f.longitude)*Math.PI/180, a = Math.sin(dLat/2)**2 + Math.cos(f.latitude*Math.PI/180)*Math.cos(t.latitude*Math.PI/180)*Math.sin(dLon/2)**2; return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
function getAgeNumber(v) { if (typeof v === 'number') return v; if (typeof v === 'string') { const n = Number(v); if (Number.isFinite(n)) return n; const d = new Date(v); if (!isNaN(d.getTime())) return ageFromDate(d); } if (v instanceof Date) return ageFromDate(v); if (v?.toDate) return ageFromDate(v.toDate()); return null; }
function ageFromDate(d) { const n = new Date(); let y = n.getFullYear() - d.getFullYear(); if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) y--; return y > 0 ? y : null; }
function isDiscoverableCandidate(c, viewer, uid) {
  if (!c || c.isDeleted || c.banned || c.profileVisible === false) return false;
  if ((viewer?.blockedUsers || []).includes(c.id) || (c?.blockedUsers || []).includes(uid)) return false;
  const age = getAgeNumber(c.age);
  if (!age || age < 18) return false;
  return Boolean(c.username && c.gender && (c.profileUrl || c.photoURL));
}
function toPublicUser(u) {
  return { id: u.id || u.uid, uid: u.uid || u.id, username: u.username || 'ChappAt user', displayName: u.displayName || u.username || '', age: getAgeNumber(u.age) || null, gender: normalizeGender(u.gender) || null, profileUrl: u.profileUrl || '', photoURL: u.photoURL || '', avatarUrl: u.avatarUrl || '', bio: u.bio || '', job: u.job || '', city: u.city || '', interests: normalizeStringArray(u.interests).slice(0, 12), isOnline: Boolean(u.isOnline), location: normalizeLocation(u.location) };
}
function normalizeConversation(v) { return Array.isArray(v) ? v.slice(-8).map(i => ({ role: i?.role === 'assistant' ? 'assistant' : 'user', text: String(i?.text || i?.content || '').trim() })).filter(i => i.text) : []; }

module.exports = router;