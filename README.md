# LLM Voice

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

Spot the model in the text.

LLM Voice scores how much of the recognisable LLM writing style is in a
pasted text, highlights every marker it finds, and rewrites the text in
plain human style next to the original. A reverse mode does the opposite:
it takes plain human text and rewrites it in full LLM voice, for fun and
for comparison.

The LLM voice means the tells language models write with: hedging (it is
important to note, ultimately), stock words (delve, tapestry, robust,
leverage, utilize, foster), connector stacking (furthermore, moreover,
additionally), formula openers and endings (in today's fast-paced world,
in conclusion), vague quantity (a wide range of), balanced pairs (not
only, but also), and a flat even tone that bullets everything and commits
to nothing specific. The app marks the style. It does not claim to prove
who or what wrote the text.

## What it does

- Analyse: paste a text, get a 0 to 100 LLM voice score, a short verdict,
  and the markers found, each with the exact quote and a plain explanation.
- Highlighting: every quoted marker is located in the original text and
  highlighted in place, numbered to match the marker list.
- Humanise: a second pass rewrites the text with the markers removed and
  the meaning kept, shown side by side with the highlighted original.
- Reverse mode: plain text in, full LLM voice out, so the contrast is
  visible in one click.
- Six models to pick from, all callable on free tier Pollen: GPT-5.4 Nano
  (default), GLM 5.3 Flash, DeepSeek V4 Flash, Mistral Large 3, Kimi K2.6,
  Llama 3.3 70B.
- Demo mode: with no key, analysis runs on a local scan of a built in
  stock phrase list and the rewrites use local rules. Every demo result is
  labelled a sample. Nothing is sent anywhere in demo mode.

## Bring your own Pollen (BYOP)

Visitors pay with their own Pollinations key. There is no server and no
shared key.

1. Get a free key at enter.pollinations.ai.
2. Paste it into the key field and press Save key.
3. The key is stored only in your browser, in localStorage, and is sent
   only to gen.pollinations.ai in the Authorization header of the model
   calls you start.
4. Validate key checks the key against GET /account/balance.
5. Clear removes the key and returns the app to demo mode.

Model calls are POST /v1/chat/completions only. Requests set
reasoning_effort to low and max_tokens to 4000, because reasoning models
otherwise spend the whole token budget on hidden reasoning and fail.

## Run it

Static site, no build step. Open index.html in a browser, or serve the
folder:

```sh
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Tests

Core logic (score parsing, analysis parsing, marker span resolution,
highlight segmentation, the local marker scan, the local demo passes, key
format checks, prompt and request builders) is in core.js and runs in
Node as well as the browser.

```sh
npm test
```

32 tests, all passing on Node 24.

## Files

- index.html: the single page.
- styles.css: page styles.
- core.js: parsing, scoring, highlighting and prompt logic. No network.
- app.js: DOM, key handling, and the fetch calls to gen.pollinations.ai.
- tests/core.test.js: Node tests for core.js.
- SUBMISSION.md: the app submission text for quest #19180, ready to file.

## Quest

Built for Pollinations quest #19180: an app, tool or agent about the LLM
voice (10 Pollen, best submission wins).
