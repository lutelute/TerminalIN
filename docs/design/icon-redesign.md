## Critique

- Source note: the `ICONS` object contains the expected 19 keys. The inline SVG close icon is actually in the drawer header near the title bar; the Windows title-bar close control is a Segoe UI glyph and is outside this proposal.
- Stroke weight shifts between `1.45`, `1.5`, `1.55`, `1.6`, `1.7`, and `1.8`, so adjacent controls do not share the same visual color.
- Optical bounds vary from nearly edge-to-edge rays and arrows to compact symbols with much more empty space. At 14–18 px this makes nominally equal icons appear to have different sizes.
- The set mixes sharp boxes, rounded strokes, tiny filled dots, dense compound symbols, and unrelated corner treatments, producing a borrowed, grab-bag feel.
- The settings gear is a particularly dense polygon at small sizes; its uneven teeth and many short segments turn muddy before the simpler icons do.
- Several symbols are either too sparse (`plus`, `close`) or too intricate (`fill`, `sparkle`, `settings`) relative to their neighbors, weakening scanability in the title bar.

## Design Spec

- **Grid:** Draw every icon in a `0 0 24 24` view box, centered optically on `(12, 12)`. Use a primary live area of `4–20`; circular or diagonal details may extend to `3.5–20.5` when needed for equal apparent size.
- **Stroke:** Use exactly `1.6` everywhere. The outer SVG owns `fill="none"`, `stroke="currentColor"`, `stroke-width="1.6"`, `stroke-linecap="round"`, and `stroke-linejoin="round"`. Do not use per-icon stroke-weight corrections, opacity, hard-coded colors, or filled decorative accents.
- **Corners:** Use `rx="2"` for window-sized frames and `rx="1.25"` for compact grid cells. Open corners and path bends inherit the round join; do not mix square and rounded corner vocabularies within the set.
- **Optical padding:** Keep roughly `3.5–4` view-box units of clear space on each side, which becomes about `2–3` CSS pixels at the intended 14–18 px render sizes. Short, visually light marks such as `plus` and `close` may use a slightly longer span to balance enclosed icons, but must remain inside `6–18`.
- **Geometry:** Prefer integer and half-unit anchors, symmetric construction, and gaps of at least `1.5` units between independent strokes. Keep important internal details at least `2` units long so they survive downscaling.
- **Complexity:** Use one silhouette plus at most one supporting detail where possible. Dense concepts should be reduced to repeatable primitives: four equal cells for grids, concentric circles plus evenly spaced teeth for settings, and two clearly separated sparkles.
- **Theme behavior:** All marks inherit `currentColor`; there are no theme-specific fills or colors. Contrast, hover, disabled, and active states remain the responsibility of the existing button CSS.
- **Integration contract:** The shared wrapper should use the canonical attributes below so every map entry inherits the same rendering rules. The inline title-bar replacements repeat the same attributes because they do not pass through `iconSvg()`.

```js
return `<svg ${extra} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.window}</svg>`;
```

## New ICONS map

```js
const ICONS = {
  search: '<circle cx="10.5" cy="10.5" r="5.75"/><path d="m14.75 14.75 4.75 4.75"/>',
  sun: '<circle cx="12" cy="12" r="3.25"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.99 5.99l1.42 1.42M16.59 16.59l1.42 1.42M18.01 5.99l-1.42 1.42M7.41 16.59l-1.42 1.42"/>',
  moon: '<path d="M19.25 15.25A7.75 7.75 0 0 1 8.75 4.75a8 8 0 1 0 10.5 10.5Z"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.25"/>',
  tabs: '<path d="M8 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 14 6v2h4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  fill: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.25"/><path d="M6 7.25h2.5M15.5 7.25H18M6 16.75h2.5M15.5 16.75H18"/>',
  refresh: '<path d="M20 5v6h-6"/><path d="M19.25 8A8 8 0 1 0 20 15"/>',
  edit: '<path d="M5 15.5 15.5 5a2.12 2.12 0 0 1 3 0l.5.5a2.12 2.12 0 0 1 0 3L8.5 19 4 20Z"/><path d="m14 7 3 3"/>',
  flipH: '<path d="M12 4v16M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5"/>',
  flipV: '<path d="M4 12h16M7 8.5 12 4l5 4.5M7 15.5 12 20l5-4.5"/>',
  space: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  sparkle: '<path d="M10 3.5c.6 3.6 2.9 5.9 6.5 6.5-3.6.6-5.9 2.9-6.5 6.5-.6-3.6-2.9-5.9-6.5-6.5 3.6-.6 5.9-2.9 6.5-6.5Z"/><path d="M18 14.5c.3 1.7 1.3 2.7 3 3-1.7.3-2.7 1.3-3 3-.3-1.7-1.3-2.7-3-3 1.7-.3 2.7-1.3 3-3Z"/>',
  settings: '<circle cx="12" cy="12" r="5.25"/><circle cx="12" cy="12" r="2.25"/><path d="M12 3.5v3.25M12 17.25v3.25M3.5 12h3.25M17.25 12h3.25M5.99 5.99l2.3 2.3M15.71 15.71l2.3 2.3M18.01 5.99l-2.3 2.3M8.29 15.71l-2.3 2.3"/>',
  window: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17M6.5 6.5h.01M9 6.5h.01"/>',
  drawer: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  maximize: '<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
};
```

## Title bar icon replacements

These snippets replace only the existing inline SVG markup. Keep the surrounding elements, event handlers, titles, and the command button's adjacent `<kbd>⌘K</kbd>` unchanged. The dynamic `view-mode-btn` continues to use the `grid` and `tabs` entries from the map above.

### `drawer-toggle-btn` — four-cell grid

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="4" y="4" width="6.5" height="6.5" rx="1.25"/>
  <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.25"/>
  <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.25"/>
  <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.25"/>
</svg>
```

### `command-btn` — search

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="10.5" cy="10.5" r="5.75"/>
  <path d="m14.75 14.75 4.75 4.75"/>
</svg>
```

### `help-btn` — help

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="8.25"/>
  <path d="M9.75 9.25a2.5 2.5 0 1 1 3.2 2.4c-.65.25-.95.75-.95 1.6v.5M12 17h.01"/>
</svg>
```

### `settings-btn` — settings

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="5.25"/>
  <circle cx="12" cy="12" r="2.25"/>
  <path d="M12 3.5v3.25M12 17.25v3.25M3.5 12h3.25M17.25 12h3.25M5.99 5.99l2.3 2.3M15.71 15.71l2.3 2.3M18.01 5.99l-2.3 2.3M8.29 15.71l-2.3 2.3"/>
</svg>
```

### `maximize-btn` — maximize and restore states

The `mx-out` and `mx-in` class names are intentionally unchanged so the existing `body.is-maximized` selectors continue to switch the two paths.

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path class="mx-out" d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>
  <path class="mx-in" d="M4.5 9H9V4.5M19.5 9H15V4.5M4.5 15H9v4.5M19.5 15H15v4.5"/>
</svg>
```

### Drawer-header close — close

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="m6 6 12 12M18 6 6 18"/>
</svg>
```

## Disambiguation (v2)

### Judgment rationale

The reported collision is present in the applied source: `drawer-toggle-btn` contains the same four-cell drawing as `ICONS.grid`, while `updateViewModeButton()` renders `ICONS.grid` in `view-mode-btn` whenever grid mode is active. They are unrelated actions and must not share a mark.

One source detail differs from the abbreviated title-bar order in the request. The static controls are ordered as described, but `render()` also inserts `plus`, `fill`, `sparkle`, and the complete grid selector into `#titlebar-controls` before `command-btn`. That runtime group exposes two more same-mark/different-function collisions worth fixing now.

| Pair or family | Judgment | v2 decision |
|---|---|---|
| Inspector drawer vs. grid view | Exact collision; both currently show four equal cells. | Give the inspector a left-side panel plus list-lines silhouette. Keep the four-cell mark exclusive to grid view. |
| `window` / `terminal` / `drawer` | Confirmed near-collision at 14 px because all three begin as nearly identical rounded frames. | Use three different macro silhouettes: overlapping panes for an external window, an unframed `>_` prompt for a terminal, and a narrow side panel with list lines for the inspector. |
| Fill terminals vs. grid view | The four outlined cells make `fill` read as another grid-mode control. | Replace the cells with two stacked terminal prompts: repetition means “many/fill,” while a single prompt means “terminal.” |
| Preferences vs. yabai SA status | Exact transient collision: both use `settings` until the async SA check replaces one with `✓` or `!`; a failed check can leave both gears visible. | Add an `integration` plug glyph for the SA status placeholder. Reserve the gear for Preferences. |
| Retile vs. AI-color busy state | Exact transient collision: Retile uses `refresh`, and `runAiColorize()` also changes the adjacent AI button to the same non-animated refresh mark. | Add a `busy` hourglass for AI processing. Reserve the circular arrow for Retile. |
| Command button vs. command search field | Intentional semantic reuse, not a conflict. In the current source the second magnifier is in the command palette, not a drawer search box. Both mean searching the same command system, and `⌘K` distinguishes the launcher. | Keep `search` unchanged in both locations. |
| Grid-size text vs. grid/tabs mode | Related concepts, but `2×2` text communicates dimensions while the four-cell/tab silhouettes communicate presentation mode. | Keep unchanged. |
| Previous/next/pick Space controls | The common arrow denotes one action family, and rotation supplies the direction. | Keep unchanged. |
| Theme, Help, Preferences, Maximize | Sun/moon, question mark, gear, and outward/inward corners remain distinct in outline and meaning. | Keep unchanged. |

### New SVG path data

Replace the four existing entries and add the two new entries below inside `const ICONS`. These are inner SVG strings and inherit the existing `24×24`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.6"`, round-cap, and round-join wrapper.

```js
// Replacements
drawer: '<rect x="3.5" y="4" width="5.5" height="16" rx="1.5"/><path d="M12.5 6.5h7M12.5 12h7M12.5 17.5h7"/>',
terminal: '<path d="m4.5 5.5 6.5 6.5-6.5 6.5M13.5 18.5h6"/>',
window: '<rect x="3.5" y="7.5" width="14.5" height="12" rx="2"/><path d="M7 7.5V6a2 2 0 0 1 2-2h9.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H18"/>',
fill: '<path d="m4.5 4 3.5 3-3.5 3M10.5 10h8M4.5 14l3.5 3-3.5 3M10.5 20h8"/>',

// Additions
integration: '<path d="M8 3.5v4M16 3.5v4M6 7.5h12v2a6 6 0 0 1-12 0ZM12 15.5v5"/>',
busy: '<path d="M7 4.5h10M7 19.5h10M8 4.5c0 3.75 1.15 5.25 4 7.5-2.85 2.25-4 3.75-4 7.5M16 4.5c0 3.75-1.15 5.25-4 7.5 2.85 2.25 4 3.75 4 7.5"/>',
```

The title-bar inspector button is inline rather than map-driven. Replace its current four-cell SVG with the same `drawer` geometry so the title bar and command palette use one semantic mark:

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3.5" y="4" width="5.5" height="16" rx="1.5"/>
  <path d="M12.5 6.5h7M12.5 12h7M12.5 17.5h7"/>
</svg>
```

### Exact swap locations

Line numbers below refer to the grounded `workspace.html` reviewed for this v2 proposal; the element and function names are the durable integration anchors if later edits move those lines.

| Icon | Definition or inline location to change | Current consumers affected |
|---|---|---|
| `drawer` | Replace the inline SVG inside `#drawer-toggle-btn` at `workspace.html:1337–1338`; replace `ICONS.drawer` at `workspace.html:1420`. | Title-bar inspector toggle; command-palette “Open workspace inspector” item at `workspace.html:1603`. |
| `terminal` | Replace `ICONS.terminal` at `workspace.html:1410`. | Command-palette “Create embedded terminal” at `workspace.html:1597` and each PTY slot result at `workspace.html:1616`. |
| `window` | Replace `ICONS.window` at `workspace.html:1419`. | External snapped-window results at `workspace.html:1625` and the `iconSvg()` fallback at `workspace.html:1426`. |
| `fill` | Replace `ICONS.fill` at `workspace.html:1411`. | Command-palette fill action at `workspace.html:1598` and title-bar `fillTermBtn` at `workspace.html:3714`. |
| `integration` | Add the new key inside `ICONS` near `settings`, then change `saBtn.innerHTML = iconSvg('settings')` to `iconSvg('integration')` at `workspace.html:3587`. | macOS yabai SA status placeholder only; the later `✓`/`!` status replacement remains unchanged. |
| `busy` | Add the new key inside `ICONS` near `refresh`, then change the busy assignment in `runAiColorize()` from `iconSvg('refresh')` to `iconSvg('busy')` at `workspace.html:2951`. | AI-color processing state only; keep the restoration to `iconSvg('sparkle')` at `workspace.html:2959` and Retile's `iconSvg('refresh')` at `workspace.html:3497`. |

No swap is proposed for `ICONS.grid`, `ICONS.tabs`, `ICONS.search`, `ICONS.settings`, or `ICONS.refresh`; their meanings become unambiguous once the conflicting consumers above move to dedicated marks.
