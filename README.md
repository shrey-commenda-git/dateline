# Dateline

Personal micro-learning app. Two feeds:

- **Today's Dispatch** — 5 news stories/day (2 tech, 2 business, 1 finance), fully refreshed every morning.
- **The Catalogue** — a permanent, ever-growing library of evergreen stories (history, geopolitics, economics, food, wine, coffee, culture, ai). 10 new stories appended daily. Never resets. The `ai` category covers first-principles ideas and origin stories behind modern computing and AI.

Every story is stamped with a place and time — collecting knowledge across the world and across history.

## Architecture

Pure static frontend (`index.html`) on GitHub Pages. No backend, no API key in the client.
A GitHub Actions cron runs at 7:00 AM IST (`30 1 * * *` UTC), generates content with the
Anthropic API (key stored as a repo secret), writes to `data/*.json`, and pushes.

```
index.html                  # entire frontend
data/news.json              # {updated, stories:[]} — overwritten daily
data/catalogue.json         # {updated, stories:[]} — appended daily, never reset
data/foundations.json       # ordered multi-part series (Phase 4)
data/deepdives.json         # next-morning deep dives (Phase 6)
scripts/generate.mjs        # generation logic + prompts (Phase 2)
.github/workflows/daily.yml # cron + manual trigger (Phase 2)
```

## Setup

1. Push this repo to GitHub (`main` branch).
2. Settings → Pages → deploy from `main` / root.
3. Settings → Secrets and variables → Actions → add `ANTHROPIC_API_KEY`.
4. Actions → "Daily content refresh" → Run workflow (seeds the first batch, ~3–5 min).

The site is then live at `https://<user>.github.io/dateline/` on any device.
Read progress is stored per-device in localStorage (`dateline:read`, `dateline:unreadOnly`).

## Build plan / status

- [x] **Phase 0** — skeleton, live URL, empty states
- [x] **Phase 1** — reading experience: stamps, hooks, auto-read tracking (IntersectionObserver),
      unread-only default + toggle, read counter, scroll progress bar, mobile-first.
      Catalogue seeded with 10 hand-written stories.
- [ ] **Phase 2** — generation pipeline (`generate.mjs` + workflow, schema-validated before commit)
- [ ] **Phase 3** — one-time backfill (~150 catalogue stories, chunked batches)
- [ ] **Phase 4** — Foundations: ordered multi-part series (How Wealth Works → The Machinery of
      Power → The Human Animal → bench: Money Itself, Geography Is Destiny, Cuisines of the
      World, Energy, Trade & Chokepoints, Law & Trust, Disease & History, Language)
- [ ] **Phase 5** — search, category chips, star/arsenal tab, news archive
- [ ] **Phase 6** — deep dive: GO DEEPER → GitHub issue → generated next 7 AM
- [ ] **Phase 7** — passport page, PWA install, Sunday long read

## Design decisions (do not regress)

- Normal article scroll — **no scroll-snap** (nested scroll areas inside snap-mandatory cards glitch).
- No full-page divider screens — thin inline section labels only.
- Generation is **strictly sequential** with retries/backoff — the API rejects concurrent requests.
- Model JSON responses parsed defensively: strip fences, slice first `{` to last `}`.
- Depth over volume: fewer, richer stories. No trivia.
