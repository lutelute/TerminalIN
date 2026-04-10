![TerminalIN Banner](assets/banner.png)

# TerminalIN

macOS terminal workspace manager. Group, snap, and manage multiple terminal windows as a unified workspace.

## Features

- **Snap & Release** — Snap external Terminal.app / iTerm2 windows into a 2x2 or 3x3 grid
- **Workspace Focus** — Click the workspace sidebar to bring all snapped terminals to front
- **Grid Terminals** — Embedded Electron terminal windows (xterm.js + node-pty) alongside external terminals
- **Sidebar Control** — Compact, always-on-top sidebar with workspace management
- **Multi-Display** — Adaptive grid sizing based on your display configuration

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npx electron .

# Build for macOS
npm run build
```

## Architecture

```
Sidebar (Electron, alwaysOnTop)
├── Embedded terminals (xterm.js)
├── Snapped external terminals (Terminal.app, iTerm2, etc.)
└── Grid terminals (Electron BrowserWindows)

Swift Daemon (background process)
├── Window enumeration (CGWindowList)
├── Window positioning (AXUIElement)
└── Window raising (activate + AXRaise)
```

## Requirements

- macOS 14+
- Node.js 20+
- Accessibility permission (System Settings > Privacy > Accessibility)

## Integration with Other Tools

TiN v1.2.0+ exposes a public integration protocol for third-party tools to
read TiN's state and send commands.

- **State files** (read-only, `~/Library/Application Support/TiN/`):
  - `info.json` — TiN process info and capability list
  - `snapped.json` — currently snapped windows
- **URL scheme** (fire-and-forget):
  - `tin://raise?app=X&windowNumber=Y` — raise a specific window
  - `tin://workspace/focus` — raise active workspace
  - `tin://workspace/switch?id=N` — switch workspace
  - `tin://terminal/new?cwd=X` — create grid terminal

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full specification.

### AtelierX Integration

If you use [AtelierX](https://github.com/lutelute/AtelierX) (window kanban
board), install the companion plugin to have AtelierX automatically exclude
TiN-managed terminals from its Grid arrangement:

1. In AtelierX: **Settings → Plugins → Install from GitHub**
2. Enter `lutelute/TerminalIN:atelierx-plugin`
3. Enable the plugin

The plugin lives in this repository under [`atelierx-plugin/`](atelierx-plugin/).
It is **not** bundled into the TiN.app DMG — TiN works fully standalone.

## License

ISC
