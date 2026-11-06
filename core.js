"use strict";

// Core logic for LLM Voice.
// Runs in the browser as window.LlmVoice and in Node for tests.
// No network code lives here. The page layer passes raw model responses
// in and this module parses scores, resolves marker spans in the source
// text, and builds the highlighted segments the page renders.
// Model list snapshot from https://gen.pollinations.ai/v1/models on
// 2026-11-06. Every default model is not paid-only, so a free tier
// (tier Pollen) key can call each one.

var API_BASE = "https://gen.pollinations.ai";
var STORAGE_KEY = "llm_voice_pollinations_key";

var MODELS = [
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano", paidOnly: false, isDefault: true },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", paidOnly: false, isDefault: false },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", paidOnly: false, isDefault: false },
  { id: "mistralai/mistral-large-3", label: "Mistral Large 3", paidOnly: false, isDefault: false },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", paidOnly: false, isDefault: false },
  { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B", paidOnly: false, isDefault: false }
];

function getModel(id) {
  for (var i = 0; i < MODELS.length; i++) {
    if (MODELS[i].id === id) return MODELS[i];
  }
  return null;
}

// Local format check only. The live check happens in the page against
// /account/balance. Keys are secret (sk_) or publishable (pk_).
function validateKey(key) {
  if (typeof key !== "string") return { ok: false, error: "Key must be text." };
  var trimmed = key.trim();
  if (trimmed.length === 0) return { ok: false, error: "No key entered." };
  if (/\s/.test(trimmed)) return { ok: false, error: "Key contains spaces." };
  if (!/^(sk_|pk_)/.test(trimmed)) return { ok: false, error: "Key should start with sk_ or pk_." };
  if (trimmed.length < 20) return { ok: false, error: "Key looks too short." };
  return { ok: true, key: trimmed };
}

// One request shape for every call this app makes. Reasoning models need
// reasoning_effort low and a generous max_tokens or they burn the whole
// budget on hidden reasoning and return a token exhaustion error.
function buildChatRequest(modelId, messages) {
  return {
    model: getModel(modelId) ? modelId : MODELS[0].id,
    messages: messages,
    reasoning_effort: "low",
    max_tokens: 4000
  };
}

// Normalise an OpenAI style chat completion response.
function parseChatResponse(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Empty response from the API." };
  }
  if (data.error) {
    var msg = (data.error && data.error.message) || "API error.";
    return { ok: false, error: String(msg) };
  }
  var choice = (data.choices || [])[0];
  if (!choice || !choice.message) {
    return { ok: false, error: "Response had no answer." };
  }
  var content = choice.message.content;
  var text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map(function (part) {
      if (typeof part === "string") return part;
      return part && typeof part.text === "string" ? part.text : "";
    }).join("");
  }
  text = text.trim();
  if (!text) return { ok: false, error: "Model returned an empty answer." };
  return { ok: true, text: text, finishReason: choice.finish_reason || null };
}

// Scores arrive as 72, "72", "72/100", "72%", or a 0.72 fraction.
// Fractions at or below 1 are read as a share of 100, except an explicit
// 0 or 1, which are read the same way (0 and 100 would be wrong for 1,
// so 1 is treated as a fraction too; a model that means a score of 1
// out of 100 should send 1/100). Returns an integer 0 to 100, or null.
function parseScore(value) {
  if (value === null || value === undefined || value === "") return null;
  var n;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    var cleaned = value.trim().replace(/%$/, "");
    var slash = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (slash) {
      var top = Number(slash[1]);
      var bottom = Number(slash[2]);
      if (!isFinite(top) || !isFinite(bottom) || bottom === 0) return null;
      n = (top / bottom) * 100;
    } else {
      n = Number(cleaned);
    }
  } else {
    return null;
  }
  if (!isFinite(n)) return null;
  if (n > 0 && n <= 1) n = n * 100;
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n);
}

function scoreBand(score) {
  if (score === null || score === undefined) return "No score";
  if (score < 25) return "Mostly human";
  if (score < 50) return "Some LLM tells";
  if (score < 75) return "Strong LLM voice";
  return "Full LLM voice";
}

// Pull the first JSON object out of a model reply: bare JSON, a code
// fence, or JSON surrounded by prose. Returns null when there is none.
function extractJsonObject(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  var text = raw.trim();
  if (!text) return null;
  var fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  var start = text.indexOf("{");
  var end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function cleanText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen || 500);
}

// Parse a model analysis reply into a stable shape:
// { ok, score, band, summary, markers: [{ type, quote, explanation }] }
// Accepts the documented field names plus the common alternates models
// drift to. Markers without an exact quote are dropped, because a marker
// that cannot be pointed at in the text cannot be highlighted.
// Duplicate quotes are dropped. At most 50 markers are kept.
function parseAnalysis(raw) {
  var obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "Analysis was not valid JSON.", score: null, band: scoreBand(null), summary: "", markers: [] };
  }
  var score = parseScore(
    obj.score !== undefined ? obj.score
      : obj.overall_score !== undefined ? obj.overall_score
      : obj.overallScore !== undefined ? obj.overallScore
      : obj.llm_voice_score !== undefined ? obj.llm_voice_score
      : obj.llmVoiceScore
  );
  var rawMarkers = Array.isArray(obj.markers) ? obj.markers
    : Array.isArray(obj.findings) ? obj.findings
    : Array.isArray(obj.tells) ? obj.tells
    : [];
  var seen = {};
  var markers = [];
  rawMarkers.forEach(function (m) {
    if (!m || typeof m !== "object") return;
    var quote = cleanText(m.quote !== undefined ? m.quote : m.text !== undefined ? m.text : m.example, 300);
    if (!quote) return;
    var dedupeKey = quote.toLowerCase();
    if (seen[dedupeKey]) return;
    seen[dedupeKey] = true;
    markers.push({
      type: cleanText(m.type !== undefined ? m.type : m.name !== undefined ? m.name : m.marker !== undefined ? m.marker : m.category, 80) || "LLM tell",
      quote: quote,
      explanation: cleanText(m.explanation !== undefined ? m.explanation : m.reason !== undefined ? m.reason : m.why, 500)
    });
  });
  markers = markers.slice(0, 50);
  return {
    ok: true,
    score: score,
    band: scoreBand(score),
    summary: cleanText(obj.summary !== undefined ? obj.summary : obj.verdict, 600),
    markers: markers
  };
}

// Parse a rewrite reply: strict JSON {"rewrite": "..."} when the model
// cooperates, the fenced or plain text as-is when it does not.
function parseRewrite(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Rewrite was empty.", text: "" };
  }
  var obj = extractJsonObject(raw);
  if (obj && typeof obj === "object") {
    var fromJson = obj.rewrite || obj.text || obj.result || obj.humanised || obj.humanized || obj.llm_voice;
    if (typeof fromJson === "string" && fromJson.trim()) {
      return { ok: true, text: fromJson.trim() };
    }
  }
  var text = raw.trim();
  var fence = text.match(/```(?:[a-z]+)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(rewrite|humanised|humanized|llm voice version)\s*:\s*/i, "");
  if (!text) return { ok: false, error: "Rewrite was empty.", text: "" };
  return { ok: true, text: text };
}

// Find one quote in the source text. Exact match first, then a
// case-insensitive match. Searches from fromIndex so repeated quotes
// can be assigned to successive occurrences. Returns {start, end} or null.
function findQuoteSpan(text, quote, fromIndex) {
  if (typeof text !== "string" || typeof quote !== "string" || !quote) return null;
  var from = fromIndex || 0;
  var exact = text.indexOf(quote, from);
  if (exact !== -1) return { start: exact, end: exact + quote.length };
  var lowerText = text.toLowerCase();
  var lowerQuote = quote.toLowerCase();
  var folded = lowerText.indexOf(lowerQuote, from);
  if (folded !== -1) return { start: folded, end: folded + quote.length };
  if (from > 0) {
    // A repeated quote may only remain earlier in the text. Fall back to
    // the first occurrence so the marker still highlights somewhere true.
    var firstExact = text.indexOf(quote);
    if (firstExact !== -1) return { start: firstExact, end: firstExact + quote.length };
    var firstFolded = lowerText.indexOf(lowerQuote);
    if (firstFolded !== -1) return { start: firstFolded, end: firstFolded + quote.length };
  }
  return null;
}

// Attach a span to every marker. Markers whose quote is not in the text
// get start and end of -1 and stay in the list, unhighlighted.
// A quote that appears more than once is assigned to successive
// occurrences when there are successive markers quoting it.
function resolveMarkerSpans(text, markers) {
  var source = typeof text === "string" ? text : "";
  var cursors = {};
  return (markers || []).map(function (m, index) {
    var quote = m && typeof m.quote === "string" ? m.quote : "";
    var key = quote.toLowerCase();
    var from = cursors[key] || 0;
    var span = findQuoteSpan(source, quote, from);
    if (span) cursors[key] = span.end;
    return {
      index: index,
      type: m && m.type ? m.type : "LLM tell",
      quote: quote,
      explanation: m && m.explanation ? m.explanation : "",
      start: span ? span.start : -1,
      end: span ? span.end : -1
    };
  });
}

// Split the source text into plain and highlighted segments.
// Segments always join back to the exact source text. When two markers
// overlap, the one that starts first wins, and the longer one wins a
// tie. Markers fully inside a claimed span are skipped for highlighting
// but stay in the marker list.
function buildHighlightedSegments(text, markers) {
  var source = typeof text === "string" ? text : "";
  if (!source) return [];
  var resolved = (markers || []).filter(function (m) {
    return m && m.start >= 0 && m.end > m.start && m.end <= source.length;
  }).slice().sort(function (a, b) {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });
  var claimed = [];
  var segments = [];
  var pos = 0;
  resolved.forEach(function (m) {
    if (m.start < pos) return; // overlaps a span that was already claimed
    if (m.start > pos) segments.push({ text: source.slice(pos, m.start), markerIndex: null, type: null });
    segments.push({ text: source.slice(m.start, m.end), markerIndex: m.index, type: m.type || null });
    claimed.push(m);
    pos = m.end;
  });
  if (pos < source.length) segments.push({ text: source.slice(pos), markerIndex: null, type: null });
  return segments;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Local marker dictionary. Used by demo mode, which runs with no key and
// no model call, and covered by tests so the phrases stay stable.
// Each entry: phrase to scan for, marker type, plain explanation, and
// the plain replacement the local humanise pass uses, when one fits.
var LOCAL_PATTERNS = [
  { phrase: "in today's fast-paced world", type: "Stock opener", explanation: "A generic scene setting opener that says nothing about this specific topic.", replacement: "" },
  { phrase: "it is important to note that", type: "Hedging filler", explanation: "Announces importance instead of just stating the point.", replacement: "" },
  { phrase: "it's important to note that", type: "Hedging filler", explanation: "Announces importance instead of just stating the point.", replacement: "" },
  { phrase: "delve into", type: "Stock verb", explanation: "Delve is a signature LLM verb. People usually say look at, check, or read.", replacement: "look at" },
  { phrase: "delve", type: "Stock verb", explanation: "Delve is a signature LLM verb. People usually say dig in or look closely.", replacement: "dig in" },
  { phrase: "furthermore", type: "Connector stacking", explanation: "Formal connector stacking. Plain writing uses also, and, or nothing.", replacement: "Also" },
  { phrase: "moreover", type: "Connector stacking", explanation: "Formal connector stacking. Plain writing uses also, and, or nothing.", replacement: "Also" },
  { phrase: "additionally", type: "Connector stacking", explanation: "Formal connector stacking where a new sentence would do.", replacement: "Also" },
  { phrase: "in conclusion", type: "Formula ending", explanation: "Announces the ending instead of ending. A school essay habit models copy.", replacement: "" },
  { phrase: "in summary", type: "Formula ending", explanation: "Announces a summary instead of giving one in plain words.", replacement: "" },
  { phrase: "a wide range of", type: "Vague quantity", explanation: "Sounds precise, says nothing. A number or a short list says more.", replacement: "many" },
  { phrase: "plays a crucial role", type: "Stock phrasing", explanation: "Crucial role phrasing shows up in model text far more than in human text.", replacement: "matters" },
  { phrase: "plays a vital role", type: "Stock phrasing", explanation: "Vital role phrasing shows up in model text far more than in human text.", replacement: "matters" },
  { phrase: "when it comes to", type: "Filler frame", explanation: "A frame that delays the actual subject by four words.", replacement: "For" },
  { phrase: "not only", type: "Balanced pair setup", explanation: "Sets up the not only, but also pair models reach for by default. Check the full pair in the text.", replacement: "Both" },
  { phrase: "tapestry", type: "Stock noun", explanation: "Tapestry as a metaphor for anything complex is a well known model habit.", replacement: "mix" },
  { phrase: "landscape", type: "Stock noun", explanation: "Landscape used for any field or market is stock model phrasing.", replacement: "field" },
  { phrase: "ever-evolving", type: "Stock adjective", explanation: "Ever-evolving is a stock intensifier that adds no information.", replacement: "changing" },
  { phrase: "robust", type: "Stock adjective", explanation: "Robust is applied to almost anything in model text, so it reads as a tell.", replacement: "solid" },
  { phrase: "leverage", type: "Stock verb", explanation: "Leverage as a verb for use is corporate model phrasing.", replacement: "use" },
  { phrase: "utilize", type: "Stock verb", explanation: "Utilize where use fits is a classic formality tell.", replacement: "use" },
  { phrase: "foster", type: "Stock verb", explanation: "Foster for build or encourage is stock model word choice.", replacement: "build" },
  { phrase: "ultimately", type: "Hedging filler", explanation: "A soft landing word that often carries no meaning in the sentence.", replacement: "" },
  { phrase: "that being said", type: "Hedging filler", explanation: "A pivot phrase models use to soften a point they then state anyway.", replacement: "Still" },
  { phrase: "however, it is", type: "Hedging frame", explanation: "A hedged however frame. Plain writing states the contrast directly.", replacement: "But it is" }
];

// Scan text with the local dictionary. Deterministic, case-insensitive,
// longest phrases first, no overlapping spans. Returns markers in the
// same shape parseAnalysis returns, plus start and end.
function findLocalMarkers(text) {
  var source = typeof text === "string" ? text : "";
  if (!source) return [];
  var lower = source.toLowerCase();
  var patterns = LOCAL_PATTERNS.slice().sort(function (a, b) { return b.phrase.length - a.phrase.length; });
  var found = [];
  var claimed = [];
  patterns.forEach(function (p) {
    var from = 0;
    while (from < lower.length) {
      var idx = lower.indexOf(p.phrase, from);
      if (idx === -1) break;
      var end = idx + p.phrase.length;
      var overlaps = claimed.some(function (c) { return idx < c.end && end > c.start; });
      if (!overlaps) {
        claimed.push({ start: idx, end: end });
        found.push({
          type: p.type,
          quote: source.slice(idx, end),
          explanation: p.explanation,
          start: idx,
          end: end
        });
      }
      from = end;
    }
  });
  found.sort(function (a, b) { return a.start - b.start; });
  return found.map(function (m, i) {
    return { index: i, type: m.type, quote: m.quote, explanation: m.explanation, start: m.start, end: m.end };
  });
}

// Heuristic demo score: marker count weighted by text length. Demo mode
// only. It is labelled a sample score in the page, never a model result.
function demoScore(text, markers) {
  var words = (String(text || "").trim().match(/\S+/g) || []).length;
  if (!words || !markers || markers.length === 0) return 0;
  var perHundred = (markers.length / words) * 100;
  var score = Math.round(20 + perHundred * 18);
  if (score > 96) score = 96;
  return score;
}

// Local demo humanise pass: swap the stock phrases the dictionary knows
// for the plain replacements, tidy the spaces and capitalise sentence
// starts left lower case by a removal. Meaning stays, polish does not.
function humaniseLocally(text) {
  var out = String(text || "");
  var patterns = LOCAL_PATTERNS.slice().sort(function (a, b) { return b.phrase.length - a.phrase.length; });
  patterns.forEach(function (p) {
    var needle = p.phrase;
    var lower = out.toLowerCase();
    var result = "";
    var from = 0;
    while (from < out.length) {
      var idx = lower.indexOf(needle, from);
      if (idx === -1) { result += out.slice(from); break; }
      result += out.slice(from, idx);
      var original = out.slice(idx, idx + needle.length);
      var rep = p.replacement;
      if (rep && /^[A-Z]/.test(original)) rep = rep.charAt(0).toUpperCase() + rep.slice(1);
      result += rep;
      from = idx + needle.length;
      lower = out.toLowerCase();
    }
    out = result;
  });
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\s+([,.;:!?])/g, "$1");
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, function (m, head, ch) { return head + ch.toUpperCase(); });
  return out.trim();
}

// Local demo reverse pass: dress plain text up in full LLM voice using
// the stock moves, so the contrast is visible with no key and no call.
function llmifyLocally(text) {
  var body = String(text || "").trim();
  if (!body) return "";
  return [
    "In today's fast-paced world, it is important to note that " + body.charAt(0).toLowerCase() + body.slice(1),
    "Furthermore, this plays a crucial role in the ever-evolving landscape, and it is worth delving into the details to gain a robust understanding.",
    "In conclusion, by leveraging a wide range of approaches, we can foster meaningful outcomes. Ultimately, this rich tapestry speaks for itself."
  ].join("\n\n");
}

function buildAnalysisPrompt(text) {
  return [
    "You analyse text for the LLM voice: the recognisable style of text written by large language models.",
    "Markers include hedging (it is important to note, ultimately), stock words (delve, tapestry, robust, leverage, utilize, foster), connector stacking (furthermore, moreover, additionally), formula openers and endings (in today's fast-paced world, in conclusion), vague quantity (a wide range of), balanced pairs (not only, but also), bullet everything structure, and flat even tone with no specific detail.",
    "Reply with strict JSON only. No code fence, no extra text.",
    'Shape: {"score": 0, "summary": "one or two plain sentences", "markers": [{"type": "short marker name", "quote": "exact quote copied from the text", "explanation": "one plain sentence on why this is an LLM tell"}]}',
    "Rules: score is an integer from 0 (clearly human) to 100 (full LLM voice). Every quote must be copied exactly from the text, character for character, so it can be highlighted. At most 12 markers. If there are no markers, return an empty markers list and a low score.",
    "",
    "Text to analyse:",
    String(text || "")
  ].join("\n");
}

function buildHumanisePrompt(text, markers) {
  var list = (markers || []).map(function (m) { return "- " + m.type + ": " + m.quote; }).join("\n");
  return [
    "Rewrite the text below so it reads like a person wrote it. Remove the LLM voice markers: hedging, stock words like delve and furthermore, connector stacking, formula openers and endings, vague quantity, and flat even tone.",
    "Keep every fact and the full meaning. Keep roughly the same length. Write plain, direct sentences. Vary sentence length. Do not add new claims, do not add a summary, and do not comment on the rewrite.",
    'Reply with strict JSON only: {"rewrite": "the rewritten text"}',
    list ? "\nMarkers to remove:\n" + list : "",
    "\nText:\n" + String(text || "")
  ].join("\n");
}

function buildLlmVoicePrompt(text) {
  return [
    "Rewrite the plain human text below in full LLM voice, for fun and comparison. Lay it on thick: hedging, stock words (delve, tapestry, robust, leverage), connector stacking (furthermore, moreover), a formula opener, a balanced not only, but also pair, vague quantity, and a formula ending (in conclusion).",
    "Keep the facts and meaning. Keep roughly the same length. Do not comment on the rewrite.",
    'Reply with strict JSON only: {"rewrite": "the rewritten text"}',
    "\nText:\n" + String(text || "")
  ].join("\n");
}

// Demo data. Shown only in demo mode (no key), always under a banner
// that says it is sample data and no model was called.
var DEMO_INPUT = "In today's fast-paced world, it is important to note that remote work has changed how teams communicate. Furthermore, companies must leverage a wide range of robust tools to foster collaboration. Moreover, the ever-evolving landscape of work means that flexibility plays a crucial role in retention. In conclusion, by delving into these trends, organisations can ultimately build a rich tapestry of distributed culture.";

var DEMO_ANALYSIS = {
  score: 88,
  summary: "Sample analysis. Almost every sentence carries a stock phrase or a hedge, and there is no specific detail anywhere in the text.",
  markers: [
    { type: "Stock opener", quote: "In today's fast-paced world", explanation: "A generic scene setting opener that says nothing about this specific topic." },
    { type: "Hedging filler", quote: "it is important to note that", explanation: "Announces importance instead of just stating the point." },
    { type: "Connector stacking", quote: "Furthermore", explanation: "Formal connector stacking. Plain writing uses also, and, or nothing." },
    { type: "Stock verb", quote: "leverage", explanation: "Leverage as a verb for use is corporate model phrasing." },
    { type: "Vague quantity", quote: "a wide range of", explanation: "Sounds precise, says nothing. A number or a short list says more." },
    { type: "Stock adjective", quote: "robust", explanation: "Robust is applied to almost anything in model text, so it reads as a tell." },
    { type: "Stock verb", quote: "foster", explanation: "Foster for build or encourage is stock model word choice." },
    { type: "Formula ending", quote: "In conclusion", explanation: "Announces the ending instead of ending." }
  ]
};

var DEMO_HUMAN_INPUT = "The meeting moved to Tuesdays because the room is booked on Mondays. Bring the budget sheet. Last time we ran over by twenty minutes, so the last item may move to email.";

var api = {
  API_BASE: API_BASE,
  STORAGE_KEY: STORAGE_KEY,
  MODELS: MODELS,
  LOCAL_PATTERNS: LOCAL_PATTERNS,
  DEMO_INPUT: DEMO_INPUT,
  DEMO_ANALYSIS: DEMO_ANALYSIS,
  DEMO_HUMAN_INPUT: DEMO_HUMAN_INPUT,
  getModel: getModel,
  validateKey: validateKey,
  buildChatRequest: buildChatRequest,
  parseChatResponse: parseChatResponse,
  parseScore: parseScore,
  scoreBand: scoreBand,
  extractJsonObject: extractJsonObject,
  parseAnalysis: parseAnalysis,
  parseRewrite: parseRewrite,
  findQuoteSpan: findQuoteSpan,
  resolveMarkerSpans: resolveMarkerSpans,
  buildHighlightedSegments: buildHighlightedSegments,
  escapeHtml: escapeHtml,
  findLocalMarkers: findLocalMarkers,
  demoScore: demoScore,
  humaniseLocally: humaniseLocally,
  llmifyLocally: llmifyLocally,
  buildAnalysisPrompt: buildAnalysisPrompt,
  buildHumanisePrompt: buildHumanisePrompt,
  buildLlmVoicePrompt: buildLlmVoicePrompt
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.LlmVoice = api;
}
