# Bellwether web: design contract

Direction "Opening Bell". The site is set like a financial newspaper: ledger paper and ink, one brass accent, and a serif display face over a quiet grotesk. The page is still until the engine does something, and then it moves once, with weight. Every figure is real and says where it came from.

Live reference: **`/_kit`**. It renders every component in every state, in both themes, and is noindex and not linked. Research brief: `design-brief.md` (§7 tokens, §8 components, §9 pages).

## Tokens (`src/styles/tokens.css`)

Themes live on `<html data-theme="paper | after-hours">`.
- `public/theme.js` sets the theme before first paint. It checks, in order: the stored choice (`localStorage['bw:theme']`), then `prefers-color-scheme`.
- `lib/prefs.ts` keeps the theme in sync afterwards. Use `setTheme`, `useTheme`, or `<ThemeToggle>`.
- Themes never switch automatically by market session.

`<html data-session>` mirrors the US session. Only the hero sky uses it:

```css
radial-gradient(120% 60% at 72% 0%, var(--session-tint), transparent 62%)
```

### Color

| Token | Use |
|---|---|
| `--paper` / `--paper-2` / `--paper-3` | Page / sunken (receipts, code, disclosure) / pressed or selected |
| `--rule` / `--rule-strong` | Hairlines / table-header underline |
| `--ink` / `--ink-2` / `--ink-3` | Text. `--ink-3` is the minimum text color (≥ 5.5:1). |
| `--brass` | Bell, rings, $BELL marks. **Fills and strokes only, never text.** |
| `--brass-ink` | Brass text and links |
| `--up` / `--down` | Direction only. Always paired with ▲▼ or a sign. |
| `--brass-wash`, `--up-wash`, `--down-wash` | 14% tints for flashes |
| `--on-ink` | Text on ink buttons |

### Space, layout and shape
- **Space:** `--s-1…--s-10` = 4, 8, 12, 16, 24, 32, 48, 64, 96, 144.
- **Layout:** `--container` 1312, `--gutter` clamp(20–64), `--section` clamp(80–144), `--header-h` 64, `--measure` 680.
- **Radius:** `--r-1` 4, `--r-2` 6, `--r-3` 10. Nothing goes above 10.

## Type

| Role | Face | Size | Weight / tracking |
|---|---|---|---|
| `.display` | Newsreader | `--fs-display` 48→104 | 320, −0.03em, lh 0.94 |
| `h1` | Newsreader | `--fs-h1` 40→72 | 340, −0.025em |
| `h2` | Newsreader | `--fs-h2` 30→44 | 360, −0.02em |
| `h3` | Geist | 22 | 500 |
| `.lead` | Geist | 18→19 | 400, `--ink-2` |
| body | Geist | 16/26 | 400 |
| `.small` | Geist | 14 | 400 |
| `.label` | Geist | 12 | 500, sentence case, `--ink-3` |
| `.num` | Geist Mono | inherit | tabular, slashed zero |
| `.fig`, `<Figure>` | Newsreader | `--fs-figure` 36→56 | 300, lining tabular |

- **Newsreader** is only for display, H1–H2, big figures and pull quotes. It's self-hosted as `src/assets/fonts/newsreader-display.woff2` (opsz 60, wght 300–500, Latin, 50 KB), rebuilt with `npm run fonts -w @bellwether/web`. It's preloaded, and there's a metric-matched Georgia fallback. Only weights 300–500 exist.
- **Geist** is used at 400 and 500 only, 600 at most on small buttons.
- **Geist Mono** is for tables, the tape, addresses and hashes.
- **Section labels** are sentence case with an editorial number: `§2 How the money moves`. Never write uppercase mono eyebrows.
- **Two-tone headlines** wrap the continuation in `<Muted>`.
- **PAPER:** put `<span className="paper-tag">PAPER</span>` after any simulated amount.

## Motion: struck, not floated

| What | Duration | Easing |
|---|---|---|
| Press (buttons, bell stage) | 80ms: `translateY(1px) scale(.985)` | `--ease-out` |
| Hover, fades, tooltip | 120ms (`--dur-fast`) | `--ease-out` `cubic-bezier(.22,1,.36,1)` |
| UI entries, caption rise (8px), route fade (4px) | 240ms (`--dur-ui`) | `--ease-out` |
| Panels, sheet, nav underline, logo tilt | 420ms (`--dur-panel`) | `--ease-snap` `cubic-bezier(.32,.72,0,1)` |
| `<Reveal>` (12px rise) | 500ms, 80ms stagger | `--ease-out` |
| Price flash | 600ms | `--ease-out` |
| Bell swing | 1400ms, damped 14/−10/6/−3/1°, clapper ×1.4, +60ms | per-segment `cubic-bezier(.45,0,.55,1)` |
| Bell rings | 1600ms, scale .6→2.6, 120ms stagger | `--ease-out` |
| Tape | 40 px/s linear, the only perpetual motion | linear |
| NumberFlow digits | 600ms | `--ease-out` |

Rules:
- Animate transform and opacity only.
- No glow, no pulsing dots, no shimmer, no parallax, no scroll-jacking. Nothing loops except the tape.
- Nothing moves unless the engine did something. The bell never fakes a ring.
- **Reduced motion:**
  - Tokens drop to 0ms.
  - The bell doesn't swing; its caption changes with a brass underline.
  - The tape becomes a static scroll list.
  - `<Reveal>` shows immediately.
  - NumberFlow doesn't roll.

## Layout

- **Container:** `<Container>` or `.container`, 1312 plus gutters.
- **Page rails:** 1px `--rule` lines at the container edges, full height, hidden under 720px. Tables and hairlines run rail to rail. The first and last cells have no outer padding.
- **Sections:** `<Section n label title lede aside>` has `--section` padding and one hairline between adjacent sections. Don't use card backgrounds.
- **Grid:** `<Grid>` + `<Col span start>` is 12 columns with 24px gutters and stacks under 900px. Use `<Rule strong>` for rules.
- **Allowed surfaces:**
  - `--paper-2` for receipts, code, the disclosure line and the video mat.
  - Floating panels use `--shadow-pop` and radius 10.
- **Shell:**
  - Disclosure lines.
  - Sticky 64px header: solid paper, with a rule once scrolled.
  - `main > .route` (fades 240ms per route).
  - Footer: 4 ruled columns, numbered footnotes, then the big wordmark.
- **Document titles:** `useTitle('Page')` gives "Page · Bellwether".

## Components (`src/components`)

| Component | API | Notes |
|---|---|---|
| `Bell` | `{ variant?: 'hero'\|'mini', token?, settle? }` | Rings only on real `buyback` stream events (`onActivity`), max 1 swing per 1.2s with a ×N count. The caption stays 6s. $BELL burns strike the tenor. Double strike at the 09:30/16:00 ET session change. Click opens the latest receipt. Opt-in sound (`SoundToggle`); throttled announcements (`AnnounceToggle`). |
| `BellView`, `RingCaption` | Controlled view plus `ref.ring({tenor, double})` | For static states only (the kit). |
| `Tape` / `TapeView` | `TapeView { events, paper, offline?, still? }` | Latest cell plus a looping history of 30 prints. Pauses on hover, focus, hidden tab and offscreen. New prints join at the next loop. |
| `Receipt`, `ReceiptTrigger`, `ReceiptBody` | `{ event, paper }` | Zig-zag slip. Popover from any trigger. Paper refs are never links. |
| `Figure`, `FigureRow`, `figureStatus(q)` | `{ label, value, kind: usd\|eth\|int\|compact\|pct, unit?, sub?, asOf, source, status, paper?, onRetry?, size? }` | Unknown values render "—", never 0. Stale shows "(stale)"; offline dims the figure and offers Retry. |
| `RollingNumber` | `{ value, format, prefix?, suffix? }` | NumberFlow, CSP-safe (adopted stylesheet). |
| `Board` / `BoardView` | `{ limit?, caption? }` | Sortable (`aria-sort`), price flash, `SignalBar` with ±25 wait band. On mobile the signal becomes a second line. |
| `Medallion` | `{ image, symbol, address, size }` | Token image over a guilloché rosette seeded from the address. |
| `StatusDot` | `{ tone: live\|pending\|offline\|idle }` | Dot + text, never a pill. |
| `Term` | `{ id: TermId } \| { tip }` | Dotted underline plus a tooltip. Glossary lives in `GLOSSARY`. |
| `SessionLine` | `{ compact? }` | "● Market open · closes in 2h 14m"; a popover shows what each strategy does now. |
| `EngineIndicator`, `EngineStatusBar`, `WorkerList`, `useEngineHealth` | | Header dot, dashboard status line, worker table. |
| `Sparkline` | `{ values, label, tone: brass\|ink\|up\|down, stepped?, fallback? }` | Needs ≥ 7 non-zero points, otherwise shows the fallback text. |
| `CandleChart` | `{ candles, label, height?, markers? }` | Theme colors read from CSS vars. Markers: burn (brass), buy, sell. |
| `Reveal` | `{ as?, delay? }` | Fires once, via one shared IntersectionObserver. |
| `Section`, `Container`, `Grid`, `Col`, `Rule`, `Muted`, `Arrow` | | Layout primitives. |
| `Monogram`, `Wordmark`, `Lockup`, `BellGlyph` | | Candle-bell mark (engraved at ≥ 64px). The inline glyph is for headlines and prints. |
| `Popover`, `useAnchoredPosition`, `Dialog`, `Toast` | | Anchored, non-modal popover. Native modal dialog / `.dialog--sheet`. Ink toasts. |
| `ThemeToggle`, `SoundToggle`, `AnnounceToggle` | | Persisted preferences (`lib/prefs.ts`). |
| `Fn` (content/footnotes) | `{ id }` | Superscript link to a numbered footer footnote. |
| `Pill`, `StatusPill`, `VerdictPill`, `BiasChip`, `StagePill`, `Stat`, `Pnl`, `Change` | | Dot + text badges and compact stats. |

CSS classes:
- **Buttons:** `.btn .btn--primary` (ink), `.btn--secondary` (hairline), `.btn--ghost`. Sizes are `--sm` 36, default 44, `--lg` 52; `--block` for full width.
- **Text links:** `.tertiary` + `<Arrow>`.
- **Icon buttons:** `.icon-btn`.
- **Toggles:** `.toggle[aria-pressed]`.
- **Forms:** `.field .field__label .input .input--mono .select .range .check .choice`.
- **Tables:** `.table` (+ `.table--click`, `.table--stack`), `.r` for numbers.
- **Key/value lists:** `.kv`.

## States (every data component)

| State | Treatment |
|---|---|
| Loading | Final layout with "—" at final size and "Connecting to the engine…". No shimmer. The 2px route progress line covers real waits. |
| Live | Normal. The header shows ● Live. |
| Reconnecting | ● Reconnecting… in brass-ink. Keep the last values; "as of" gains "(stale)". |
| Offline | Figures dim to 55%; show "Engine unreachable · last update 14:02 ET" plus Retry. The tape pauses. The bell goes grey. Never show 0 for unknown. |
| Empty | One sentence on what happens next, from real engine state, plus at most one action (`<Empty>`). No illustrations. |
| Error | Human copy from `lib/errors.ts`, plus the code in mono (`<ErrorNotice>`). |
| Paper | One disclosure line (dismissible per session) plus a PAPER tag on every simulated amount. |

## Do / don't

**Do:**
- Show exact figures with an as-of time and a source.
- Use hairlines, not boxes.
- Use one brass accent.
- Write sentence case.
- Say the unit.
- Label absolute times with "ET".
- Pair direction with ▲▼ as well as color.
- Make touch targets at least 44px.
- Show a visible `--focus` ring.
- Use real `<table>`s with captions and `scope`.

**Don't:**
- LED or dot-matrix digits, amber on black, mono uppercase eyebrows.
- Glow shadows, gradients on text, glass, pulsing dots.
- Pills for default states (Active isn't shown at all).
- Card soup.
- Rounded "+" stats.
- Hazard stripes.
- Emoji.
- Brass text on paper.
- Faking motion or data.

## CSP

The engine serves `script-src 'self'; style-src 'self'`:
- No inline `<script>` or `<style>`. React `style` props are fine (CSSOM).
- Pre-paint work belongs in `public/theme.js`.
- NumberFlow's shadow `<style>` is blocked, so `RollingNumber` adopts the same rules as a constructed stylesheet. Always use `RollingNumber` or `Figure`, never `@number-flow/react` directly.
