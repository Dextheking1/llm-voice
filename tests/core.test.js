"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

// ---------- parseScore ----------

test("parseScore reads plain numbers and numeric strings", () => {
  assert.equal(C.parseScore(72), 72);
  assert.equal(C.parseScore("72"), 72);
  assert.equal(C.parseScore(0), 0);
  assert.equal(C.parseScore(100), 100);
});

test("parseScore reads fractions, ratios and percents", () => {
  assert.equal(C.parseScore(0.72), 72);
  assert.equal(C.parseScore("72/100"), 72);
  assert.equal(C.parseScore("3/4"), 75);
  assert.equal(C.parseScore("72%"), 72);
  assert.equal(C.parseScore(" 41 %".replace(" %", "%")), 41);
});

test("parseScore clamps and rounds", () => {
  assert.equal(C.parseScore(140), 100);
  assert.equal(C.parseScore(-5), 0);
  assert.equal(C.parseScore(72.6), 73);
  assert.equal(C.parseScore("250/100"), 100);
});

test("parseScore returns null for junk", () => {
  assert.equal(C.parseScore("high"), null);
  assert.equal(C.parseScore(""), null);
  assert.equal(C.parseScore(null), null);
  assert.equal(C.parseScore(undefined), null);
  assert.equal(C.parseScore({}), null);
  assert.equal(C.parseScore("1/0"), null);
});

test("scoreBand labels the ranges", () => {
  assert.equal(C.scoreBand(0), "Mostly human");
  assert.equal(C.scoreBand(24), "Mostly human");
  assert.equal(C.scoreBand(25), "Some LLM tells");
  assert.equal(C.scoreBand(50), "Strong LLM voice");
  assert.equal(C.scoreBand(75), "Full LLM voice");
  assert.equal(C.scoreBand(100), "Full LLM voice");
  assert.equal(C.scoreBand(null), "No score");
});

// ---------- parseAnalysis ----------

test("parseAnalysis parses strict JSON", () => {
  const raw = JSON.stringify({
    score: 81,
    summary: "Heavy stock phrasing.",
    markers: [
      { type: "Stock verb", quote: "delve", explanation: "Signature model verb." },
      { type: "Connector stacking", quote: "Furthermore", explanation: "Formal connector." }
    ]
  });
  const out = C.parseAnalysis(raw);
  assert.equal(out.ok, true);
  assert.equal(out.score, 81);
  assert.equal(out.band, "Full LLM voice");
  assert.equal(out.summary, "Heavy stock phrasing.");
  assert.equal(out.markers.length, 2);
  assert.equal(out.markers[0].quote, "delve");
});

test("parseAnalysis parses fenced JSON and JSON buried in prose", () => {
  const inner = JSON.stringify({ score: "40", summary: "Some tells.", markers: [] });
  const fenced = C.parseAnalysis("```json\n" + inner + "\n```");
  assert.equal(fenced.ok, true);
  assert.equal(fenced.score, 40);
  const buried = C.parseAnalysis("Here is the analysis: " + inner + " That is all.");
  assert.equal(buried.ok, true);
  assert.equal(buried.score, 40);
});

test("parseAnalysis accepts alternate field names", () => {
  const raw = JSON.stringify({
    overall_score: "0.5",
    verdict: "Half and half.",
    findings: [
      { name: "Hedge", text: "it is important to note", reason: "Announces importance." },
      { marker: "Stock noun", example: "tapestry", why: "Stock metaphor." }
    ]
  });
  const out = C.parseAnalysis(raw);
  assert.equal(out.ok, true);
  assert.equal(out.score, 50);
  assert.equal(out.summary, "Half and half.");
  assert.equal(out.markers.length, 2);
  assert.equal(out.markers[0].type, "Hedge");
  assert.equal(out.markers[0].quote, "it is important to note");
  assert.equal(out.markers[0].explanation, "Announces importance.");
  assert.equal(out.markers[1].quote, "tapestry");
});

test("parseAnalysis accepts an already parsed object", () => {
  const out = C.parseAnalysis({ score: 10, summary: "Clean.", markers: [] });
  assert.equal(out.ok, true);
  assert.equal(out.score, 10);
});

test("parseAnalysis drops markers without a quote and dedupes quotes", () => {
  const raw = JSON.stringify({
    score: 60,
    markers: [
      { type: "No quote", explanation: "Nothing to point at." },
      { type: "Blank", quote: "   ", explanation: "Blank." },
      { type: "Stock verb", quote: "delve", explanation: "First." },
      { type: "Stock verb again", quote: "Delve", explanation: "Duplicate, case differs." },
      { type: "Stock verb again", quote: "delve", explanation: "Duplicate." },
      "not an object"
    ]
  });
  const out = C.parseAnalysis(raw);
  assert.equal(out.markers.length, 1);
  assert.equal(out.markers[0].explanation, "First.");
});

test("parseAnalysis fails cleanly on non JSON", () => {
  const out = C.parseAnalysis("the text seems quite model written to me");
  assert.equal(out.ok, false);
  assert.equal(out.score, null);
  assert.deepEqual(out.markers, []);
});

// ---------- spans and highlighting ----------

test("findQuoteSpan finds exact and case-insensitive matches", () => {
  const text = "We must Delve into this. Furthermore, yes.";
  assert.deepEqual(C.findQuoteSpan(text, "Delve"), { start: 8, end: 13 });
  assert.deepEqual(C.findQuoteSpan(text, "furthermore"), { start: 25, end: 36 });
  assert.equal(C.findQuoteSpan(text, "not present"), null);
  assert.equal(C.findQuoteSpan(text, ""), null);
});

test("resolveMarkerSpans assigns successive occurrences to repeated quotes", () => {
  const text = "robust tools and robust processes";
  const markers = [
    { type: "Stock adjective", quote: "robust", explanation: "First." },
    { type: "Stock adjective", quote: "robust", explanation: "Second." }
  ];
  const out = C.resolveMarkerSpans(text, markers);
  assert.deepEqual([out[0].start, out[0].end], [0, 6]);
  assert.deepEqual([out[1].start, out[1].end], [17, 23]);
});

test("resolveMarkerSpans marks missing quotes as -1 but keeps them", () => {
  const out = C.resolveMarkerSpans("plain text", [
    { type: "Stock verb", quote: "delve", explanation: "Not here." }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, -1);
  assert.equal(out[0].end, -1);
  assert.equal(out[0].index, 0);
});

test("buildHighlightedSegments covers the text exactly and highlights spans", () => {
  const text = "We delve into the tapestry of things.";
  const resolved = C.resolveMarkerSpans(text, [
    { type: "Stock verb", quote: "delve", explanation: "" },
    { type: "Stock noun", quote: "tapestry", explanation: "" }
  ]);
  const segments = C.buildHighlightedSegments(text, resolved);
  assert.equal(segments.map((s) => s.text).join(""), text);
  const marked = segments.filter((s) => s.markerIndex !== null);
  assert.deepEqual(marked.map((s) => s.text), ["delve", "tapestry"]);
  assert.deepEqual(marked.map((s) => s.markerIndex), [0, 1]);
});

test("buildHighlightedSegments is case-insensitive and keeps original casing", () => {
  const text = "Furthermore, we went home.";
  const resolved = C.resolveMarkerSpans(text, [
    { type: "Connector stacking", quote: "furthermore", explanation: "" }
  ]);
  const segments = C.buildHighlightedSegments(text, resolved);
  assert.equal(segments.map((s) => s.text).join(""), text);
  assert.equal(segments[0].text, "Furthermore");
  assert.equal(segments[0].markerIndex, 0);
});

test("buildHighlightedSegments lets the first overlapping span win", () => {
  const text = "it is important to note that x";
  const resolved = C.resolveMarkerSpans(text, [
    { type: "Hedge", quote: "it is important to note", explanation: "" },
    { type: "Hedge part", quote: "important to note that", explanation: "" }
  ]);
  const segments = C.buildHighlightedSegments(text, resolved);
  assert.equal(segments.map((s) => s.text).join(""), text);
  const marked = segments.filter((s) => s.markerIndex !== null);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "it is important to note");
});

test("buildHighlightedSegments ignores unresolvable markers", () => {
  const text = "short text";
  const resolved = C.resolveMarkerSpans(text, [
    { type: "Stock verb", quote: "delve", explanation: "" }
  ]);
  const segments = C.buildHighlightedSegments(text, resolved);
  assert.deepEqual(segments, [{ text: "short text", markerIndex: null, type: null }]);
  assert.deepEqual(C.buildHighlightedSegments("", resolved), []);
});

// ---------- local dictionary, demo passes ----------

test("findLocalMarkers finds known stock phrases in order", () => {
  const found = C.findLocalMarkers(C.DEMO_INPUT);
  const quotes = found.map((m) => m.quote.toLowerCase());
  assert.ok(quotes.includes("furthermore"));
  assert.ok(quotes.includes("leverage"));
  assert.ok(quotes.includes("in conclusion"));
  assert.ok(quotes.includes("a wide range of"));
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i].start > found[i - 1].start, "markers are in text order");
  }
  const segments = C.buildHighlightedSegments(C.DEMO_INPUT, found);
  assert.equal(segments.map((s) => s.text).join(""), C.DEMO_INPUT);
});

test("findLocalMarkers prefers the longest phrase over its parts", () => {
  const found = C.findLocalMarkers("Let us delve into this topic.");
  assert.deepEqual(found.map((m) => m.quote), ["delve into"]);
});

test("findLocalMarkers finds nothing in plain human text", () => {
  assert.deepEqual(C.findLocalMarkers(C.DEMO_HUMAN_INPUT), []);
  assert.deepEqual(C.findLocalMarkers(""), []);
});

test("demoScore is 0 with no markers and rises with marker density", () => {
  assert.equal(C.demoScore("one two three", []), 0);
  const dense = C.demoScore("delve furthermore moreover", C.findLocalMarkers("delve furthermore moreover"));
  assert.ok(dense > 50 && dense <= 96);
});

test("humaniseLocally removes stock phrases and keeps the facts", () => {
  const out = C.humaniseLocally(C.DEMO_INPUT);
  const lower = out.toLowerCase();
  assert.ok(!lower.includes("delve"));
  assert.ok(!lower.includes("furthermore"));
  assert.ok(!lower.includes("moreover"));
  assert.ok(!lower.includes("in conclusion"));
  assert.ok(!lower.includes("leverage"));
  assert.ok(lower.includes("remote work"));
  assert.ok(lower.includes("retention"));
});

test("llmifyLocally dresses plain text in the stock moves", () => {
  const out = C.llmifyLocally(C.DEMO_HUMAN_INPUT);
  const lower = out.toLowerCase();
  assert.ok(lower.includes("furthermore"));
  assert.ok(lower.includes("in conclusion"));
  assert.ok(lower.includes("meeting moved to tuesdays"));
  assert.equal(C.llmifyLocally("   "), "");
});

// ---------- prompts, requests, rewrites ----------

test("buildChatRequest sets reasoning_effort low and a generous max_tokens", () => {
  const body = C.buildChatRequest("z-ai/glm-5.3-flash", [{ role: "user", content: "hi" }]);
  assert.equal(body.model, "z-ai/glm-5.3-flash");
  assert.equal(body.reasoning_effort, "low");
  assert.ok(body.max_tokens >= 2000);
  const fallback = C.buildChatRequest("unknown/model", []);
  assert.equal(fallback.model, C.MODELS[0].id);
});

test("validateKey checks format locally", () => {
  assert.equal(C.validateKey("sk_1234567890abcdefghij").ok, true);
  assert.equal(C.validateKey("  pk_1234567890abcdefghij  ").key, "pk_1234567890abcdefghij");
  assert.equal(C.validateKey("").ok, false);
  assert.equal(C.validateKey("nope").ok, false);
  assert.equal(C.validateKey("sk_short").ok, false);
  assert.equal(C.validateKey("sk_has a space in it ok").ok, false);
  assert.equal(C.validateKey(null).ok, false);
});

test("parseChatResponse reads string and part based content", () => {
  const a = C.parseChatResponse({ choices: [{ message: { content: " hello " }, finish_reason: "stop" }] });
  assert.equal(a.ok, true);
  assert.equal(a.text, "hello");
  const b = C.parseChatResponse({ choices: [{ message: { content: [{ text: "par" }, { text: "ts" }] } }] });
  assert.equal(b.text, "parts");
  assert.equal(C.parseChatResponse({ error: { message: "bad key" } }).error, "bad key");
  assert.equal(C.parseChatResponse(null).ok, false);
  assert.equal(C.parseChatResponse({ choices: [{ message: { content: "  " } }] }).ok, false);
});

test("analysis prompt asks for strict JSON with exact quotes", () => {
  const prompt = C.buildAnalysisPrompt("some text");
  assert.ok(prompt.includes("strict JSON only"));
  assert.ok(prompt.includes("copied exactly"));
  assert.ok(prompt.includes("some text"));
});

test("humanise and reverse prompts keep meaning and ask for JSON", () => {
  const h = C.buildHumanisePrompt("body text", [{ type: "Stock verb", quote: "delve" }]);
  assert.ok(h.includes("delve"));
  assert.ok(h.includes("Keep every fact"));
  const r = C.buildLlmVoicePrompt("body text");
  assert.ok(r.includes("full LLM voice"));
  assert.ok(r.includes("body text"));
});

test("parseRewrite reads JSON, fenced and plain replies", () => {
  assert.equal(C.parseRewrite('{"rewrite": "plain words"}').text, "plain words");
  assert.equal(C.parseRewrite("```\nplain words\n```").text, "plain words");
  assert.equal(C.parseRewrite("Rewrite: plain words").text, "plain words");
  assert.equal(C.parseRewrite("   ").ok, false);
});

test("escapeHtml escapes markup characters", () => {
  assert.equal(C.escapeHtml('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(C.escapeHtml(null), "");
});

test("demo analysis parses through the same path as a model reply", () => {
  const out = C.parseAnalysis(JSON.stringify(C.DEMO_ANALYSIS));
  assert.equal(out.ok, true);
  assert.equal(out.score, C.DEMO_ANALYSIS.score);
  assert.ok(out.markers.length >= 5);
  const resolved = C.resolveMarkerSpans(C.DEMO_INPUT, out.markers);
  const missing = resolved.filter((m) => m.start === -1);
  assert.deepEqual(missing, [], "every demo marker quote appears in the demo input");
});
