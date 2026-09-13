---
name: perf-audit
description: >
  Audit and improve web page loading performance through the browser arm:
  measure Core Web Vitals and navigation timing in-page via browser_evaluate,
  optionally run full Lighthouse via npx, and map findings to concrete fixes.
  Use when asked to analyze or improve loading speed, performance scores,
  TTFB, FCP, LCP, CLS, TBT/INP, or "why is this page slow".
---

# Auditing loading performance with the browser arm

## Invocation arguments (user notes)

Anything the user passes after `/skill:perf-audit` arrives as a `User:` note —
requirements context. Typical contents:

- **Target**: URL (required if not already known); dev server vs prod.
- **Focus**: metrics they care about (LCP? CLS? TTFB?), mobile vs desktop,
  quick in-page vitals vs a scored Lighthouse run.
- **Constraints**: what may not change (third-party tags, backend, framework),
  previous audit results to compare against, budget targets.

User notes override this skill's defaults — e.g. "only Lighthouse, mobile" or
"in-page only, don't touch prod with throttled runs". If no target URL is
known, ask before measuring.

## Two measurement modes

1. **In-page** (`browser_evaluate` snippets below) — real numbers from the
   real session: works on localhost dev servers and logged-in pages.
2. **Full Lighthouse** (`npx lighthouse` from the shell) — lab scores with
   simulated mobile throttling + prioritized opportunities. Runs its own
   headless Chrome with a fresh profile: logged-out view, separate from the arm.

Start in-page; escalate to Lighthouse when the user wants scored/compared
audits. Re-`browser_navigate` before measuring — you want a fresh load.

## In-page vitals (verbatim `browser_evaluate` snippets)

- Navigation timing — TTFB, DOMContentLoaded, load, transfer size:

  ```js
  (() => { const t = performance.getEntriesByType("navigation")[0]; return { ttfbMs: Math.round(t.responseStart), dclMs: Math.round(t.domContentLoadedEventEnd), loadMs: Math.round(t.loadEventEnd), transferKB: Math.round((t.transferSize || 0) / 1024) }; })()
  ```

- FCP:

  ```js
  (async () => new Promise((resolve) => { new PerformanceObserver((l) => { const e = l.getEntries().find((x) => x.name === "first-contentful-paint"); if (e) resolve({ fcpMs: Math.round(e.startTime) }); }).observe({ type: "paint", buffered: true }); setTimeout(() => resolve("no-entry"), 3000); }))()
  ```

- LCP (element behind the "biggest paint"):

  ```js
  (async () => new Promise((resolve) => { new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) resolve({ lcpMs: Math.round(e.startTime), url: e.url || "(inline/text)" }); }).observe({ type: "largest-contentful-paint", buffered: true }); setTimeout(() => resolve("no-entry"), 3000); }))()
  ```

- CLS (layout instability):

  ```js
  (async () => new Promise((resolve) => { let cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true }); setTimeout(() => resolve({ cls: Math.round(cls * 1000) / 1000 }), 3000); }))()
  ```

- Long tasks (lab proxy for INP/TBT):

  ```js
  (async () => new Promise((resolve) => { const t = []; new PerformanceObserver((l) => t.push(...l.getEntries())).observe({ type: "longtask", buffered: true }); setTimeout(() => resolve({ count: t.length, totalMs: Math.round(t.reduce((s, x) => s + x.duration, 0)) }), 3000); }))()
  ```

- Heaviest resources (top 10 by bytes):

  ```js
  (() => performance.getEntriesByType("resource").sort((a, b) => b.transferSize - a.transferSize).slice(0, 10).map((r) => Math.round(r.transferSize / 1024) + "KB " + Math.round(r.duration) + "ms " + r.name.split("/").pop().slice(0, 50)))()
  ```

Caveats: `loadMs` reads 0 if measured before load settles (the navigate tool
waits, so this is rare); in-page numbers are unthrottled — usually better than
a Lighthouse mobile profile; SPA client-side views don't produce new
navigation entries.

## Full Lighthouse (shell, not the arm)

```bash
npx -y lighthouse@latest <url> --output=json --output-path=/tmp/lh.json --only-categories=performance,accessibility,best-practices,seo --chrome-flags="--headless=new" --quiet
```

Summarize (scores are 0–1, ×100 for display):

```bash
node -e "const r=require('/tmp/lh.json');for(const[k,c]of Object.entries(r.categories))console.log(k,Math.round(c.score*100));const ops=Object.values(r.audits).filter(a=>a.details?.overallSavingsMs>100).sort((a,b)=>b.details.overallSavingsMs-a.details.overallSavingsMs);console.log(ops.slice(0,8).map(a=>Math.round(a.details.overallSavingsMs)+'ms '+a.title).join('\n'))"
```

Full audit detail for one finding: read `r.audits["render-blocking-scripts"]` etc.

## Scorecard thresholds (Google, "good")

| Metric | Good | Poor |
|--------|------|------|
| TTFB | < 800ms | > 1800ms |
| FCP | < 1800ms | > 3000ms |
| LCP | < 2500ms | > 4000ms |
| CLS | < 0.1 | > 0.25 |
| TBT (lab) | < 200ms | > 600ms |

INP is field-data-only; TBT is its lab proxy. Report a metrics table against
these thresholds, then top 3 fixes ranked by expected impact, then re-measure
after each fix lands.

## From finding to fix

| Finding | Fix |
|---------|-----|
| High TTFB | server/CDN caching, DB query, edge render, avoid cold starts |
| Slow LCP, big hero image | compress + webp/avif, `srcset`/`sizes`, `fetchpriority="high"`, preload it |
| Render-blocking CSS/JS | `defer` scripts, inline critical CSS, async non-critical |
| Big JS bundle | code-split routes, tree-shake, drop dead deps, visualize (`npx source-map-explorer` or bundle analyzer) |
| CLS shifts | width/height on images/embeds, reserve slots for ads/lazy content, never inject above existing content |
| Fonts | `font-display: swap`, preload the main font, subset, woff2 only |
| No compression | enable gzip/brotli at server or CDN |
| Cacheable assets re-fetched | `Cache-Control: immutable, max-age=31536000` on hashed filenames |
| Many third-party tags | defer/async, load on interaction, self-host, audit necessity |
| Long tasks | split work, web workers, `requestIdleCallback`, virtualize long lists |
