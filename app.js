"use strict";

// Page layer for LLM Voice. All parsing, span resolution and scoring
// rules live in core.js (window.LlmVoice). This file owns the DOM, the
// key in localStorage, and the fetch calls. The only host it ever calls
// is gen.pollinations.ai, always under the visitor's own key.

(function () {
  var C = window.LlmVoice;

  var els = {
    key: document.getElementById("keyInput"),
    saveKey: document.getElementById("saveKeyBtn"),
    validateKey: document.getElementById("validateKeyBtn"),
    clearKey: document.getElementById("clearKeyBtn"),
    keyStatus: document.getElementById("keyStatus"),
    model: document.getElementById("modelSelect"),
    demoBanner: document.getElementById("demoBanner"),
    text: document.getElementById("textInput"),
    charCount: document.getElementById("charCount"),
    loadSample: document.getElementById("loadSampleBtn"),
    loadHuman: document.getElementById("loadHumanBtn"),
    clearText: document.getElementById("clearTextBtn"),
    analyse: document.getElementById("analyseBtn"),
    humanise: document.getElementById("humaniseBtn"),
    llmify: document.getElementById("llmifyBtn"),
    runStatus: document.getElementById("runStatus"),
    results: document.getElementById("results"),
    scoreValue: document.getElementById("scoreValue"),
    scoreBand: document.getElementById("scoreBand"),
    scoreSummary: document.getElementById("scoreSummary"),
    highlighted: document.getElementById("highlightedText"),
    rewriteHeading: document.getElementById("rewriteHeading"),
    rewrite: document.getElementById("rewriteText"),
    markerList: document.getElementById("markerList"),
    noMarkers: document.getElementById("noMarkers")
  };

  var lastAnalysis = null; // parsed analysis for the current text
  var lastText = "";

  C.MODELS.forEach(function (m) {
    var opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label + (m.paidOnly ? " (paid Pollen only)" : "");
    if (m.isDefault) opt.selected = true;
    els.model.appendChild(opt);
  });

  function savedKey() {
    try { return localStorage.getItem(C.STORAGE_KEY) || ""; } catch (e) { return ""; }
  }

  function currentKey() {
    var typed = C.validateKey(els.key.value);
    if (typed.ok) return typed.key;
    return savedKey();
  }

  function refreshDemoBanner() {
    els.demoBanner.hidden = !!currentKey();
  }

  function setStatus(el, message, isError) {
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
  }

  // Init key field from localStorage.
  var existing = savedKey();
  if (existing) {
    els.key.value = existing;
    setStatus(els.keyStatus, "A key is saved in this browser. Calls will use it.");
  }
  refreshDemoBanner();

  function updateCount() {
    els.charCount.textContent = els.text.value.length + " characters";
  }
  els.text.addEventListener("input", updateCount);
  updateCount();

  els.saveKey.addEventListener("click", function () {
    var v = C.validateKey(els.key.value);
    if (!v.ok) { setStatus(els.keyStatus, v.error, true); refreshDemoBanner(); return; }
    try { localStorage.setItem(C.STORAGE_KEY, v.key); } catch (e) { /* private mode */ }
    els.key.value = v.key;
    setStatus(els.keyStatus, "Key saved in this browser only.");
    refreshDemoBanner();
  });

  els.clearKey.addEventListener("click", function () {
    try { localStorage.removeItem(C.STORAGE_KEY); } catch (e) { /* ignore */ }
    els.key.value = "";
    setStatus(els.keyStatus, "Key cleared. Demo mode is on.");
    refreshDemoBanner();
  });

  els.validateKey.addEventListener("click", function () {
    var v = C.validateKey(els.key.value);
    if (!v.ok) { setStatus(els.keyStatus, v.error, true); return; }
    setStatus(els.keyStatus, "Checking the key against your account balance...");
    fetch(C.API_BASE + "/account/balance", {
      headers: { "Authorization": "Bearer " + v.key }
    }).then(function (res) {
      if (res.status === 200) {
        return res.json().then(function (data) {
          var balance = data && data.accountBalance ? data.accountBalance.total : data ? data.balance : null;
          setStatus(els.keyStatus, balance !== null && balance !== undefined
            ? "Key works. Account balance: " + balance + " Pollen."
            : "Key works.");
          refreshDemoBanner();
        });
      }
      if (res.status === 401 || res.status === 403) {
        setStatus(els.keyStatus, "The API rejected this key (" + res.status + "). Check the key and try again.", true);
        return null;
      }
      setStatus(els.keyStatus, "Key check returned HTTP " + res.status + ". The key may still work for model calls.", true);
      return null;
    }).catch(function () {
      setStatus(els.keyStatus, "Could not reach gen.pollinations.ai to check the key.", true);
    });
  });

  els.loadSample.addEventListener("click", function () {
    els.text.value = C.DEMO_INPUT;
    updateCount();
    setStatus(els.runStatus, "Sample LLM voice text loaded.");
  });

  els.loadHuman.addEventListener("click", function () {
    els.text.value = C.DEMO_HUMAN_INPUT;
    updateCount();
    setStatus(els.runStatus, "Plain human sample loaded. Try Analyse, then the reverse mode.");
  });

  els.clearText.addEventListener("click", function () {
    els.text.value = "";
    updateCount();
    els.results.hidden = true;
    lastAnalysis = null;
    setStatus(els.runStatus, "");
  });

  function setBusy(busy) {
    els.analyse.disabled = busy;
    els.humanise.disabled = busy;
    els.llmify.disabled = busy;
  }

  function callModel(messages) {
    var key = currentKey();
    var body = C.buildChatRequest(els.model.value, messages);
    return fetch(C.API_BASE + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = data && data.error && data.error.message ? data.error.message : "HTTP " + res.status;
          throw new Error("Model call failed: " + msg);
        }
        var parsed = C.parseChatResponse(data);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.text;
      });
    });
  }

  function renderHighlighted(text, markers) {
    var resolved = C.resolveMarkerSpans(text, markers);
    var segments = C.buildHighlightedSegments(text, resolved);
    els.highlighted.innerHTML = "";
    segments.forEach(function (seg) {
      if (seg.markerIndex === null || seg.markerIndex === undefined) {
        els.highlighted.appendChild(document.createTextNode(seg.text));
      } else {
        var mark = document.createElement("mark");
        mark.textContent = seg.text;
        var marker = resolved.filter(function (m) { return m.index === seg.markerIndex; })[0];
        mark.title = (seg.type || "LLM tell") + (marker && marker.explanation ? ": " + marker.explanation : "");
        var num = document.createElement("span");
        num.className = "marker-num";
        num.textContent = String(seg.markerIndex + 1);
        mark.appendChild(num);
        els.highlighted.appendChild(mark);
      }
    });
    return resolved;
  }

  function renderAnalysis(text, analysis, isDemo) {
    lastAnalysis = analysis;
    lastText = text;
    els.results.hidden = false;
    els.scoreValue.textContent = analysis.score === null ? "-" : String(analysis.score);
    els.scoreBand.textContent = analysis.band + (isDemo ? " (demo sample score)" : "");
    els.scoreSummary.textContent = analysis.summary || "";
    var resolved = renderHighlighted(text, analysis.markers);
    els.markerList.innerHTML = "";
    els.noMarkers.hidden = analysis.markers.length > 0;
    resolved.forEach(function (m) {
      var li = document.createElement("li");
      var type = document.createElement("span");
      type.className = "marker-type";
      type.textContent = (m.index + 1) + ". " + m.type;
      li.appendChild(type);
      if (m.start === -1) {
        var nf = document.createElement("span");
        nf.className = "not-found";
        nf.textContent = " (quoted by the model, not found word for word in the text, so not highlighted)";
        li.appendChild(nf);
      }
      var quote = document.createElement("blockquote");
      quote.textContent = m.quote;
      li.appendChild(quote);
      if (m.explanation) {
        var why = document.createElement("p");
        why.className = "marker-why";
        why.textContent = m.explanation;
        li.appendChild(why);
      }
      els.markerList.appendChild(li);
    });
  }

  function renderRewrite(heading, text) {
    els.rewriteHeading.textContent = heading;
    els.rewrite.innerHTML = "";
    els.rewrite.appendChild(document.createTextNode(text));
  }

  function requireText() {
    var text = els.text.value.trim();
    if (!text) {
      setStatus(els.runStatus, "Paste some text first, or load a sample.", true);
      return null;
    }
    return els.text.value;
  }

  function demoAnalysisFor(text) {
    var markers = C.findLocalMarkers(text);
    return {
      ok: true,
      score: C.demoScore(text, markers),
      band: C.scoreBand(C.demoScore(text, markers)),
      summary: markers.length
        ? "Demo sample analysis, local scan only, no model was called. It found " + markers.length + " stock phrase" + (markers.length === 1 ? "" : "s") + " from the built in list. A model with your key reads for tone, structure and specificity as well, and finds more."
        : "Demo sample analysis, local scan only, no model was called. None of the stock phrases on the built in list appear in this text. That does not clear it: a model with your key reads for tone and structure too.",
      markers: markers.map(function (m) {
        return { type: m.type, quote: m.quote, explanation: m.explanation };
      })
    };
  }

  els.analyse.addEventListener("click", function () {
    var text = requireText();
    if (!text) return;
    if (!currentKey()) {
      renderAnalysis(text, demoAnalysisFor(text), true);
      setStatus(els.runStatus, "Demo mode: sample analysis shown. Save a key for the full model analysis.");
      return;
    }
    setBusy(true);
    setStatus(els.runStatus, "Analysing with " + els.model.value + "...");
    callModel([{ role: "user", content: C.buildAnalysisPrompt(text) }])
      .then(function (reply) {
        var analysis = C.parseAnalysis(reply);
        if (!analysis.ok) throw new Error("The model reply could not be parsed. Raw reply: " + reply.slice(0, 200));
        renderAnalysis(text, analysis, false);
        setStatus(els.runStatus, "Done. " + analysis.markers.length + " marker" + (analysis.markers.length === 1 ? "" : "s") + " found.");
      })
      .catch(function (err) { setStatus(els.runStatus, err.message, true); })
      .then(function () { setBusy(false); });
  });

  els.humanise.addEventListener("click", function () {
    var text = requireText();
    if (!text) return;
    if (els.results.hidden) {
      // Show the original side of the comparison even before any analysis.
      renderAnalysis(text, { ok: true, score: null, band: C.scoreBand(null), summary: "No analysis run yet. The rewrite is on the right.", markers: lastAnalysis && lastText === text ? lastAnalysis.markers : [] }, false);
    }
    if (!currentKey()) {
      renderRewrite("Human rewrite (demo, local rules)", C.humaniseLocally(text));
      setStatus(els.runStatus, "Demo mode: local sample humanise shown. Save a key for the full model rewrite.");
      return;
    }
    setBusy(true);
    setStatus(els.runStatus, "Humanising with " + els.model.value + "...");
    var markers = lastAnalysis && lastText === text ? lastAnalysis.markers : [];
    callModel([{ role: "user", content: C.buildHumanisePrompt(text, markers) }])
      .then(function (reply) {
        var rewrite = C.parseRewrite(reply);
        if (!rewrite.ok) throw new Error(rewrite.error);
        renderRewrite("Human rewrite", rewrite.text);
        setStatus(els.runStatus, "Done. Original on the left, human rewrite on the right.");
      })
      .catch(function (err) { setStatus(els.runStatus, err.message, true); })
      .then(function () { setBusy(false); });
  });

  els.llmify.addEventListener("click", function () {
    var text = requireText();
    if (!text) return;
    if (els.results.hidden) {
      renderAnalysis(text, { ok: true, score: null, band: C.scoreBand(null), summary: "Reverse mode. The full LLM voice version is on the right.", markers: [] }, false);
    }
    if (!currentKey()) {
      renderRewrite("Full LLM voice (demo, local rules)", C.llmifyLocally(text));
      setStatus(els.runStatus, "Demo mode: local sample LLM voice version shown. Save a key for the full model version.");
      return;
    }
    setBusy(true);
    setStatus(els.runStatus, "Rewriting in full LLM voice with " + els.model.value + "...");
    callModel([{ role: "user", content: C.buildLlmVoicePrompt(text) }])
      .then(function (reply) {
        var rewrite = C.parseRewrite(reply);
        if (!rewrite.ok) throw new Error(rewrite.error);
        renderRewrite("Full LLM voice version", rewrite.text);
        setStatus(els.runStatus, "Done. Plain original on the left, full LLM voice on the right.");
      })
      .catch(function (err) { setStatus(els.runStatus, err.message, true); })
      .then(function () { setBusy(false); });
  });
})();
