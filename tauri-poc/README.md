# Orca Tauri PoC

This folder is an isolated feasibility check for hosting Orca's existing web client in Tauri.
It does not replace Electron and it does not change the desktop runtime contracts.

## Run on Windows

From the repository root:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vite --config vite.web.config.ts --host 127.0.0.1 --port 5174
```

In a second terminal:

```powershell
cargo run --manifest-path tauri-poc/src-tauri/Cargo.toml
```

The Tauri window loads the same `src/renderer/web-index.html` entry used by the existing browser
client. A small host badge confirms that Rust responded to a Tauri command; it is only PoC
instrumentation and is not part of Orca's product UI.

For the real paired UI, start the Orca runtime separately and navigate the WebView to its
`web-index.html` pairing URL:

```powershell
$env:ORCA_DEV_USER_DATA_PATH="$PWD\.cache\tauri-runtime-profile"
$env:ORCA_BACKGROUND_LAUNCH="1"
node config/scripts/orca-dev.mjs serve --port 6878 --json --project-root $PWD
```

The Tauri shell does not yet own runtime startup, shutdown, upgrades, or profile lifecycle.

## Native capability slice

The web preload surface now detects Tauri without changing the browser or Electron paths. The
first native slice covers the low-risk operations that the renderer already expects:

- system clipboard text read/write with the existing 16 MiB safety limits;
- native file and directory pickers for attachments, images, audio and folders;
- opening approved external URL schemes, opening a local path, and revealing a path in the file manager;
- local path existence checks and non-overwriting file copies;
- PNG repository icon loading with the same 256 KiB limit as Electron;
- minimize, maximize/restore, fullscreen, zoom, and the existing guarded close handshake;
- native context menu, window-state events, and the renderer's custom Windows/Linux titlebar;
- dropped-path validation and notification sound-path validation.

The adapter is in `src/renderer/src/web/tauri-native-bridge.ts`. It is deliberately layered over
the existing web API: a normal browser keeps the current fallbacks, Electron keeps its preload
IPC, and Tauri only replaces the operations backed by Rust or Tauri plugins.

## Scope

Validated by this PoC:

- Tauri can host the existing Web renderer without forking the UI.
- A Rust command can be called by the WebView and return host metadata.
- The existing Web pairing flow remains the boundary for runtime access.
- The paired renderer reaches its landing screen with `window.api` installed and the Tauri window
  chrome active.

Not migrated by this PoC:

- Electron main-process IPC and BrowserWindow behavior.
- Local terminal/PTY ownership, WSL, SSH, native Windows modules, and process supervision.
- Local filesystem workspace ownership and mutation authorization (the paired runtime remains the
  authority for workspace files).
- Runtime startup/shutdown/update supervision, single-instance handling, tray/dock integration,
  native notification click routing, multi-window support, browser panes, and release packaging.
- Full native image/file clipboard support and the complete application menu/shortcut surface.
- macOS traffic lights and platform-specific behavior.
- Windows/WSL/SSH native-boundary audits and production signing.

Those systems are the high-risk part of a Tauri migration and still belong to Electron until a
separate design and compatibility plan is approved.
