/**
 * AI Matchmaker Routes
 * Turns a natural-language dating prompt into ranked Firestore user matches.
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

const INTEREST_ALIASES = [
  { value: 'Cafe', terms: ['cafe', 'coffee', 'ca phe', 'caphe', 'tra sua'] },
  { value: 'Du lich', terms: ['du lich', 'travel', 'phuot', 'trip', 'di choi xa'] },
  { value: 'Am nhac', terms: ['am nhac', 'music', 'hat', 'karaoke', 'concert'] },
  { value: 'Phim', terms: ['phim', 'movie', 'cinema', 'netflix'] },
  { value: 'Game', terms: ['game', 'gaming', 'esport'] },
  { value: 'Gym', terms: ['gym', 'fitness', 'tap gym', 'the thao'] },
  { value: 'Yoga', terms: ['yoga', 'thien'] },
  { value: 'Chay bo', terms: ['chay bo', 'running', 'marathon'] },
  { value: 'Sach', terms: ['sach', 'book', 'doc sach'] },
  { value: 'Chup anh', terms: ['chup anh', 'photography', 'photo'] },
  { value: 'An uong', terms: ['an uong', 'food', 'foodie', 'nau an'] },
  { value: 'Thu cung', terms: ['thu cung', 'pet', 'cho', 'meo'] },
  { value: 'Nghe thuat', terms: ['nghe thuat', 'art', 've tranh', 'design'] },
  { value: 'Startup', terms: ['startup', 'kinh doanh', 'business'] },
];

const CITY_ALIASES = [
  { value: 'Ho Chi Minh', terms: ['ho chi minh', 'hcm', 'sai gon', 'saigon', 'tphcm', 'tp hcm'] },
  { value: 'Ha Noi', terms: ['ha noi', 'hanoi'] },
  { value: 'Da Nang', terms: ['da nang', 'danang'] },
  { value: 'Can Tho', terms: ['can tho'] },
  { value: 'Nha Trang', terms: ['nha trang'] },
  { value: 'Da Lat', terms: ['da lat', 'dalat'] },
];

const STOPWORDS = new Set([
  'toi', 'minh', 'muon', 'tim', 'kiem', 'nguoi', 'ban', 'mot', 'ai', 'voi',
  'de', 'di', 'cho', 'co', 'la', 'o', 'gan', 'thich', 'hop', 'vui', 'nay',
  'hom', 'nay', 'can', 'gap', 'neu', 'nhung', 'cac', 'va', 'hoac', 'the',
]);

router.use(authMiddleware);

router.post('/search', async (req, res) => {
  const startedAt = Date.now();

  try {
    const uid = req.user.uid;
    const prompt = String(req.body?.prompt || '').trim();
    const conversation = normalizeConversation(req.body?.messages);
    const searchPrompt = buildConversationPrompt(conversation, prompt);
    const limit = clamp(Number(req.body?.limit) || DEFAULT_MATCH_LIMIT, 1, MAX_MATCH_LIMIT);
    const location = normalizeLocation(req.body?.location);

    if (prompt.length < 2) {
      return res.status(400).json({
        success: false,
        code: 'PROMPT_REQUIRED',
        error: 'Please describe who you want to meet.',
      });
    }

    if (prompt.length > 500) {
      return res.status(400).json({
        success: false,
        code: 'PROMPT_TOO_LONG',
        error: 'Prompt must be 500 characters or less.',
      });
    }

    const viewerSnap = await db.collection('users').doc(uid).get();
    if (!viewerSnap.exists) {
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        error: 'User not found',
      });
    }

    const viewer = { id: uid, ...viewerSnap.data() };
    const analysis = await analyzePrompt(searchPrompt, viewer);
    const clarifyingQuestion = buildClarifyingQuestion(analysis.intent, searchPrompt);

    if (clarifyingQuestion) {
      const assistantMessage = await composeAiAssistantMessage({
        conversation,
        prompt,
        viewer,
        intent: analysis.intent,
        matches: [],
        needsMoreInfo: true,
        fallback: clarifyingQuestion,
      });
      const suggestedReplies = buildSuggestedReplies(analysis.intent, searchPrompt);

      logMatchmakerRequest({
        uid,
        prompt: searchPrompt,
        intent: analysis.intent,
        source: analysis.source,
        resultCount: 0,
        latencyMs: Date.now() - startedAt,
        needsMoreInfo: true,
      }).catch((error) => {
        console.warn('[AI_MATCHMAKER] Failed to log request:', error.message);
      });

      return res.json({
        success: true,
        prompt,
        intent: analysis.intent,
        source: analysis.source,
        needsMoreInfo: true,
        assistantMessage,
        suggestedReplies,
        count: 0,
        matches: [],
      });
    }

    const candidates = await loadCandidates(uid, viewer, analysis.intent);
    const ranked = rankCandidates(candidates, viewer, analysis.intent, searchPrompt, location)
      .slice(0, limit);
    const matches = ranked.map(({ user, percent, reasons, distanceKm }) => ({
      ...toPublicUser(user),
      matchPercent: percent,
      matchScore: percent,
      matchReasons: reasons,
      distanceKm,
    }));

    const assistantMessage = await composeAiAssistantMessage({
      conversation,
      prompt,
      viewer,
      intent: analysis.intent,
      matches,
      needsMoreInfo: false,
      fallback: buildAssistantMessage(matches, analysis.intent, analysis.source),
    });

    logMatchmakerRequest({
      uid,
      prompt,
      intent: analysis.intent,
      source: analysis.source,
      resultCount: matches.length,
      latencyMs: Date.now() - startedAt,
    }).catch((error) => {
      console.warn('[AI_MATCHMAKER] Failed to log request:', error.message);
    });

    res.json({
      success: true,
      prompt,
      intent: analysis.intent,
      source: analysis.source,
      needsMoreInfo: false,
      assistantMessage,
      suggestedReplies: [],
      count: matches.length,
      matches,
    });
  } catch (error) {
    console.error('[AI_MATCHMAKER] Search error:', error);
    res.status(500).json({
      success: false,
      code: 'AI_MATCHMAKER_ERROR',
      error: 'Could not find matches right now. Please try again.',
    });
  }
});

async function analyzePrompt(prompt, viewer) {
  const fallbackIntent = buildHeuristicIntent(prompt);
  const apiKey = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return { intent: fallbackIntent, source: 'heuristic' };
  }

  try {
    const aiIntent = await callAiIntent(prompt, viewer, apiKey);
    return {
      intent: normalizeIntent({ ...fallbackIntent, ...aiIntent }),
      source: 'ai',
    };
  } catch (error) {
    console.warn('[AI_MATCHMAKER] AI intent failed, using heuristic fallback:', error.message);
    return { intent: fallbackIntent, source: 'heuristic' };
  }
}

async function postAiChatCompletion({ baseUrl, apiKey, timeoutMs, payload }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(baseUrl.includes('openrouter.ai') ? {
          'HTTP-Referer': process.env.AI_HTTP_REFERER || 'https://saigondating-server.onrender.com',
          'X-Title': process.env.AI_APP_NAME || 'Saigon Dating',
        } : {}),
      },
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getAiModelCandidates(primaryModel) {
  const fallbackModels = String(process.env.AI_MODEL_FALLBACKS || [
    'openai/gpt-oss-20b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-27b-it:free',
  ].join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return unique([primaryModel, ...fallbackModels]);
}

function shouldTryNextAiModel(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

async function callAiIntent(prompt, viewer, apiKey) {
  const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY);
  const baseUrl = (process.env.AI_BASE_URL || (hasOpenRouterKey
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const primaryModel = process.env.AI_MODEL || (hasOpenRouterKey ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');
  const models = getAiModelCandidates(primaryModel);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 8000);
  let lastError = null;

  for (const model of models) {
    const response = await postAiChatCompletion({
      baseUrl,
      apiKey,
      timeoutMs,
      payload: {
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You extract dating search intent for a Vietnamese dating app.',
              'Return compact JSON only. Do not include explanations.',
              'Schema: genders string[], minAge number|null, maxAge number|null, interests string[], jobs string[], educationLevels string[], cities string[], relationshipGoals string[], keywords string[], radiusKm number|null, personality string[], dealbreakers string[].',
              'Use normalized gender values: male, female.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              prompt,
              viewer: {
                gender: viewer?.gender || null,
                age: getAgeNumber(viewer?.age),
                interests: normalizeStringArray(viewer?.interests).slice(0, 12),
                city: viewer?.city || viewer?.locationName || null,
              },
            }),
          },
        ],
      },
    });

    if (response.ok) {
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI response was empty');
      return extractJson(content);
    }

    const body = await response.text().catch(() => '');
    lastError = new Error(`AI provider ${response.status} (${model}): ${body.slice(0, 160)}`);
    if (!shouldTryNextAiModel(response.status)) break;
  }

  throw lastError || new Error('AI provider failed');
}

async function callAiText(messages, apiKey, options = {}) {
  const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY);
  const baseUrl = (process.env.AI_BASE_URL || (hasOpenRouterKey
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const primaryModel = options.model || process.env.AI_CHAT_MODEL || process.env.AI_MODEL ||
    (hasOpenRouterKey ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');
  const models = getAiModelCandidates(primaryModel);
  const timeoutMs = Number(process.env.AI_CHAT_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 12000);
  let lastError = null;

  for (const model of models) {
    const response = await postAiChatCompletion({
      baseUrl,
      apiKey,
      timeoutMs,
      payload: {
        model,
        messages,
        temperature: options.temperature ?? 0.78,
        max_tokens: options.maxTokens ?? 180,
      },
    });

    if (response.ok) {
      const data = await response.json();
      return String(data?.choices?.[0]?.message?.content || '').trim();
    }

    const body = await response.text().catch(() => '');
    lastError = new Error(`AI chat provider ${response.status} (${model}): ${body.slice(0, 160)}`);
    if (!shouldTryNextAiModel(response.status)) break;
  }

  throw lastError || new Error('AI chat provider failed');
}

async function composeAiAssistantMessage({
  conversation,
  prompt,
  viewer,
  intent,
  matches,
  needsMoreInfo,
  fallback,
}) {
  const apiKey = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.AI_CHAT_ENABLED === 'false') return fallback;

  try {
    const recentMessages = normalizeConversation(conversation)
      .slice(-6)
      .map((item) => ({
        role: item.role,
        content: item.text.slice(0, 500),
      }));

    const content = await callAiText([
      {
        role: 'system',
        content: [
          'Bạn là AI Matchmaker trong app hẹn hò ChappAt.',
          'Trò chuyện bằng tiếng Việt tự nhiên, thân thiện, thông minh, giống một người tư vấn gu hẹn hò tinh tế.',
          'Không nói mình là mô hình, không nhắc JSON, điểm số, prompt, thuật toán hay dữ liệu hệ thống.',
          'Không bịa tên, tuổi, nghề hoặc thông tin hồ sơ cụ thể nếu payload không có.',
          'Nếu cần thêm thông tin, hỏi đúng 1 câu ngắn và gợi ý vài cách trả lời.',
          'Nếu đã có kết quả, nói như đang giới thiệu nhẹ nhàng: nêu số hồ sơ, vibe khớp chính, rồi mời user xem thử.',
          'Giữ câu trả lời dưới 55 từ, có cảm giác chat thật, không dùng danh sách dài.',
        ].join(' '),
      },
      ...recentMessages,
      {
        role: 'user',
        content: JSON.stringify({
          latestUserMessage: prompt,
          viewer: {
            gender: viewer?.gender || null,
            age: getAgeNumber(viewer?.age),
            city: viewer?.city || viewer?.locationName || null,
            interests: normalizeStringArray(viewer?.interests).slice(0, 8),
          },
          task: needsMoreInfo ? 'ask_one_follow_up_question' : 'respond_to_match_results',
          intent,
          result: {
            count: matches.length,
            topSignals: getIntentSignals(intent),
            topReasons: summarizeMatchReasons(matches),
          },
        }),
      },
    ], apiKey, {
      temperature: needsMoreInfo ? 0.82 : 0.72,
      maxTokens: needsMoreInfo ? 120 : 170,
    });

    return cleanAssistantMessage(content, fallback);
  } catch (error) {
    console.warn('[AI_MATCHMAKER] AI chat reply failed, using fallback:', error.message);
    return fallback;
  }
}

function buildHeuristicIntent(prompt) {
  const text = normalize(prompt);
  const genders = [];
  if (/\b(nu|gai|ban gai|female|girl|woman|co gai|em gai)\b/.test(text)) genders.push('female');
  if (/\b(nam|trai|ban trai|male|boy|man|anh trai)\b/.test(text)) genders.push('male');

  let minAge = null;
  let maxAge = null;
  const range = text.match(/\b(1[8-9]|[2-5]\d)\s*(?:-|den|toi|->)\s*(1[8-9]|[2-5]\d)\b/);
  if (range) {
    minAge = Number(range[1]);
    maxAge = Number(range[2]);
  } else {
    const under = text.match(/\b(?:duoi|nho hon|under)\s*(1[8-9]|[2-5]\d)\b/);
    const over = text.match(/\b(?:tren|lon hon|over)\s*(1[8-9]|[2-5]\d)\b/);
    const near = text.match(/\b(1[8-9]|[2-5]\d)\s*(?:tuoi)?\b/);
    if (under) maxAge = Number(under[1]);
    if (over) minAge = Number(over[1]);
    if (!under && !over && near) {
      const age = Number(near[1]);
      minAge = Math.max(18, age - 3);
      maxAge = age + 3;
    }
  }

  const interests = INTEREST_ALIASES
    .filter((entry) => entry.terms.some((term) => text.includes(term)))
    .map((entry) => entry.value);
  const cities = CITY_ALIASES
    .filter((entry) => entry.terms.some((term) => text.includes(term)))
    .map((entry) => entry.value);
  const relationshipGoals = [];
  if (/(nghiem tuc|lau dai|ket hon|serious|long term)/.test(text)) relationshipGoals.push('serious');
  if (/(hen ho|dating|date)/.test(text)) relationshipGoals.push('dating');
  if (/(ban be|friend|tam su|chat)/.test(text)) relationshipGoals.push('friendship');
  if (/(di cafe|cafe|coffee)/.test(text)) relationshipGoals.push('coffee date');

  const keywords = text
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .slice(0, 12);

  const radiusMatch = text.match(/\b(\d{1,3})\s*(?:km|kilomet)/);

  return normalizeIntent({
    genders,
    minAge,
    maxAge,
    interests,
    jobs: [],
    educationLevels: [],
    cities,
    relationshipGoals,
    keywords,
    radiusKm: radiusMatch ? Number(radiusMatch[1]) : null,
    personality: [],
    dealbreakers: [],
  });
}

function normalizeIntent(raw = {}) {
  const genders = normalizeStringArray(raw.genders)
    .map(normalizeGender)
    .filter(Boolean);

  let minAge = toNullableNumber(raw.minAge);
  let maxAge = toNullableNumber(raw.maxAge);
  if (minAge && maxAge && minAge > maxAge) {
    [minAge, maxAge] = [maxAge, minAge];
  }

  return {
    genders: unique(genders),
    minAge: minAge && minAge >= 18 ? minAge : null,
    maxAge: maxAge && maxAge >= 18 ? maxAge : null,
    interests: unique(normalizeStringArray(raw.interests)).slice(0, 12),
    jobs: unique(normalizeStringArray(raw.jobs)).slice(0, 8),
    educationLevels: unique(normalizeStringArray(raw.educationLevels)).slice(0, 8),
    cities: unique(normalizeStringArray(raw.cities)).slice(0, 6),
    relationshipGoals: unique(normalizeStringArray(raw.relationshipGoals)).slice(0, 8),
    keywords: unique(normalizeStringArray(raw.keywords)).slice(0, 14),
    radiusKm: toNullableNumber(raw.radiusKm),
    personality: unique(normalizeStringArray(raw.personality)).slice(0, 8),
    dealbreakers: unique(normalizeStringArray(raw.dealbreakers)).slice(0, 8),
  };
}

async function loadCandidates(uid, viewer, intent) {
  const candidateLimit = clamp(
    Number(process.env.AI_MATCHMAKER_CANDIDATE_LIMIT) || DEFAULT_CANDIDATE_LIMIT,
    50,
    MAX_CANDIDATE_LIMIT
  );
  const usersRef = db.collection('users');
  const byId = new Map();
  const addSnapshot = (snapshot) => {
    snapshot.docs.forEach((doc) => {
      if (doc.id !== uid) byId.set(doc.id, { id: doc.id, ...doc.data() });
    });
  };

  const tryQuery = async (query, label) => {
    try {
      const snapshot = await query.get();
      addSnapshot(snapshot);
    } catch (error) {
      console.warn(`[AI_MATCHMAKER] Candidate query failed (${label}):`, error.message);
    }
  };

  if (intent.interests.length > 0) {
    await tryQuery(
      usersRef.where('interests', 'array-contains-any', intent.interests.slice(0, 10)).limit(candidateLimit),
      'interests'
    );
  }

  if (intent.genders.length === 1) {
    await tryQuery(
      usersRef.where('gender', '==', intent.genders[0]).limit(candidateLimit),
      'gender'
    );
  }

  if (byId.size < Math.min(candidateLimit, 80)) {
    await tryQuery(usersRef.limit(candidateLimit), 'general');
  }

  return Array.from(byId.values()).filter((candidate) => isDiscoverableCandidate(candidate, viewer, uid));
}

function rankCandidates(candidates, viewer, intent, prompt, viewerLocation) {
  const promptText = normalize(prompt);
  const viewerInterestNorm = normalizeStringArray(viewer?.interests).map(normalize);

  return candidates
    .map((candidate) => {
      const candidateText = getSearchText(candidate);
      const candidateAge = getAgeNumber(candidate.age);
      const candidateGender = normalizeGender(candidate.gender);
      const candidateInterests = normalizeStringArray(candidate.interests);
      const candidateInterestNorm = candidateInterests.map(normalize);
      const reasons = [];
      let score = 36;

      if (intent.genders.length > 0) {
        if (candidateGender && intent.genders.includes(candidateGender)) {
          score += 20;
          reasons.push(candidateGender === 'female' ? 'Dung gioi tinh ban tim' : 'Dung gioi tinh ban tim');
        } else {
          score -= 35;
        }
      } else if (viewer?.gender && candidateGender && viewer.gender !== candidateGender) {
        score += 3;
      }

      if (candidateAge) {
        if (intent.minAge && candidateAge >= intent.minAge) score += 5;
        if (intent.maxAge && candidateAge <= intent.maxAge) score += 5;
        if (intent.minAge && candidateAge < intent.minAge) score -= Math.min(18, (intent.minAge - candidateAge) * 3);
        if (intent.maxAge && candidateAge > intent.maxAge) score -= Math.min(18, (candidateAge - intent.maxAge) * 3);
        if (
          (!intent.minAge || candidateAge >= intent.minAge) &&
          (!intent.maxAge || candidateAge <= intent.maxAge) &&
          (intent.minAge || intent.maxAge)
        ) {
          reasons.push('Hop do tuoi mong muon');
        }
      }

      const interestHits = intent.interests.filter((interest) => {
        const term = normalize(interest);
        return candidateInterestNorm.some((item) => item.includes(term) || term.includes(item)) ||
          candidateText.includes(term);
      });
      if (interestHits.length) {
        score += Math.min(28, interestHits.length * 9);
        reasons.push(`Cung vibe ${interestHits.slice(0, 2).join(', ')}`);
      }

      const viewerShared = candidateInterestNorm.filter((interest) => viewerInterestNorm.includes(interest));
      if (viewerShared.length) {
        score += Math.min(10, viewerShared.length * 3);
        if (!interestHits.length) reasons.push('Co so thich giong ban');
      }

      const keywordHits = intent.keywords.filter((keyword) => {
        const term = normalize(keyword);
        return term.length > 2 && candidateText.includes(term);
      });
      if (keywordHits.length) {
        score += Math.min(24, keywordHits.length * 5);
        reasons.push(`Khop tu khoa ${keywordHits.slice(0, 2).join(', ')}`);
      }

      const cityHit = intent.cities.find((city) => candidateText.includes(normalize(city)));
      if (cityHit) {
        score += 12;
        reasons.push(`Gan khu vuc ${cityHit}`);
      }

      const jobHit = intent.jobs.find((job) => candidateText.includes(normalize(job)));
      if (jobHit) {
        score += 8;
        reasons.push(`Nghe nghiep phu hop`);
      }

      const educationHit = intent.educationLevels.find((item) => candidateText.includes(normalize(item)));
      if (educationHit) {
        score += 6;
        reasons.push('Hoc van phu hop');
      }

      const goalHit = intent.relationshipGoals.find((goal) => candidateText.includes(normalize(goal)));
      if (goalHit) {
        score += 7;
        reasons.push('Muc tieu ket noi gan nhau');
      }

      const distanceKm = getDistanceKm(viewerLocation || normalizeLocation(viewer?.location), normalizeLocation(candidate?.location));
      if (distanceKm !== null) {
        const radiusKm = intent.radiusKm || 30;
        if (distanceKm <= radiusKm) {
          score += Math.max(4, 16 - distanceKm / 3);
          reasons.push(`${Math.round(distanceKm)}km gan ban`);
        } else if (intent.radiusKm) {
          score -= Math.min(24, (distanceKm - intent.radiusKm) / 2);
        }
      }

      if (candidate.isOnline) score += 4;
      if (candidate.profileCompleted === true) score += 4;
      if (candidate.profileUrl || candidate.photoURL || candidate.avatarUrl) score += 4;
      if (promptText && candidateText.includes(promptText)) score += 8;

      const percent = clamp(Math.round(score), 1, 99);
      return {
        user: candidate,
        percent,
        distanceKm: distanceKm === null ? undefined : Number(distanceKm.toFixed(1)),
        reasons: unique(reasons).slice(0, 3),
      };
    })
    .filter((entry) => entry.percent >= 35)
    .sort((a, b) => b.percent - a.percent);
}

function isDiscoverableCandidate(candidate, viewer, viewerUid) {
  if (!candidate) return false;
  if (candidate.isDeleted || candidate.deleted || candidate.disabled || candidate.banned || candidate.isBanned) return false;
  if (candidate.profileVisible === false || candidate.discoverable === false || candidate.isDiscoverable === false) return false;

  const candidateUid = candidate.id || candidate.uid;
  if (isUidIncluded(viewer?.blockedUsers, candidateUid) || isUidIncluded(viewer?.blockedUserIds, candidateUid)) return false;
  if (isUidIncluded(candidate?.blockedUsers, viewerUid) || isUidIncluded(candidate?.blockedUserIds, viewerUid)) return false;

  const hasBasics = candidate.profileCompleted === true ||
    Boolean(candidate.username && candidate.gender && candidate.age != null && (candidate.profileUrl || candidate.photoURL || candidate.avatarUrl));

  return hasBasics;
}

function toPublicUser(user) {
  const location = normalizeLocation(user.location);

  return {
    id: user.id || user.uid,
    uid: user.uid || user.id,
    username: user.username || user.displayName || user.name || 'ChappAt user',
    displayName: user.displayName || user.username || user.name || '',
    age: getAgeNumber(user.age) || user.age || null,
    gender: normalizeGender(user.gender) || user.gender || null,
    profileUrl: user.profileUrl || '',
    photoURL: user.photoURL || '',
    avatarUrl: user.avatarUrl || '',
    bio: user.bio || '',
    job: user.job || '',
    educationLevel: user.educationLevel || '',
    university: user.university || '',
    city: user.city || '',
    locationName: user.locationName || '',
    interests: normalizeStringArray(user.interests).slice(0, 12),
    currentVibe: user.currentVibe || null,
    vibeStatus: user.vibeStatus || '',
    statusMessage: user.statusMessage || '',
    isOnline: Boolean(user.isOnline),
    lastActiveAt: serializeDate(user.lastActiveAt || user.lastSeen || user.updatedAt),
    location,
  };
}

function buildAssistantMessage(matches, intent, source) {
  if (!matches.length) {
    return 'Mình chưa thấy hồ sơ nào thật sự hợp. Bạn thử nới rộng tuổi, khu vực hoặc thêm vài sở thích nhé.';
  }

  const topSignals = [
    intent.genders.length ? 'giới tính' : '',
    intent.interests.length ? 'sở thích' : '',
    intent.minAge || intent.maxAge ? 'độ tuổi' : '',
    intent.cities.length ? 'khu vực' : '',
  ].filter(Boolean);
  const signalText = topSignals.length ? ` theo ${topSignals.join(', ')}` : '';
  const suffix = source === 'ai' ? 'Mình lọc được' : 'Mình tìm được';
  return `${suffix} ${matches.length} hồ sơ khá hợp${signalText}. Bạn xem thử vibe nào chạm nhất nhé.`;
}

function buildClarifyingQuestion(intent, prompt = '') {
  const text = normalize(prompt);
  const flexibleGender = /(khong gioi han|mo rong|ai cung duoc|khong quan trong|tat ca)/.test(text);
  const signals = [
    intent.genders.length > 0 || flexibleGender,
    Boolean(intent.minAge || intent.maxAge),
    intent.interests.length > 0,
    intent.cities.length > 0,
    intent.relationshipGoals.length > 0,
    intent.jobs.length > 0,
    intent.personality.length > 0,
    intent.keywords.length >= 3,
  ].filter(Boolean).length;

  if (signals >= 2) return '';

  if (!intent.genders.length && !flexibleGender) {
    return 'Để mình tìm đúng gu hơn: bạn muốn gặp nam, nữ hay để mở rộng?';
  }

  if (!intent.minAge && !intent.maxAge) {
    return 'Oke, mình hiểu hướng rồi. Bạn thích khoảng tuổi nào, và vibe kiểu chill, nghiêm túc hay đi chơi trước?';
  }

  return 'Bạn thêm giúp mình khu vực hoặc 1-2 sở thích nhé, mình sẽ lọc sát hơn.';
}

function buildSuggestedReplies(intent, prompt = '') {
  const text = normalize(prompt);
  const flexibleGender = /(khong gioi han|mo rong|ai cung duoc|khong quan trong|tat ca)/.test(text);

  if (!intent.genders.length && !flexibleGender) {
    return ['Không giới hạn', 'Nữ 22-28 ở Sài Gòn', 'Nam thích cafe'];
  }

  if (!intent.minAge && !intent.maxAge) {
    return ['22-28 tuổi', '25-32 tuổi', 'Chill trước rồi tính'];
  }

  if (!intent.interests.length && !intent.relationshipGoals.length) {
    return ['Thích cafe và phim', 'Nghiêm túc lâu dài', 'Đi chơi cuối tuần'];
  }

  return [];
}

function getIntentSignals(intent) {
  return [
    intent.genders.length ? `gender:${intent.genders.join(',')}` : '',
    intent.minAge || intent.maxAge ? `age:${intent.minAge || '?'}-${intent.maxAge || '?'}` : '',
    intent.interests.length ? `interests:${intent.interests.slice(0, 4).join(',')}` : '',
    intent.cities.length ? `cities:${intent.cities.slice(0, 3).join(',')}` : '',
    intent.relationshipGoals.length ? `goals:${intent.relationshipGoals.slice(0, 3).join(',')}` : '',
  ].filter(Boolean);
}

function summarizeMatchReasons(matches) {
  return unique(
    matches
      .flatMap((match) => normalizeStringArray(match.matchReasons))
      .slice(0, 8)
  );
}

function cleanAssistantMessage(content, fallback) {
  const message = String(content || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!message) return fallback;
  return message.length > 420 ? `${message.slice(0, 417).trim()}...` : message;
}

function normalizeConversation(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-8)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      text: String(item?.text || item?.content || '').trim(),
    }))
    .filter((item) => item.text)
    .slice(-8);
}

function buildConversationPrompt(conversation, prompt) {
  const parts = conversation
    .filter((item) => item.role === 'user')
    .map((item) => item.text);

  if (!parts.length || parts[parts.length - 1] !== prompt) {
    parts.push(prompt);
  }

  return parts.join('\n');
}

async function logMatchmakerRequest(payload) {
  await db.collection('aiMatchmakerRequests').add({
    ...payload,
    createdAt: Timestamp.now(),
  });
}

function getSearchText(user) {
  const vibe = user?.currentVibe?.vibe || user?.currentVibe || {};
  return normalize([
    user?.username,
    user?.displayName,
    user?.name,
    user?.bio,
    user?.job,
    user?.educationLevel,
    user?.university,
    user?.city,
    user?.locationName,
    user?.lookingFor,
    user?.relationshipGoal,
    user?.statusMessage,
    user?.vibeStatus,
    vibe?.name,
    vibe?.label,
    Array.isArray(user?.interests) ? user.interests.join(' ') : '',
  ].join(' '));
}

function extractJson(content) {
  if (typeof content !== 'string') return {};
  try {
    return JSON.parse(content);
  } catch (_) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response did not contain JSON');
    return JSON.parse(match[0]);
  }
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .trim();
}

function normalizeGender(value) {
  const gender = normalize(value);
  if (['female', 'f', 'nu', 'nữ', 'girl', 'woman'].includes(gender)) return 'female';
  if (['male', 'm', 'nam', 'boy', 'man'].includes(gender)) return 'male';
  return '';
}

function normalizeStringArray(value) {
  if (!value) return [];
  const source = Array.isArray(value) ? value : [value];
  return source
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeLocation(value) {
  if (!value) return null;
  const latitude = Number(value.latitude ?? value._latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value._longitude ?? value.lng ?? value.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function getDistanceKm(from, to) {
  if (!from || !to) return null;
  const earthKm = 6371;
  const dLat = degreesToRadians(to.latitude - from.latitude);
  const dLon = degreesToRadians(to.longitude - from.longitude);
  const lat1 = degreesToRadians(from.latitude);
  const lat2 = degreesToRadians(to.latitude);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value) {
  return value * (Math.PI / 180);
}

function getAgeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) return ageFromDate(parsedDate);
  }
  if (value instanceof Date) return ageFromDate(value);
  if (value?.toDate && typeof value.toDate === 'function') return ageFromDate(value.toDate());
  return null;
}

function ageFromDate(date) {
  const now = new Date();
  let years = now.getFullYear() - date.getFullYear();
  const monthDelta = now.getMonth() - date.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < date.getDate())) years -= 1;
  return years > 0 ? years : null;
}

function toNullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serializeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (value?.toDate && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function isUidIncluded(value, uid) {
  if (!uid || !value) return false;
  if (Array.isArray(value)) return value.includes(uid);
  if (typeof value === 'object') return Boolean(value[uid]);
  if (typeof value === 'string') return value === uid;
  return false;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = router;
