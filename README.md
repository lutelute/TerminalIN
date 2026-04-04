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

## License

ISC
