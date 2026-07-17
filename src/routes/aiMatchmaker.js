/**
 * AI Matchmaker Routes
 * ChatGPT-like conversation + AI-powered Matchmaker search.
 * Uses OpenAI-compatible function/tool calling for intent detection.
 */

const express = require('express');
const { getFirestore } = require('firebase-admin/firestore');
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

// ============================================================
// TOOL DEFINITION — AI function calling
// ============================================================

const SEARCH_PROFILES_TOOL = {
  type: 'function',
  function: {
    name: 'search_profiles',
    description:
      'Tìm kiếm hồ sơ người dùng trong database ChappAt. ' +
      'CHỈ gọi function này khi user RÕ RÀNG muốn tìm người để hẹn hò / làm quen / kết bạn ' +
      'VÀ đã cung cấp ÍT NHẤT 2 tiêu chí cụ thể (ví dụ: giới tính + tuổi, giới tính + thành phố, giới tính + sở thích). ' +
      'Nếu user chỉ có 1 tiêu chí hoặc tiêu chí mơ hồ, ĐỪNG gọi tool — thay vào đó hãy hỏi thêm để làm rõ. ' +
      'Ví dụ: "tìm bạn gái" → hỏi thêm tuổi, thành phố. "tìm bạn nữ 22-28 tuổi ở HCM thích cafe" → gọi tool ngay.',
    parameters: {
      type: 'object',
      properties: {
        gender: {
          type: 'string',
          enum: ['male', 'female'],
          description: 'Giới tính muốn tìm: male (nam) hoặc female (nữ)'
        },
        minAge: {
          type: 'integer',
          minimum: 18,
          maximum: 80,
          description: 'Tuổi tối thiểu (mặc định 18 nếu không rõ)'
        },
        maxAge: {
          type: 'integer',
          minimum: 18,
          maximum: 80,
          description: 'Tuổi tối đa (mặc định 50 nếu không rõ)'
        },
        interests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sở thích muốn tìm: Cafe, Du lich, Am nhac, Phim, Game, Gym, Sach, An uong, Thu cung'
        },
        city: {
          type: 'string',
          description: 'Thành phố: Ho Chi Minh, Ha Noi, Da Nang'
        },
        radiusKm: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Khoảng cách tối đa tính bằng km (mặc định 30km nếu không rõ)'
        }
      }
    }
  }
};

// ============================================================
// AI SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(viewer) {
  const viewerName = viewer?.displayName || viewer?.username || 'bạn';
  return [
    `Bạn là trợ lý AI thông minh, duyên dáng của ChappAt — app hẹn hò dành cho người Việt.`,
    ``,
    `TÍNH CÁCH:`,
    `- Trò chuyện tự nhiên, hài hước, ấm áp như bạn thân nhắn tin`,
    `- Am hiểu đa dạng chủ đề: khoa học, đời sống, tâm sự, tình yêu, công nghệ, giải trí, triết học...`,
    `- Trả lời NGẮN GỌN (1-4 câu), súc tích, dễ hiểu`,
    `- Dùng tiếng Việt tự nhiên, thêm chút tiếng Anh / emoji cho vui nếu phù hợp`,
    `- Gọi user là "${viewerName}" nếu biết tên`,
    ``,
    `KHI NÀO TÌM KIẾM HỒ SƠ:`,
    `- CHỈ gọi function search_profiles khi user RÕ RÀNG muốn tìm người để hẹn hò / làm quen`,
    `- PHẢI có ÍT NHẤT 2 tiêu chí rõ ràng (giới tính + tuổi/thành phố/sở thích)`,
    `- Nếu user nói mơ hồ ("tìm bạn gái", "có ai không") → ĐỪNG gọi tool, hãy hỏi thêm tự nhiên:`,
    `  "Bạn muốn tìm ở độ tuổi nào, thành phố nào nè? 😊"`,
    `- Nếu user cung cấp đủ thông tin ("tìm bạn nữ 22-28 tuổi ở HCM thích cafe") → GỌI TOOL NGAY`,
    `- Khi gọi tool, luôn để city và interests ở dạng tiếng Việt chuẩn:`,
    `  Ho Chi Minh | Ha Noi | Da Nang`,
    `  Cafe | Du lich | Am nhac | Phim | Game | Gym | Sach | An uong | Thu cung`,
    ``,
    `QUAN TRỌNG:`,
    `- Không giả vờ đã tìm thấy hồ sơ — việc đó do hệ thống backend làm`,
    `- Chỉ trò chuyện hoặc gọi tool, không tự bịa ra kết quả tìm kiếm`,
    `- Nếu user muốn tâm sự, hỏi kiến thức, bàn luận — cứ tự nhiên trả lời, không cần liên quan hẹn hò`
  ].join('\n');
}

// ============================================================
// ROUTE HANDLER
// ============================================================

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

    // 2. Call AI with tool definition — AI decides: chat or search
    const aiResult = await callAiWithTools({ conversation, prompt, viewer });

    // 3. Check if AI called the search tool
    const searchToolCall = aiResult.toolCalls?.find(tc => tc.function?.name === 'search_profiles');

    if (searchToolCall) {
      // AI wants to search — parse criteria and query DB
      const criteria = parseAiCriteria(searchToolCall.function.arguments);
      const intent = criteriaToIntent(criteria);

      const candidates = (await loadCandidates(uid, viewer, intent))
        .filter(c => !excludeIds.has(String(c.id || c.uid || '').trim()));

      const ranked = rankCandidates(candidates, viewer, intent, prompt, location).slice(0, limit);
      const matches = ranked.map(({ user, percent, reasons, distanceKm }) => ({
        ...toPublicUser(user), matchPercent: percent, matchScore: percent, matchReasons: reasons, distanceKm
      }));

      // Generate a friendly intro message for the results
      const assistantMessage = await composeResultIntro({ conversation, viewer, matches });

      return res.json({
        mode: 'results',
        assistantMessage,
        suggestedReplies: matches.length > 0 ? ['Tìm thêm người khác', 'Ẩn kết quả'] : ['Thử tiêu chí khác'],
        matches
      });
    }

    // 4. Chat mode — AI responded with text, no tool call
    const assistantMessage = aiResult.content || 'Xin lỗi, mình chưa hiểu ý bạn lắm. Bạn nói lại nhé!';
    return res.json({ mode: 'chat', assistantMessage, suggestedReplies: [], matches: [] });

  } catch (error) {
    console.error('[AI_MATCHMAKER] Error:', error);
    res.status(500).json({ error: 'Lỗi hệ thống AI.' });
  }
});

// ============================================================
// AI FUNCTIONS
// ============================================================

/**
 * Call AI with tool definition for intent detection.
 * Returns { content: string, toolCalls: array | null }
 * Falls back to heuristics if tool calling fails completely.
 */
async function callAiWithTools({ conversation, prompt, viewer }) {
  const fallbackContent = 'Xin lỗi, hệ thống kết nối tới AI đang hơi trục trặc. Bạn nhắn lại thử nhé!';

  try {
    const recentMessages = normalizeConversation(conversation).slice(-8).map(item => ({
      role: item.role,
      content: item.text.slice(0, 500)
    }));

    const response = await postAiChatCompletionWithFallback({
      timeoutMs: 20000,
      payload: {
        temperature: 0.85,
        max_tokens: 400,
        tools: [SEARCH_PROFILES_TOOL],
        tool_choice: 'auto',
        messages: [
          { role: 'system', content: buildSystemPrompt(viewer) },
          ...recentMessages,
          { role: 'user', content: prompt }
        ]
      }
    });

    if (!response.ok) {
      // AI API failed — fall back to heuristic intent detection
      console.warn('[AI_MATCHMAKER] AI API failed, falling back to heuristics');
      return fallbackToHeuristics({ conversation, prompt });
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;

    if (!message) {
      return { content: fallbackContent, toolCalls: null };
    }

    const content = String(message.content || '').trim();
    const toolCalls = message.tool_calls || null;

    // If AI called a tool, use it; otherwise return chat content
    if (toolCalls && toolCalls.length > 0) {
      return { content: content || null, toolCalls };
    }

    // Pure chat — but if content is empty, fall back to heuristics
    if (!content) {
      return fallbackToHeuristics({ conversation, prompt });
    }

    return { content, toolCalls: null };

  } catch (error) {
    console.error('[AI_MATCHMAKER] callAiWithTools failed:', error.message);
    return fallbackToHeuristics({ conversation, prompt });
  }
}

/**
 * Fallback: use regex heuristics when tool calling fails.
 */
function fallbackToHeuristics({ conversation, prompt }) {
  const shouldSearch = shouldRunMatchSearch(prompt, conversation);
  if (shouldSearch) {
    const intent = buildHeuristicIntent(prompt);
    // Pack heuristic intent into the tool-call format so the route handler can process it uniformly
    const args = {
      gender: intent.genders[0] || null,
      minAge: intent.minAge,
      maxAge: intent.maxAge,
      interests: intent.interests,
      city: intent.cities[0] || null,
      radiusKm: intent.radiusKm,
      _heuristic: true
    };
    return { content: null, toolCalls: [{ function: { name: 'search_profiles', arguments: JSON.stringify(args) } }] };
  }
  return { content: 'Xin lỗi, hệ thống đang bận. Bạn thử lại nhé!', toolCalls: null };
}

/**
 * Generate a friendly intro message for search results.
 */
async function composeResultIntro({ conversation, matches }) {
  const fallback = matches.length > 0
    ? `Mình tìm được ${matches.length} hồ sơ khá hợp gu. Bạn xem thử nhé!`
    : 'Mình chưa thấy ai thật sự hợp, thử đổi tiêu chí nhé.';

  try {
    const recentMessages = normalizeConversation(conversation).slice(-4).map(item => ({
      role: item.role, content: item.text.slice(0, 400)
    }));

    const response = await postAiChatCompletionWithFallback({
      timeoutMs: 10000,
      payload: {
        temperature: 0.7, max_tokens: 150,
        messages: [
          { role: 'system', content: 'Bạn là AI Matchmaker của ChappAt. Bạn vừa tìm được hồ sơ cho user. Hãy giới thiệu nhẹ nhàng, tự nhiên trong 1-2 câu. Không bịa thông tin.' },
          ...recentMessages,
          { role: 'user', content: JSON.stringify({ task: 'introduce_matches', count: matches.length, topReasons: [...new Set(matches.flatMap(m => m.matchReasons || []))].slice(0, 3) }) }
        ]
      }
    });

    if (response.ok) {
      const data = await response.json();
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      return content || fallback;
    }
    return fallback;
  } catch (error) {
    return fallback;
  }
}

// ============================================================
// CRITERIA PARSING — AI tool call → internal intent format
// ============================================================

/**
 * Parse and validate AI tool call arguments.
 */
function parseAiCriteria(args) {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return {
      gender: parsed.gender || null,
      minAge: Number.isFinite(parsed.minAge) ? Math.max(18, parsed.minAge) : null,
      maxAge: Number.isFinite(parsed.maxAge) ? Math.min(80, parsed.maxAge) : null,
      interests: normalizeStringArray(parsed.interests),
      city: parsed.city || null,
      radiusKm: Number.isFinite(parsed.radiusKm) ? parsed.radiusKm : null,
      _heuristic: parsed._heuristic || false
    };
  } catch (e) {
    console.warn('[AI_MATCHMAKER] Failed to parse AI criteria:', e.message);
    return { gender: null, minAge: null, maxAge: null, interests: [], city: null, radiusKm: null, _heuristic: false };
  }
}

/**
 * Map AI criteria to the internal intent format expected by loadCandidates / rankCandidates.
 */
function criteriaToIntent(criteria) {
  const genders = criteria.gender ? [criteria.gender] : [];

  // Match AI interests to known INTEREST_ALIASES
  const aiInterests = criteria.interests.map(normalize);
  const matchedInterests = INTEREST_ALIASES
    .filter(e => aiInterests.some(ai => e.terms.some(t => normalize(t) === ai || normalize(t).includes(ai) || ai.includes(normalize(t)))))
    .map(e => e.value);

  // If AI returned interests that don't match aliases, use them raw
  const unmatched = criteria.interests.filter((_, i) => {
    const ai = aiInterests[i];
    return !INTEREST_ALIASES.some(e => e.terms.some(t => normalize(t) === ai || normalize(t).includes(ai) || ai.includes(normalize(t))));
  });
  const interests = [...new Set([...matchedInterests, ...unmatched])];

  // Match AI city to known CITY_ALIASES
  const aiCity = normalize(criteria.city || '');
  const matchedCity = CITY_ALIASES.find(e => e.terms.some(t => aiCity.includes(normalize(t)) || normalize(t).includes(aiCity)));
  const cities = matchedCity ? [matchedCity.value] : (criteria.city ? [criteria.city] : []);

  return {
    genders,
    minAge: criteria.minAge,
    maxAge: criteria.maxAge,
    interests,
    cities,
    radiusKm: criteria.radiusKm
  };
}

// ============================================================
// AI PROVIDER FUNCTIONS
// ============================================================

/**
 * Build a prioritized list of AI provider configs from env vars.
 */
function buildAiProviderList() {
  const list = [];
  const aiBaseUrl = (process.env.AI_BASE_URL || '').trim().replace(/\/$/, '');
  const aiApiKey = (process.env.AI_API_KEY || '').trim();
  const aiModel = (process.env.AI_MODEL || '').trim();

  // 1) Explicit AI_BASE_URL (highest priority)
  if (aiBaseUrl && aiApiKey) {
    list.push({ label: 'AI_BASE_URL', baseUrl: aiBaseUrl, apiKey: aiApiKey, model: aiModel });
  }

  // 2) DeepSeek
  const dsKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (dsKey) {
    const dsUrl = (process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1').trim().replace(/\/$/, '');
    list.push({ label: 'DeepSeek', baseUrl: dsUrl, apiKey: dsKey, model: process.env.DEEPSEEK_MODEL || aiModel || 'deepseek-chat' });
  }

  // 3) OpenRouter
  const orKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (orKey) {
    list.push({ label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: orKey, model: aiModel || 'openai/gpt-4o-mini' });
  }

  // 4) OpenAI
  const oaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (oaiKey) {
    list.push({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: oaiKey, model: aiModel || 'gpt-4o-mini' });
  }

  return list;
}

/**
 * Post a chat completion, trying each provider in order.
 * Falls back to the next provider on 401/403/auth errors.
 */
async function postAiChatCompletionWithFallback({ timeoutMs, payload }) {
  const providers = buildAiProviderList();

  if (providers.length === 0) {
    console.error('[AI_MATCHMAKER] Missing API Key in .env');
    return { ok: false, status: 0 };
  }

  let lastResponse = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const model = process.env.AI_CHAT_MODEL || provider.model || 'deepseek-chat';

    if (i > 0) {
      console.warn(`[AI_MATCHMAKER] Falling back to ${provider.label}...`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          ...(provider.baseUrl.includes('openrouter.ai') ? { 'HTTP-Referer': process.env.AI_HTTP_REFERER || 'https://chappat.com', 'X-Title': process.env.AI_APP_NAME || 'ChappAt' } : {})
        },
        body: JSON.stringify({ model, ...payload })
      });

      clearTimeout(timeout);

      if (response.ok || (response.status !== 401 && response.status !== 403)) {
        return response;
      }

      const errBody = await response.text();
      console.error(`[AI_MATCHMAKER] ${provider.label} API Error: ${response.status} ${errBody}`);
      lastResponse = response;
    } catch (error) {
      clearTimeout(timeout);
      console.error(`[AI_MATCHMAKER] ${provider.label} request failed:`, error.message);
      lastResponse = { ok: false, status: 0, _error: error.message };
    }
  }

  return lastResponse || { ok: false, status: 0 };
}

// ============================================================
// HEURISTIC FALLBACKS (regex-based)
// ============================================================

function shouldRunMatchSearch(prompt, conversation) {
  const text = normalize(prompt);
  if (!text || hasUnderageDatingRequest(text)) return false;

  const explicitSearchRegex = /\b(tim|kiem|loc|goi y|de xuat|gioi thieu|match|mai moi|ket noi|recommend|suggest|find|search|show|kiem ban|kiem nguoi yeu|co ai|ai do|crush|muon hen ho|muon tim hieu|tim ban|tim nguoi)\b/;
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

// ============================================================
// DB QUERY & RANKING
// ============================================================

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
    if (hits.length) { score += Math.min(28, hits.length * 9); reasons.push(`Cùng vibe ${hits.slice(0, 2).join(', ')}`); }

    const dist = getDistanceKm(viewerLocation || normalizeLocation(viewer?.location), normalizeLocation(c?.location));
    if (dist !== null && dist <= (intent.radiusKm || 30)) { score += Math.max(4, 16 - dist / 3); reasons.push(`${Math.round(dist)}km gần bạn`); }

    if (c.isOnline) score += 4;
    if (c.profileUrl || c.photoURL) score += 4;

    return { user: c, percent: Math.min(99, Math.max(1, Math.round(score))), distanceKm: dist ? Number(dist.toFixed(1)) : undefined, reasons: [...new Set(reasons)].slice(0, 3) };
  }).filter(e => e.percent >= 35).sort((a, b) => b.percent - a.percent);
}

// ============================================================
// UTILS
// ============================================================

function hasUnderageDatingRequest(text = '') {
  const t = normalize(text);
  if (/\b(?:duoi|nho hon|under)\s*(1[0-7]|18)\b/.test(t)) return true;
  if (/\b(1[0-7])\s*(?:-|den|toi|->)\s*(1[0-7])\b/.test(t)) return true;
  const m = t.match(/\b(1[0-7])\s*(?:tuoi)?\b/);
  if (!m) return false;
  return !(Number(m[1]) === 17 && /\b(?:tren|lon hon|over)\s*$/.test(t.slice(Math.max(0, m.index - 16), m.index)));
}
function normalize(v) { return String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').trim(); }
function normalizeGender(v) { const g = normalize(v); return ['female', 'f', 'nu', 'girl'].includes(g) ? 'female' : ['male', 'm', 'nam', 'boy'].includes(g) ? 'male' : ''; }
function normalizeStringArray(v) { return !v ? [] : (Array.isArray(v) ? v : [v]).map(i => String(i || '').trim()).filter(Boolean); }
function normalizeLocation(v) { if (!v) return null; const lat = Number(v.latitude ?? v._latitude ?? v.lat), lng = Number(v.longitude ?? v._longitude ?? v.lng ?? v.lon); return (Number.isFinite(lat) && Number.isFinite(lng)) ? { latitude: lat, longitude: lng } : null; }
function getDistanceKm(f, t) { if (!f || !t) return null; const R = 6371, dLat = (t.latitude - f.latitude) * Math.PI / 180, dLon = (t.longitude - f.longitude) * Math.PI / 180, a = Math.sin(dLat / 2) ** 2 + Math.cos(f.latitude * Math.PI / 180) * Math.cos(t.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }
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
