# Hot Glass — UI redesign spec (approved)

Owner: Youssouf. Status: **approved design, ready to implement**. Scope: the visual layer of MentalTuition (this repo), desktop.

Design canvas (owner's private reference): https://claude.ai/code/artifact/fdc930d5-ed70-4afc-9c7c-dfff60ea313d
Board sources live next to this file in `docs/design/hot-glass/boards/*.html`. They are standalone prototypes in a canvas format: read them for **exact CSS values**, never copy their markup structure, `{{holes}}`, `<sc-for>` or `DCLogic` classes into the app.

> AGENTS.md still applies: no guessing. This spec settles the look. Anything it does not settle, and every item in **§12 Open questions**, must be asked before you implement it.

---

## 0. Board index

| Board file | What it settles |
|---|---|
| `Material.html` (00) | The liquid-glass material: panels and buttons |
| `Main.html` (01) | Hover and press behaviour on every control |
| `Prism.html` (02) | Hero surfaces (composer, dialogs): monochrome edges |
| `Graph.html` (03A) | Knowledge graph, **Cloud** view |
| `Neural.html` (03B) | Knowledge graph, **Neural** view |
| `Themes.html` (04) | Glass + spectrum per theme (Dark / Light / Nocturne) |
| `Composer.html` (05) | The composer (home and session) |
| `Sidebar.html` (06) | Main page: sidebar + composer placement |

## 1. Principles (owner's words, distilled)

- Clean, premium, **sharp**. **No film grain anywhere.** This overrides the design system's "always grain" rule.
- Ground is **near-pure black**: a barely-there top light, minimal grey, no white lift.
- Everything is **liquid glass**, modelled on the owner's red reference: thick, domed glass with a bright top rim, a caustic along the bottom and a dark refraction edge, with type that sits *inside* the glass.
- At rest every edge is **monochrome silver**. Colour appears **only on interaction**, as an iridescent spectrum.
- No avatar, no orb. The interface is the tutor.

## 2. Ground (all themes keep their own; Dark changes)

`app/globals.css`:

- Delete the grain: the `.lh-ground::after` rule and the `--grain*` tokens (all three themes). Remove any other grain usage.
- Dark `--spotlight-top` / page ground becomes:
  `radial-gradient(ellipse 95% 80% at 50% 0%, #161618, #151517, #131315, #111113, #0f0f10, #0d0d0e, #0b0b0c, #09090a, #070708, #060606, #050505, #040404, #030303, #020202, #010101, #000000), #000000`
  and `--void: #000000`.
- Light and Nocturne grounds: unchanged except that grain is removed.
- Without grain, long dark gradients can band on some screens. If banding shows, the agreed fix is an **invisible** dither (≤ 2% opacity), never visible grain. Ask before adding it.

## 3. Liquid-glass material (board 00)

Two recipes replace `.lh-glass`, `.lh-sheet` and the floating-card override. Take the exact values from `Material.html`.

**Panel** (`.lgp` in the boards): composer, dialogs, popovers, docks, cards that float.
```css
background:
  linear-gradient(180deg, rgba(255,255,255,.1), rgba(255,255,255,.06) 16%, rgba(255,255,255,.035) 34%,
                  rgba(255,255,255,.025) 55%, rgba(255,255,255,.03) 78%, rgba(255,255,255,.06) 100%),
  rgba(18,18,21,.55);
backdrop-filter: blur(28px) saturate(160%);
box-shadow:
  0 0 0 1px rgba(0,0,0,.55),                         /* dark refraction edge */
  inset 0 2px 1px -1px rgba(255,255,255,.6),         /* bright top rim */
  inset 0 0 0 1px rgba(255,255,255,.07),
  inset 0 -1.5px 1px -.5px rgba(255,255,255,.22),    /* bottom caustic line */
  inset 0 40px 60px -48px rgba(255,255,255,.18),     /* top sheen */
  0 40px 80px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4);
```
The composer uses a darker body: `rgba(12,12,14,.7)`; see `Composer.html`.

**Button** (`.lg`): every pill and round button.
```css
color: rgba(255,255,255,.86);
text-shadow: 0 1px 0 rgba(255,255,255,.14), 0 -1px 0 rgba(0,0,0,.35), 0 0 14px rgba(255,255,255,.2);
background:
  linear-gradient(180deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.09) 22%, rgba(255,255,255,.05) 44%,
                  rgba(255,255,255,.03) 62%, rgba(255,255,255,.05) 82%, rgba(255,255,255,.1) 100%),
  rgba(28,28,32,.5);
backdrop-filter: blur(14px) saturate(160%);
box-shadow:
  0 0 0 1px rgba(0,0,0,.6),
  inset 0 1.5px .5px -.5px rgba(255,255,255,.8),
  inset 0 0 0 1px rgba(255,255,255,.09),
  inset 0 -1.5px 1px -.5px rgba(255,255,255,.4),
  inset 0 10px 14px -10px rgba(255,255,255,.24),
  inset 0 -12px 16px -12px rgba(255,255,255,.2),
  inset 0 0 16px rgba(0,0,0,.28),
  0 12px 28px rgba(0,0,0,.55), 0 2px 4px rgba(0,0,0,.4);
```
**Primary** (send, New session): the same rims on a white body (`.pri` in the boards): `#141416` text on `linear-gradient(180deg, rgba(255,255,255,.97), rgba(244,244,246,.93) 30%, rgba(226,226,231,.9) 66%, rgba(238,238,242,.94))`.

Radii: pills `999px`; round icon buttons are circles or `12–16px`; panels `20–36px` (composer 30–36, dialogs 28).

## 4. Hover and press: iridescent rim (board 01)

This applies to **every button, chip, toggle and graph node**.

- **Hover:** a 1.5px conic spectrum rim, masked to the edge, rotating once every **3.2 s**, at opacity **.9** (fade-in 300 ms).
- **Press:** the rim goes to full opacity, a blurred copy of the spectrum (blur **12px**, opacity **.55**, inset −6px, behind the button) glows out, the hue jumps forward 220°, and the control squashes to **scale(.97)**.
- **Heat-in:** 60 ms. **Cool-down:** opacity fades over **700 ms** while the hue keeps turning over **1.4 s**. Easing: `cubic-bezier(.2,.7,.2,1)`.
- The spin animation is **paused unless hovered or pressed**. Idle buttons must not repaint.
- `prefers-reduced-motion`: no spinning and no hue turn; fade only.
- Spectrum (Dark): `#ff5ad1 #ffb547 #f4ff7a #5dffb0 #49e6ff #6a7bff #c86bff`.

Reference CSS (from `Main.html`):
```css
@property --ang  { syntax:'<angle>'; inherits:false; initial-value:0deg }
@property --spin { syntax:'<angle>'; inherits:false; initial-value:0deg }
@keyframes lg-spin { to { --spin: 360deg } }
.lg::before, .lg::after {
  content:""; position:absolute; border-radius:inherit; pointer-events:none;
  background: conic-gradient(from calc(var(--ang) + var(--spin)), #ff5ad1,#ffb547,#f4ff7a,#5dffb0,#49e6ff,#6a7bff,#c86bff,#ff5ad1);
  opacity:0; animation: lg-spin 3.2s linear infinite paused;
  transition: opacity 700ms cubic-bezier(.2,.7,.2,1), --ang 1400ms cubic-bezier(.2,.7,.2,1);
}
.lg::before { inset:-1px; padding:1.5px; -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
.lg::after  { inset:-6px; filter: blur(12px); z-index:-1; }
.lg:hover::before { opacity:.9; animation-play-state:running; transition-duration:300ms,1400ms }
.lg:hover::after  { animation-play-state:running }
.lg:active { transform: scale(.97); transition-duration: 90ms }
.lg:active::before { opacity:1;   --ang:220deg; transition-duration:60ms,1400ms }
.lg:active::after  { opacity:.55; --ang:220deg; transition-duration:60ms,1400ms }
```
The glow sits at `z-index:-1`, so the button's parent needs a stacking context (`position:relative; z-index:0`).
The app's no-ring law stays: no browser focus outline. A keyboard focus affordance is an open question (§12).

## 5. Hero surfaces (board 02)

The composer, dialogs and the quiz dock use the **panel** recipe with **plain silver edges**: no prism or bevel colour at rest. Buttons inside them follow §4.

## 6. Themes (board 04)

All three themes get the material and the iridescent interaction. The per-theme values are in `Themes.html` as CSS variables on each panel:

- **Dark:** as above.
- **Light:** frosted white glass. Button body `linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.72) 26%, rgba(255,255,255,.5) 56%, rgba(255,255,255,.62) 82%, rgba(255,255,255,.85)), rgba(236,236,240,.4)` with ink `#1a1a1c`. The primary is dark glass. **Deeper spectrum** `#e0359f #f08a00 #c9c400 #00b26e #0098c8 #3d4fe0 #9a3ee0`, glow .45.
- **Nocturne:** cobalt-tinted glass with a **pink caustic** on the bottom edge (`rgba(255,190,225,.5)`). **Pastel spectrum** `#ff8ad8 #ffc28a #f6ffb0 #8affd0 #8aeaff #a8b4ff #d6a0ff`, glow .6.

## 7. Composer (board 05, placed on board 06)

Files: `components/home.tsx` (home form), `components/composer.tsx` (session), `components/stats-bar.tsx`, `components/dictation.tsx`, `components/module-picker.tsx`, `components/model-picker.tsx`.

One glass slab (panel recipe, darker body, radius 30–36):

- **Top:** a white caret bar (2.5px × 40px, `#f4f4f6`, glow `0 0 8px rgba(255,255,255,.55)`) blinks until focus. Native `caret-color: #f4f4f6`. Placeholder in **Geist 300, ~30px** (22px at the 820px home width), colour `#4a4a4f`. Keep the existing placeholder copy ("What do you want to learn?" / "…practice?"). **No orb, no avatar.**
- **Bottom tray** (inset, `rgba(255,255,255,.025)`, radius 24–28, 8–12px inside the slab), left to right:
  1. **Attach:** round glass button with a paperclip icon (replaces `PlusMenu`'s +).
  2. **Dictate:** a glass pill (min-width ~200–250px) with a mic icon, the label "Dictate" and a 5-bar level meter. While listening, the label reads "Listening…", the bars animate from live input level and the rim spins (hover state held on). It replaces `DictationBar`'s wide strip.
  3. Spacer.
  4. **Three separate quiet text buttons** (Geist Mono 10.5–11px, `#7a7a80`, hover white + faint fill): **module** ("NO MODULE ▾"), **model** ("OPUS 5 ▾"), **thinking level** ("HIGH ▾"). Each opens its existing picker.
  5. **Send:** round primary (white) button with the return glyph.
- The old row of four pills under the composer is **removed**. The "New session / The teacher will open by probing…" caption is not on the approved board (see §12).

## 8. Sidebar (board 06)

File: `components/sidebar.tsx` (plus `activity-dock.tsx` for the agents data). Width 280. A shade darker than the page (`#0b0b0c → #070708`), right hairline `rgba(255,255,255,.06)`. Grey text, one line-icon style (1.5px stroke, 16px).

Top to bottom:
1. **Wordmark** "Mental Tuition" (Geist 300, 15px) and a collapse button.
2. **New session** (primary, full width, with its shortcut hint) and a round **New practice session** button (dumbbell icon).
3. **Search everything** field with a shortcut hint (see §12: the shortcut conflicts).
4. **Navigation** (no indents): **Knowledge graph**, **Modules**, **Practice papers**. The active item is a small glass pill with white text; hover is a faint fill (`rgba(255,255,255,.04)`).
5. **Sessions**:
   - Header "SESSIONS" with a **TIME / MODULE** grouping switch (persist the choice).
   - Filter tabs **ALL · TEACH · PRACTICE** (replaces the old Teaching/Practice nav links and segmented control).
   - **Time grouping:** PINNED / YESTERDAY / THIS WEEK, and so on, with tiny mono section labels.
   - **Module grouping:** collapsible headers "MODULE CODE · count" with a chevron; sessions without a module go under "NO MODULE"; persist the collapsed state.
   - Row: title (13.5px, `#d8d8dc`). Meta line (11.5px, `#6e6e74`): "Waiting for you · 1d" with a softly pulsing white dot when `pendingQuestion` or `pendingProblem` is set; a small dumbbell for practice sessions; "Teach · 2d" otherwise. A "…" options button appears on hover.
6. **Footer:**
   - **Only the background agents running right now**, under a "RUNNING NOW" label: pulsing dot, agent name, what it is working on, and elapsed time (mono). When none are running, this block is **absent**.
   - Then **Settings** (gear and label) as a nav row.

The main area has the Cloud / Neural switch at top right and the composer bottom-centre (820px).

## 9. Knowledge graph: Cloud view (board 03A)

File: `components/graph-canvas.ts` (keep its single-canvas, single-rAF architecture) and `graph-view.tsx`.

- **At rest:** each cluster is a **density field** of points (gaussian around the cluster centroid; opacity `.12 + .68·falloff`; point size 1.1–1.9px). Topics are bright pinpoints (3–6px by weight, soft white glow). **Every link is drawn as a faint hairline** (opacity **.10**). Cluster labels in mono caps sit under each cloud.
- **Drift:** every topic drifts slowly and randomly, bounded to about **±8px x / ±6px y** around its home, on loops of **16–28 s**. Its points, links and label move with it.
- **Hover a cluster:** its points pull into tight swarms on their nearest topic (650 ms, `cubic-bezier(.2,.8,.2,1)`, staggered 0–140ms). Its links go to **.62** (links touching it .26, all others .04). Topic labels fade in (320 ms delay). Other clusters dim to ~35%. A mono readout reads "FLUIDS · 5 NODES · 9 LINKS".
- **Click a node:** uses the §4 press language (spectrum ring and glow).
- Scale: the prototype has 13 nodes; real graphs have hundreds. Scale the points per cluster sensibly (ask for the budget, §12).

## 10. Knowledge graph: Neural view (board 03B)

A second view, chosen with a **Cloud / Neural** glass segmented switch (persist the choice in graph settings).

- A **3D wireframe cube** (edge ~440px at fit zoom) drawn as **three nested outlines** (opacity .34 / .16 / .08, sizes 440 / 426 / 412).
- Inside it, a **neural network**: topics are bright neurons (5–10px, glow) placed in subject regions; smaller neurons (~2.6px, .7 opacity) fill each subject; **synapses**: topic–topic links at .42, neuron links (each neuron to its 2 nearest) at .13. **No mist or particle dust.**
- **Motion:** the cube auto-turns at **one revolution per 80 s**, with a starting pitch of −14°. **Drag** rotates it freely (0.35°/px; pitch clamped ±85°). **Arrow keys** rotate 10° per press. **Double-click** resets the view. **Hovering** the view pauses the auto-turn.
- **Hover a topic:** the §4 spinning spectrum ring around it, its synapses at .9, its neighbours lit, everything else at .05–.3, and a readout such as "BERNOULLI · FLUIDS · 4 SYNAPSES". Labels always face the camera.
- **Decoration:** a faint iridescent haze below the cube (conic spectrum, blur 60px, opacity .16). Mono HUD text in the corners (as in the board).
- **Rendering:** the prototype uses CSS 3D on DOM elements, which won't scale to the real graph. Implement it inside the canvas renderer with your own 3D projection (or ask, §12).

## 11. Not in scope (yet)

The session screen (messages, thinking blocks, quiz/practice docks), settings, setup, Modules and Practice papers pages: **not redesigned**. They inherit the new tokens and material through the shared classes, but don't restyle their layouts.

## 12. Open questions: ask the owner before implementing

1. **Shortcut clash:** the sidebar shows "Search everything · Ctrl K", but ⌘K already opens the model picker (`docs/keyboard.md`). Which shortcut, and does search become a command palette (pages and actions; `cmdk` is installed) or stay session search (⌘⇧F)?
2. **Pinned sessions** are new; there is no pin today. Add pin and unpin to the session "…" menu? Where is it stored?
3. **Module grouping** needs each session's module on `ChatSummary` (`createChat` accepts a module, but the summary doesn't expose it). Confirm the data source.
4. **Session-only stats** (context window and cost from `StatsBar`'s left side) lose their row under the composer. Where should they live in a session?
5. **"New session" caption** above the composer on `/chat/new`: keep, restyle, or drop?
6. **Teach / Practice mode** on home: decided by the two sidebar buttons (New session / New practice), or is a switch needed in the composer tray?
7. **Keyboard focus:** the no-ring law hides outlines. Should keyboard focus show the hover rim (spinning spectrum) instead?
8. **Graph budgets:** points per cluster and neurons per subject for real graph sizes; whether the drift runs when the window is unfocused.
9. **Wordmark:** the board uses the text "Mental Tuition". Keep the current `lh-mark` icon beside it, or text only?
10. **Rollout of §4:** apply hover/press to every button globally via a shared class or primitive, or component by component?

## 13. Suggested order

1. Tokens and ground (no grain, near-black), plus the material classes and §4 interaction.
2. Composer.
3. Sidebar.
4. Cloud view.
5. Neural view and the view switch.
6. Light and Nocturne tuning.

Verify each wave in the desktop app against its board.
