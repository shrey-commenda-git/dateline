// Dateline content generator.
// Runs in GitHub Actions with ANTHROPIC_API_KEY. Strictly sequential —
// the API rejects concurrent requests on this account (exceeded_limit: concurrents).
//
// Usage:
//   node scripts/generate.mjs                          # daily: 5 news + 10 catalogue
//   CATALOGUE_COUNT=30 SKIP_NEWS=1 node scripts/generate.mjs   # backfill chunk
//   MOCK_API=1 node scripts/generate.mjs               # offline pipeline test

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-sonnet-4-6";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MOCK = process.env.MOCK_API === "1";
const SKIP_NEWS = process.env.SKIP_NEWS === "1";
const CATALOGUE_COUNT = clampInt(process.env.CATALOGUE_COUNT, 0, 40, 10);
const SLEEP_BETWEEN_CALLS_MS = MOCK ? 10 : 5000;

const NEWS_SLOTS = ["tech", "tech", "business", "business", "finance"];
const CATALOGUE_CATEGORIES = ["history", "geopolitics", "economics", "food", "wine", "coffee", "culture", "ai"];
const FORCE_CATEGORY = process.env.CATALOGUE_CATEGORY || "";

// per-category briefs where the bare category name isn't guidance enough
const CATEGORY_HINTS = {
  ai: `This is the AI & COMPUTING FUNDAMENTALS category: the first-principles ideas and origin stories
behind today's technology. Think: Shannon inventing information theory, why the transistor beat the
vacuum tube, backpropagation's decades in the wilderness, why attention replaced recurrence, what a
GPU actually does and why gamers accidentally funded the AI boom, scaling laws, the design choices
baked into the internet. Explain the MECHANISM from first principles so a curious reader truly gets
it — and trace the causal chain to the technology in their pocket today. No hype, no product news,
no speculation about the future. Era may be recent ("2017") or old ("1948") — the idea's origin.`,
};

const today = new Date().toISOString().slice(0, 10);
const todayCompact = today.replaceAll("-", "");

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- API

let mockCounter = 0;
function mockResponse(kind, category) {
  mockCounter += 1;
  const story = {
    title: `Mock ${kind} story number ${mockCounter}`,
    place: kind === "news" ? "Test City" : "Mockholm",
    ...(kind === "insight" ? { era: "1800s" } : {}),
    category,
    story:
      "This is the first paragraph of a mock story used to exercise the generation pipeline end to end without calling the API. It has enough words to pass the length validation because the validator counts words and rejects stories that are too short to be real. Padding sentence one. Padding sentence two. Padding sentence three. Padding sentence four with several extra words to be safe.\n\nSecond paragraph continues the mock narrative with more filler content so the total comfortably exceeds the minimum word count used by the validator for both news and catalogue stories. More padding here with additional words to stay clear of the lower boundary. Even more padding here so small threshold edits do not break the mock. Final sentence of the mock story with a suitably long concluding thought attached to the end.",
    hook: "A mock hook line you could quote at dinner.",
    source: kind === "news" ? "Mock Newswire" : "Mock, A History of Testing",
  };
  // wrap in fences + prose to exercise the defensive parser
  return "Here is the story you asked for:\n```json\n" + JSON.stringify(story) + "\n```\nLet me know if you need anything else.";
}

async function callClaude({ prompt, useWebSearch, kind, category }) {
  if (MOCK) return mockResponse(kind, category);
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const body = {
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`API ${res.status}: ${text.slice(0, 300)}`);
    err.retryable = res.status === 429 || res.status >= 500 || text.includes("concurrents") || text.includes("overloaded");
    throw err;
  }

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function callWithRetries(args, label) {
  const delays = [8000, 16000, 32000, 64000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await callClaude(args);
    } catch (err) {
      const canRetry = attempt < delays.length && (err.retryable ?? true);
      console.error(`  ${label}: attempt ${attempt + 1} failed — ${err.message}`);
      if (!canRetry) throw err;
      await sleep(MOCK ? 10 : delays[attempt]);
    }
  }
}

// ------------------------------------------------------- parse & validate

/** Defensive JSON extraction: strip fences, slice first { to last }. */
function extractJson(text) {
  let t = String(text).replace(/```(?:json)?/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(t.slice(start, end + 1));
}

function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function validateStory(raw, { kind, category }) {
  const problems = [];
  const need = (field) => {
    if (!raw[field] || typeof raw[field] !== "string" || !raw[field].trim()) problems.push(`missing ${field}`);
  };
  ["title", "place", "story", "hook", "source"].forEach(need);
  if (kind === "insight") need("era");

  if (raw.title && wordCount(raw.title) >= 12) problems.push("title has 12+ words");
  if (raw.place && wordCount(raw.place) > 3) problems.push("place longer than 3 words");
  const words = wordCount(raw.story || "");
  const [min, max] = kind === "news" ? [120, 340] : [120, 420];
  if (words < min || words > max) problems.push(`story is ${words} words (want ${min}–${max})`);

  if (problems.length) throw new Error(`invalid story: ${problems.join(", ")}`);

  return {
    id: "", // assigned by caller
    date: today,
    type: kind,
    category,
    title: raw.title.trim(),
    place: raw.place.trim(),
    ...(kind === "insight" ? { era: String(raw.era).trim() } : {}),
    story: raw.story.trim(),
    hook: raw.hook.trim(),
    source: raw.source.trim(),
  };
}

// ------------------------------------------------------------- prompts

const STYLE = `You write for "Dateline", a private daily briefing for one curious reader who wants to be genuinely well-read — the spirit of The Wealth of Nations, Sapiens, Salt: A World History. Concrete mechanisms, causal chains, stories with a twist. Never trivia, never listicles, never press-release tone.

Respond with ONLY a JSON object, no prose before or after, in exactly this shape:
{"title": "...", "place": "...", "era": "...", "story": "...", "hook": "...", "source": "..."}

Rules:
- title: under 12 words, no clickbait
- place: 1-3 words (city, region, or institution)
- story: plain text, paragraphs separated by \\n\\n. No markdown.
- hook: ONE closing line the reader could naturally say in conversation — quotable, not cheesy
- source: one short attribution (publication, book, or institution)`;

function newsPrompt(slot, index, avoidTitles) {
  return `${STYLE}

Task: research TODAY's (${today}) most consequential ${slot.toUpperCase()} news story using web search, then write it as a 150-280 word story with an arc: what happened, why it matters, what it implies next. A smart briefing, not a press release. No celebrity gossip, no minor product updates.
- era: use today's date "${today}"
- This is story #${index + 1} of 5 in today's briefing.${avoidTitles.length ? `\n- Do NOT cover the same events as these already-written stories: ${avoidTitles.join(" | ")}` : ""}`;
}

function cataloguePrompt(category, avoidEntries, extraAvoid = "") {
  const hint = CATEGORY_HINTS[category] ? `\n${CATEGORY_HINTS[category]}\n` : "";
  return `${STYLE}

Task: write one evergreen story for the permanent library, category: ${category.toUpperCase()}. 150-350 words — let the story decide its own length. Pick something important and durable: a mechanism, an origin, a causal chain that changed how the world works. Vary geography and era — do NOT default to Western Europe or the 20th century.${hint}
- era: a short period label like "1600s", "751 AD", "1920s"
- The reader wants to understand fundamental things: how wealth is created, how power works, why places and cultures are the way they are.

Already in the library — do NOT repeat the same SUBJECT, even under a different title. Each entry below is "title (place, era)":
${avoidEntries.map((e) => `- ${e}`).join("\n") || "- (library is empty)"}${extraAvoid}`;
}

// ------------------------------------------------------------- pipeline

function readData(file) {
  return JSON.parse(readFileSync(join(ROOT, "data", file), "utf8"));
}
function writeData(file, obj) {
  const json = JSON.stringify(obj, null, 2) + "\n";
  JSON.parse(json); // paranoia: never write a file we can't read back
  writeFileSync(join(ROOT, "data", file), json);
}

async function generateOne({ kind, category, prompt, useWebSearch, label }) {
  // one regeneration attempt if the model returns invalid/unparseable JSON
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callWithRetries({ prompt, useWebSearch, kind, category }, label);
    try {
      return validateStory(extractJson(text), { kind, category });
    } catch (err) {
      console.error(`  ${label}: ${err.message}${attempt === 0 ? " — regenerating" : ""}`);
      if (attempt === 1) throw err;
      await sleep(SLEEP_BETWEEN_CALLS_MS);
    }
  }
}

function nextId(prefix, existing) {
  let n = 1;
  const ids = new Set(existing.map((s) => s.id));
  while (ids.has(`${prefix}-${todayCompact}-${n}`)) n++;
  return `${prefix}-${todayCompact}-${n}`;
}

async function generateNews() {
  console.log(`\n== Today's Dispatch (${NEWS_SLOTS.length} stories) ==`);
  const stories = [];
  for (const [i, slot] of NEWS_SLOTS.entries()) {
    const label = `news ${i + 1}/${NEWS_SLOTS.length} [${slot}]`;
    console.log(label);
    const story = await generateOne({
      kind: "news",
      category: slot,
      prompt: newsPrompt(slot, i, stories.map((s) => s.title)),
      useWebSearch: true,
      label,
    });
    story.id = nextId("news", stories);
    stories.push(story);
    console.log(`  -> "${story.title}"`);
    await sleep(SLEEP_BETWEEN_CALLS_MS);
  }
  writeData("news.json", { updated: today, stories });
  console.log(`news.json written (${stories.length} stories, full refresh)`);
}

/** Token-set Jaccard similarity between two stories — catches same-subject retellings. */
const DUP_STOPWORDS = new Set("the a an of in to and for was were is are that it its with by from as at on had has have this which but not they their than into when who would could more most one two first world history over about after before between during through century centuries year years".split(" "));
function storyTokens(s) {
  return new Set(`${s.title} ${s.story}`.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !DUP_STOPWORDS.has(w)));
}
function mostSimilar(story, existing) {
  const t = storyTokens(story);
  let best = { score: 0, title: "" };
  for (const other of existing) {
    const o = storyTokens(other);
    let inter = 0;
    for (const w of t) if (o.has(w)) inter++;
    const score = inter / (t.size + o.size - inter);
    if (score > best.score) best = { score, title: other.title };
  }
  return best;
}
const DUP_THRESHOLD = 0.22; // empirically, true same-subject retellings score >= ~0.22

async function generateCatalogue() {
  if (CATALOGUE_COUNT === 0) return;
  console.log(`\n== The Catalogue (+${CATALOGUE_COUNT} stories) ==`);
  const data = readData("catalogue.json");
  const existing = Array.isArray(data.stories) ? data.stories : [];

  // rotate the category cycle by day so the daily mix drifts over time
  const dayOffset = Math.floor(Date.parse(today) / 86400000) % CATALOGUE_CATEGORIES.length;

  for (let i = 0; i < CATALOGUE_COUNT; i++) {
    const category = FORCE_CATEGORY || CATALOGUE_CATEGORIES[(dayOffset + i) % CATALOGUE_CATEGORIES.length];
    const label = `catalogue ${i + 1}/${CATALOGUE_COUNT} [${category}]`;
    console.log(label);
    // avoid-list carries place+era so the model sees the SUBJECT, not just the wording
    const avoidEntries = existing.map((s) => `${s.title} (${s.place}, ${s.era})`);

    let story;
    for (let attempt = 0; attempt < 2; attempt++) {
      const extraAvoid = attempt === 0 || !story ? "" :
        `\n\nYour previous attempt duplicated the subject of "${mostSimilar(story, existing).title}" — pick a COMPLETELY different subject.`;
      story = await generateOne({
        kind: "insight",
        category,
        prompt: cataloguePrompt(category, avoidEntries, extraAvoid),
        useWebSearch: false,
        label,
      });
      const sim = mostSimilar(story, existing);
      if (sim.score < DUP_THRESHOLD) break;
      if (attempt === 0) {
        console.log(`  !! "${story.title}" overlaps "${sim.title}" (${sim.score.toFixed(2)}) — regenerating`);
        await sleep(SLEEP_BETWEEN_CALLS_MS);
      } else {
        console.log(`  !! still overlapping after retry (${sim.score.toFixed(2)}) — keeping with warning`);
      }
    }
    story.id = nextId("cat", existing);
    existing.push(story); // also feeds the avoid-list for the next iteration
    console.log(`  -> "${story.title}"`);
    // append-and-save every story so an interrupted backfill keeps its progress
    writeData("catalogue.json", { updated: today, stories: existing });
    await sleep(SLEEP_BETWEEN_CALLS_MS);
  }
  console.log(`catalogue.json written (now ${existing.length} stories, append-only)`);
}

// ------------------------------------------------------------------ main

console.log(`Dateline generator — ${today}${MOCK ? " (MOCK MODE)" : ""}`);
console.log(`plan: ${SKIP_NEWS ? "no news" : "5 news"} + ${CATALOGUE_COUNT} catalogue`);

if (!SKIP_NEWS) await generateNews();
await generateCatalogue();

// final sanity pass: both files must parse and respect their schemas
for (const file of ["news.json", "catalogue.json"]) {
  const data = readData(file);
  if (!Array.isArray(data.stories)) throw new Error(`${file}: stories is not an array`);
  const ids = new Set();
  for (const s of data.stories) {
    if (!s.id || ids.has(s.id)) throw new Error(`${file}: missing/duplicate id ${s.id}`);
    ids.add(s.id);
  }
}
console.log("\nAll files valid. Done.");
