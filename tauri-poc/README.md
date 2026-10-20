# Orca Tauri desktop

This folder is the Tauri desktop migration slice. It hosts Orca's existing Web renderer without
forking the UI and starts the existing `orcad` Node runtime as a Tauri-owned sidecar in development.
It is not yet a release-ready replacement for Electron.

## Run on Windows

From the repository root, the default development launcher is Tauri:

```powershell
pnpm run dev
```

The explicit Tauri alias is also available as `pnpm run dev:tauri`. The legacy Electron launcher is
kept as `pnpm run dev:electron` while the remaining production and release paths are migrated and
validated.

The command rebuilds the development `orcad` bundle before starting Tauri, so a fresh checkout does
not require a hidden prerequisite. To iterate on the Rust shell without rebuilding the Node bundle,
run `node tauri-poc/scripts/run-dev.mjs` after the bundle has been built once.

It starts Vite alongside the Rust shell, launches the native window with
`ORCA_BACKGROUND_LAUNCH=1` by default, and supplies the current Node executable automatically.
Set `ORCA_BACKGROUND_LAUNCH=0` only when you explicitly want an interactive development window.
The development server uses a strict port so a stale or unrelated Vite process cannot make Tauri
silently load the wrong renderer.

App reload, restart and relaunch all run the shared editor/session checkpoint first. A native
restart waits for the owned runtime's graceful shutdown without killing the persistent terminal
daemon. In development the launcher handles the restart exit code and keeps Vite alive; packaged
builds use Tauri's exit/restart lifecycle so the single-instance lock is released before relaunch.

To verify that lifecycle on Windows without showing a window, start the development app with
`ORCA_BACKGROUND_LAUNCH=1` and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9224`,
then run in another terminal:

```powershell
$env:ORCA_BACKGROUND_LAUNCH="1"
node tauri-poc/scripts/check-restart.mjs
```

The Playwright CDP check refuses visible windows or a different checkout. It checks that reload
preserves the runtime, restart/relaunch replace it, the renderer reconnects, and Vite stays online.
Screenshots are saved in `.cache/tauri-restart-check`. This is a startup/restart smoke check, not
proof of full terminal/session restoration or cross-platform parity.

The same hidden development app can verify real terminal directory changes:

```powershell
$env:ORCA_BACKGROUND_LAUNCH="1"
node tauri-poc/scripts/check-terminal-cwd.mjs
```

This creates one floating terminal in an isolated scratch folder, checks the initial directory,
executes `cd` into a path containing spaces, Unicode and URI-special characters, and checks the
host-reported directory plus the 80x24 viewport. It closes only its own terminal and writes evidence
to `.cache/tauri-cwd-check-latest.json`. Like the restart check, it refuses visible windows and other
checkouts. It never restarts a terminal daemon. A daemon kept alive from an older build keeps its
old shell bootstrap; validate shell-bootstrap changes with a fresh isolated daemon, not by stopping
unrelated terminals.

The equivalent manual setup is:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node tauri-poc/scripts/build-runtime.mjs
pnpm exec vite --config vite.web.config.ts --host 127.0.0.1 --port 5174 --strictPort
```

In a second terminal:

```powershell
$env:ORCA_DEV_REPO_ROOT=(Get-Location).Path
$env:ORCA_BACKGROUND_LAUNCH="1"
cargo run --manifest-path tauri-poc/src-tauri/Cargo.toml
```

The Tauri process starts the development `orcad` bundle, imports its runtime-scoped pairing offer
before mounting the renderer, and asks the existing launcher IPC contract to stop it on exit. The
development runtime is deliberately built into `.cache/orcad-dev`; it is not a release artifact.

For a packaged build, `beforeBuildCommand` also builds `orcad`, stages the bundled Node runtime and
the supervisor into `tauri-poc/resources`, and then builds the Tauri bundle. That path requires the
same patched `node-pty` native toolchain as the Electron release build; it must not silently fall
back to an upstream `node-pty` binary.

Packaged Tauri uses the same default runtime profile as Electron (`%APPDATA%/Orca` on Windows,
`~/Library/Application Support/Orca` on macOS, and `$XDG_CONFIG_HOME/Orca` or `~/.config/Orca` on
Linux). Set `ORCA_TAURI_RUNTIME_PROFILE` for an isolated test profile. The development default
remains `.cache/tauri-orcad-profile` so it cannot lock or mutate a running Electron profile.

## Native capability slice

The web preload surface now detects Tauri without changing the browser or Electron paths. The
first native slice covers the low-risk operations that the renderer already expects:

- system clipboard text read/write with the existing 16 MiB safety limits;
- Windows clipboard images and Explorer-style file paths, including bounded PNG conversion,
  runtime/structured-chat image attachment staging, and workspace-root authorization;
  restored native-chat composer pastes re-verify against the same
  `ORCA_USER_DATA/native-chat-pastes` folder the paired runtime writes to —
  `poc_clipboard_restore_native_chat_pastes` mirrors Electron's realpath
  containment check (named and real folder, symlinks resolved, 256-entry cap)
  so a draft only reattaches files still inside Orca's own paste folder;
- native file and directory pickers for attachments, images, audio and folders;
- opening approved external URL schemes, opening a local path, and revealing a path in the file manager;
- local path existence checks and non-overwriting file copies;
- PNG repository icon loading with the same 256 KiB limit as Electron;
- minimize, maximize/restore, fullscreen, zoom, and the existing guarded close handshake;
- native context menu, window-state events, and the renderer's custom Windows/Linux titlebar;
- dropped-path validation and notification sound-path validation.
- structured local external-editor launching for the default `code` launcher, Cursor, and
  configured executable paths, plus Windows WSL-owned Linux paths through VS Code/Cursor remote
  arguments or a validated `\\wsl.localhost` path; the native boundary rejects compound shell
  commands instead of evaluating renderer-provided command text.
- local file staging with symlink and identity checks, chunked uploads into the paired runtime,
  and structured-chat attachment uploads. Proven live by
  `tauri-poc/scripts/check-external-upload-stage.mjs` (renderer camelCase wire shape plus chunk readback).
- remote SSH file and folder downloads through the host-owned SFTP transport, with native destination
  pickers, temporary-path cleanup, collision checks, and atomic folder promotion.
- local external-file imports with document-folder authorization, recursive copy, collision-safe
  names, symlink rejection, and rollback on partial directory failure.
- native save dialogs for one-shot downloads and streamed file downloads, with atomic temporary
  files and overwrite rollback.
- single-instance enforcement: a second launch reuses the existing Tauri process instead of
  starting another `orcad` owner, and forwards skill-share links plus supported local documents
  to the existing renderer window. Proven live by `tauri-poc/scripts/check-second-instance.mjs`.
- native desktop notifications through Tauri's notification plugin; the existing renderer
  notification contract remains the compatibility layer, including notification ids, dismissal,
  and click-to-focus routing back into the workspace.
- runtime-owned plugin discovery, consent, enablement, worker execution, logs, installation,
  removal, and marketplace preview/install/rollback through the same RPC boundary used by
  paired clients.
- a native tray/menu-bar entry with Open Orca, Settings, and Quit actions; an explicit tray
  Settings action is queued until the renderer mounts, so it is safe to click while Orca is
  starting in the background. Windows ensure/attention/rebuild round-trips against the live shell in `tauri-poc/scripts/check-tray.mjs`; menu-item clicks still need a visible run with OS-level input, while the id-to-action routing behind those clicks (`tray_menu_route`) is covered by `system_tray` unit tests.
- a native File/Edit/View/Help application menu with settings, quit, clipboard actions, reload,
  zoom, fullscreen, worktree palette, Appearance toggles, left/right sidebar, setup-guide,
  feature-tour, and crash-report commands routed through the shared renderer UI API.
  The View menu mirrors Electron's order — Reset/Zoom In/Zoom Out before
  Worktree Palette, then Fullscreen, then the Appearance submenu (which owns
  the two sidebar toggles). Popup-menu clicks pop the _installed_ application
  menu so accelerators, hints, locale labels and Appearance checkmarks match
  the menu bar exactly; the pre-PoC custom context menu is gone.
  Windows' "minimize to tray on close" works through the same surface Electron
  uses: the renderer pushes the setting into Rust state on every save, and
  the native `CloseRequested` handler consults it before prompting — so both
  the OS X button and the renderer-drawn X take the same branch. The
  one-shot tray-minimize notice goes through `tauri-plugin-notification` and
  the `trayMinimizeNoticeShown` flag persists through `window.api.ui.set`.
- a signed updater bridge for version/status checks, download progress, and quit-and-install;
  release endpoints and the public key are intentionally supplied per build through
  `ORCA_TAURI_UPDATER_ENDPOINTS` and `ORCA_TAURI_UPDATER_PUBLIC_KEY`.
- host-owned SSH target storage, `~/.ssh/config` import and picker resolution, direct ssh2
  connect/disconnect, remote directory browsing, and direct port forwards through the runtime
  RPC boundary, including persistence across reconnects and app restarts. Password/passphrase
  prompts are bridged through runtime client events. Connection-state fan-out is live too:
  `window.api.ssh.onStateChanged` forwards orcad `sshStateChanged`, proven with a refused-loopback
  connect in `tauri-poc/scripts/check-ssh-direct.mjs` (which also pins the shared failure contract:
  connect rejects like Electron main and no state is retained). `ssh.testConnection` now probes through orcad (borrowed transport, suppressed fan-out),
  proven live by the refused-loopback run in `check-ssh-direct.mjs` which reports the real
  `ECONNREFUSED` instead of the retired stub.
  Password-authenticated direct transport is proven live by `tauri-poc/scripts/check-ssh-transport.mjs` (loopback ssh2 target, bridged password prompt, `testConnection` success with a connected state); its full-`connect` attempt pins the shared dev boundary of reporting `artifacts_unavailable` with no retained state, identical to Electron. Still stubbed on the web client:
  `needsPassphrasePrompt`. `ssh.needsPassphrasePrompt` now answers from orcad with the
  desktop rule (a declined credential reprompts; otherwise prompt only when the last
  connect needed a passphrase and no live connection caches it), proven live by
  `tauri-poc/scripts/check-ssh-needs-passphrase.mjs` (fresh loopback target answers a
  real boolean false, and an empty targetId is rejected by the orcad schema while the
  retired stub ignored its args). `listDetectedPorts`/`onDetectedPortsChanged` stay
  stubbed on the web client, matching Electron's direct path where the handler serves
  an empty list and nothing ever emits the event (detected ports only arrive over the
  managed-server relay); the managed-server relay ladder still
  remains on the Electron path.
  The legacy relay bridge now runs on orcad too: the bridge host is installed in the Tauri
  runtime (leases, connection, client events and telemetry mirror the Electron wiring), its
  seven pane channels are `ssh.*LegacyRelayBridgedPane*` RPC methods, pane lifecycle travels
  over four new runtime client events, and the managed-server decision keeps a `bridged`
  connect up like Electron instead of failing closed — proven live by
  `tauri-poc/scripts/check-ssh-legacy-relay-bridge.mjs` (empty pane list, `not-bridged`
  attach verdict, schema rejection of an empty pty id). Serving a real relay-era terminal
  end to end still needs a host that runs one, which no probe machine here provides.
- WSL distro hosts when the existing internal WSL gate is enabled: distro discovery, add/remove,
  connect/reconnect, visible-work liveness, account environment propagation, status snapshots and
  status events all run inside `orcad` through the same runtime RPC boundary. The Tauri client keeps
  the Electron gate and disabled-build behavior instead of booting WSL in the background.
- Claude and Codex account add, re-authenticate, cancel, and sign-in-link flows through a narrowly
  negotiated Tauri desktop capability; ordinary browser clients remain read-only for credentials.
- Agent Session History now runs on the paired runtime for Tauri: session lists, conditional refresh,
  Claude/OMP subagent transcripts, full first prompts, search-index consent/clearing, and scan-progress
  snapshots use the existing runtime RPC contract instead of Electron IPC.
- MiniMax cookie/API-key, GLM Coding Plan API-key, OpenCode Go API-key, Cursor status, and Grok
  status now use the same local runtime boundary in Tauri; secret values are persisted by the host
  and credential mutations invalidate and refresh provider usage state.
- runtime-backed PTY streams with output replay, viewport control, input acknowledgments,
  sequenced input replay across pane reattach, signals, buffer reset, and terminal cleanup.
- confirmed terminal input uses negotiated stream acknowledgments, or the bound host's unary
  write acknowledgment for older streams when settlement is required. An ambiguous acknowledgment
  never causes an automatic second write through another transport.
- replacement terminal streams ignore late output, acknowledgments and close events from the
  previous stream; unverified stream endings preserve the renderer binding and pending input
  instead of claiming that the execution host's process exited.
- proven numeric exit statuses through the multiplex `end` event: the host's exit code now
  rides the stream verdict to `window.api.pty.onExit`, so `exit 42` in PowerShell surfaces 42
  in Tauri exactly as Electron reports it over IPC. Hosts that end without a code still read
  as 0 for a proven finish and 1 otherwise.
- true OS-signal delivery for Ctrl+C on Windows: `window.api.pty.signal('SIGINT')` now travels
  `terminal.signal` to the daemon provider's `sendSignal` instead of writing the ETX byte the
  ConPTY ingest ignores, so the pane exits with code 1 exactly like Electron's `pty:signal`
  IPC. Hosts that predate the controller method answer `signaled: false` and the renderer
  falls back to the legacy interrupt write. Covered live by
  `tauri-poc/scripts/check-terminal-ops.mjs`.
- fresh foreground-process confirmation on Windows: `window.api.pty.confirmForegroundProcess`
  now travels `terminal.confirmForegroundProcess` to the daemon provider instead of resolving
  null, so the fresh uncached scan agrees with the cached read exactly like Electron's
  `pty:confirmForegroundProcess` IPC. SSH panes and ownerless ids stay fail-closed (null reads
  as "no new evidence"). Covered live by `tauri-poc/scripts/check-terminal-confirm.mjs`.
- rich-markdown right-click menus on Tauri and the paired web client: a renderer-owned DOM menu
- process-tree reaping on Windows pane close: killing a pane also reaps grandchildren
  started from its shell (the same per-PTY job-object behavior Electron relies on), so no
  orphaned processes linger after close. Covered live by
  `tauri-poc/scripts/check-terminal-kill-tree.mjs`, which starts a marker `ping` grandchild,
  kills the pane, and asserts the PID is gone from a second pane.
- rich-markdown right-click menus on Tauri and the paired web client: a renderer-owned DOM menu
  mirrors Electron's native template item for item (Add link, the Format/Paragraph/Insert
  submenus, the Table submenu with header-row disabled states, and Cut/Copy/Paste/Select all)
  and dispatches the same payloads through `runRichMarkdownContextCommand`, so formatting and
  table edits behave exactly like Electron's `rich-markdown:context-command` IPC. The menu is
  fully keyboard operable like the native one (arrows/Home/End, Enter/Space, Right/Left for
  submenus, Escape closes submenu then menu, Tab dismisses). Covered by
  `rich-markdown-dom-context-menu.test.tsx` (gate, model parity, keyboard model, and dispatches
  against a real editor) and live by `tauri-poc/scripts/check-rich-markdown-dom-menu.mjs`
  (gate on, model order, and a real right-click → Bold round-trip when a markdown editor is
  open; the probe never opens files itself so the shared dev workspace stays untouched).
- host-owned PTY buffer snapshots for Tauri remounts, including grid geometry, output sequence,
  scrollback and provider-backed authoritative recovery through `terminal.bufferSnapshot`.
- live terminal directories through the execution-host-owned `terminal.cwd` RPC, fenced against
  PTY replacement. PowerShell now publishes escaped filesystem URIs from the existing prompt
  wrapper so Windows can track `cd` without guessing from prompt text. Older hosts fall back only
  when the RPC is unsupported; interrupted connections never masquerade as a current directory.
- viewport geometry parity on Windows: the spawn size reaches ConPTY (the shell reports it),
  a viewport claim drives ConPTY to the new size, and a bare resize stays observe-only per the
  multiplex ownership contract — the same rule Electron's remote panes follow through the shared
  orcad host — while `getSize` bookkeeping tracks every step. Covered live by
  `tauri-poc/scripts/check-terminal-viewport.mjs`.
- terminal stop, interrupt, buffer-clear and input-mode-reset requests routed to the pane's encoded
  environment owner, even after the user selects a different runtime connection.
- detaching a live terminal pane into a new tab commits the existing host-owned layout mutation
  before returning, then transfers agent-status and orchestration ownership keys. Browser-only
  behavior is unchanged; Tauri refuses unverified or not-yet-bound PTYs instead of guessing an owner.
- local terminal-daemon management through the same runtime boundary as Electron: async-I/O health,
  session inventory, per-session and bulk termination, daemon restart, and severed-daemon recovery.
- local editor log tailing with bounded chunk reads, file identity checks, rotation detection,
  and native change events; the renderer keeps the same live-tail decoder used by Electron.
- browser panes backed by Tauri child WebViews: create/close, navigation/history, zoom, find,
  Windows WebView2 viewport and touch emulation through the DevTools protocol (unsupported
  platforms fail closed), downloads,
  permission and popup events, a renderer-owned context menu, persisted
  default/isolated session profiles, the annotation viewport bridge used by grab mode, and
  grant-scoped local document previews with CSP, directory authorization, failure events, and
  external-link interception. Grant minting accepts the renderer camelCase owner shape, and
  unlisted text extensions serve as octet-stream (binary-sniffed content keeps the 415).
  On Windows, local development hosts also expose the certificate failure overlay and a
  page-scoped, certificate-fingerprint-bound Proceed Anyway flow, covered end to end
  by `tauri-poc/scripts/check-browser-certificate-exception.mjs` (-202 challenge, bogus-challenge rejection, proceed-and-load, page-scoped rechallenge with no bypass leak across pages); production policy remains to be completed.
- the Workspace Space secondary window: native Tauri window creation/reuse/close, state and
  worktree-reveal event routing between the main renderer and the Space renderer, background
  launch behavior that never activates the window, local directory size analysis with progress,
  cancellation, and a profile-scoped cached snapshot. Remote worktrees remain explicit
  unavailable rows until an SSH/runtime-owned scan RPC is added. Open/reuse, zoom seeding, analysis, progress, snapshot caching, and cancel behavior are proven live by `tauri-poc/scripts/check-space-scan.mjs`.

The adapter is in `src/renderer/src/web/tauri-native-bridge.ts`. It is deliberately layered over
the existing web API: a normal browser keeps the current fallbacks, Electron keeps its preload
IPC, and Tauri only replaces the operations backed by Rust or Tauri plugins.

## Scope

Validated by this migration slice:

- Tauri can host the existing Web renderer without forking the UI.
- A Rust command can be called by the WebView and return host metadata.
- Tauri owns development `orcad` startup, readiness, pairing, and graceful owner shutdown.
- The renderer can create, restore, interact with, and close runtime-backed terminal panes through
  the same `window.api.pty` contract used by the Electron renderer.
- The packaged resource layout is wired for `orcad`, its supervisor, and the pinned Node runtime;
  release packaging still depends on the native prebuild toolchain being available.
- The existing Web pairing flow remains the boundary for runtime access.
- The paired renderer reaches its landing screen with `window.api` installed and the Tauri window
  chrome active.
- A focused browser child WebView forwards shortcut-grade key events (modifier chords, Escape,
  function keys) to the main window, where the shared global keybindings handle them like local
  keypresses. Verified end to end: one guest press produces exactly one bridge event and one
  re-dispatched window event (`tauri-poc/scripts/check-guest-shortcut.mjs`).
- Local diagnostics status, bounded NDJSON bundle collection, redacted preview files, preview
  opening, preview disposal, upload, and remote deletion are now owned by Tauri Rust commands.
  Upload/delete are enabled only when `ORCA_TAURI_DIAGNOSTICS_TOKEN_ENDPOINT` is configured; the
  renderer never supplies an endpoint or payload.
- Crash report submission is also native. Development builds may point it at a test service with
  `ORCA_TAURI_FEEDBACK_ENDPOINT`; release builds require an HTTPS endpoint.

Not migrated yet:

- Electron main-process IPC and BrowserWindow behavior.
- Paired-runtime client-hosted browser pages: the retained page registry mounts Tauri child
  WebViews through the renderer request bus, syncs bounds after insertion, releases pages after
  native close, and publishes hosted url/title over the host lease. Attach, session eval/detach,
  and page commands are unit-tested, with attach/session/eval/detach verified live on WebView2.
  Client-host cookie import targets the environment client-route jar with per-profile source
  badges: badges are host-owned in a Rust file store (128-entry oldest-first cap, corrupt-file
  tolerant) with a renderer localStorage fallback, and partitions are host-owned too — a Rust
  binding store (environment-scoped SHA-256 derivation, binding fingerprints,
  cross-route-conflict errors, 512-entry LRU) names every jar, page mount and cookie import
  resolve through it, and both layers settle the import (Rust re-resolves the binding;
  the renderer re-checks the live execution host) before reporting success or badging.
  The lease authority itself is host-owned too: the renderer notes page mount/rekey
  and close into a Rust authority store, and cookie import resolves the execution host
  from it (request identity is only a fallback when no lease was noted) and settles
  against it before reporting success. Still missing: legacy-jar migration
  (intentionally deferred — the pre-release scheme has no shipped users to migrate). Naming,
  fingerprinting, and the WebView2 round trip are proven live by `tauri-poc/scripts/check-browser-jar-names.mjs` (derived `persist:tauri-browser-v1-*` partitions, repeat-resolve stability, per-environment
  separation, CDP cookie write/read on the resolved partition). Cross-partition isolation stays
  Windows-blocked: Tauri documents `data_store_identifier` as macOS/iOS-only and drops it on
  Windows (wry profile wiring is absent on Windows), so child webviews share one jar there. so child webviews share one jar there. Authority settle (note/import/close) and source-badge record/list are proven live by check-client-route-partition.mjs, with derivation, idempotent reload, traversal rejection, and LRU eviction covered by the store unit tests.
  Local browser-profile cookie import is a separate
  implemented path, not evidence of remote client-host parity.
- Native crash reports now persist renderer errors, breadcrumbs and dismissal state in the Tauri
  profile, can submit captured or uncaptured reports through the native feedback boundary, and
  can attach the native redacted diagnostic bundle with a report-only retry. Unexpected exits of
  the owned Node supervisor are now captured too: the runtime slot records exits outside owner
  shutdown with the process-gone reason vocabulary (Windows console/taskkill codes count as
  kills), and the next runtime-status poll stores them as pending reports. Id-less submit and
  lookup resolution mirrors Electron too: an explicit request without an id resolves nothing
  instead of auto-picking a pending crash, so Help-menu uncaptured reports never absorb one,
  and dismiss leaves in-flight submissions alone while renderer-error dedupe keys are capped
  oldest-first, proven live by `tauri-poc/scripts/check-crash-report-resolution.mjs` (seeded
  pending report, three-way lookup, dismiss cleanup) with the resolver unit tests. Complete minidump
  attachments still need a native implementation.
- Remaining Electron PTY parity (Windows-native terminal capabilities), plus the SSH managed-server/relay
  ladder's end-to-end serving proof against a host that still runs relay-era terminals (the
  decision, the bridge host, and the `bridged` connect behavior already run on orcad).
  Tauri now exposes renderer-side PTY
  delivery diagnostics; it intentionally does not claim Electron's main-process hidden-delivery
  counters because Tauri does not have that delivery gate.
- Local filesystem workspace ownership and the remaining mutation authorization surface (the
  paired runtime remains the authority for workspace files; document-folder imports are native).
- Session History deletion now uses the Tauri-safe OS-trash boundary exposed by the paired runtime;
  proven live by `tauri-poc/scripts/check-ai-vault-delete.mjs` (a real file is trashed through the
  native OS boundary while disallowed, pathless, transcript-less, and out-of-roots plans are
  refused; the Windows `\\?\`-prefixed canonical paths the first probe run exposed now match
  their roots). End-to-end verification across packaged profiles is still part of release validation.
- Packaged runtime staging/update supervision, tray menu-click routing plus the full dock attention
  behavior, certificate exception production policy and non-Windows support,
  SSH/remote document-preview transfer, and
  release packaging.
- Browser guest-shortcut forwarding now suppresses handled chords in the guest: the main
  renderer publishes the live keybinding-registry chord set, Rust pushes it into every guest
  page load and re-pushes it into all live guests whenever the set changes
  (remote guests hold no invoke grant, so they never pull it), and the guest
  `preventDefault`s a handled keydown while still bridging it
  (`tauri-poc/scripts/check-guest-suppress.mjs`). Automation key/text input marks the page
  (depth-nested with a dispatch-lag grace), and Rust drops marked keys at the bridge so they
  never run app shortcuts (`tauri-poc/scripts/check-guest-agent-input.mjs`).
  A guest-held Ctrl+Tab switcher commits on Control release like a local press: the guest arms on
  the Ctrl-held Tab release (the host may consume the Ctrl+Tab keydown as an accelerator) and
  reports the bare Control release as a commit, and the main window synthesizes the Control keyup
  so the shared overlay cannot strand (`tauri-poc/scripts/check-guest-ctrl-tab.mjs`). Bare modifier taps also cross the bridge in down/up order so the main window can complete a double-tap exactly like a local press (`tauri-poc/scripts/check-guest-double-tap.mjs`). Shift-held chords cross too, so typing a capital between two Shift taps resets the shared detector instead of phantom-triggering it, while plain typing still lands in the guest (`tauri-poc/scripts/check-guest-shift-chord.mjs`).
  Plain typing never crosses the bridge. Ctrl/Meta+wheel zoom crosses the same
  bridge as a `wheel-zoom` event: the guest consumes Shift/Alt-free Ctrl (Meta on
  macOS) wheels and posts a direction the main window turns into the shared
  `ui:zoomBrowserPage` path, matching Electron's `before-mouse-event` forwarding.
- Linux file clipboard support is wired: writes spawn `wl-copy`/`xclip` with the
  desktop-appropriate MIME (`x-special/gnome-copied-files` for GNOME-family,
  `text/uri-list` for KDE), reads pull `text/uri-list` through `wl-paste`/`xclip -o`,
  and the same authorization + reserved-name rules apply as on Windows. macOS file
  pasteboard write/read still needs `NSPasteboard` wiring. The remaining application-menu/shortcut items
  and Linux package recovery for updater failures. The macOS App menu is implemented: the
  app-named section owns About, updates and Settings plus the Services and Hide roles, while
  File exists only off macOS and About/updates stay at the Help tail only off macOS. Force Reload now bypasses the HTTP cache like Electron: the menu drives CDP Page.reload with ignoreCache on the main window (plain-reload fallback), and the Mod+Shift+R chord is claimed by the Tauri-gated renderer shortcut path (`tauri-poc/scripts/check-main-force-reload.mjs`). Undo/redo no longer preempt the focused surface either: off macOS they are display-only hints (native roles stay on macOS) whose clicks route per-surface through the renderer (`tauri-poc/scripts/check-main-edit-actions.mjs`).
  Edit > Copy/SelectAll/Paste now follow the focused browser guest too: each guest
  init script reports `focus`/`blur` over the shortcut bridge so the host knows the
  most recently focused page, and the menu handler evaluates `document.execCommand`
  inside that child webview instead of bouncing off the unfocused main window —
  matching Electron's `webContents.getFocusedWebContents()` branch, proven live by `tauri-poc/scripts/check-menu-guest-edit.mjs` (selectAll selection plus copy event through the menu route, unknown-command rejection, closed-guest fallback). Rebindable
  menu shortcuts also stay live: the renderer pushes each registry change through
  `poc_menu_set_hints` so Zoom/Sidebar/Settings/Force Reload hints track user
  overrides the way Electron's `shortcutLabel` rebuild does.
  Every menu label — the section titles (File/Edit/View/Window/Help plus the
  Appearance submenu) and the label-only entries — is also locale-aware now:
  `useTauriMenuText` subscribes to `i18n.language` and folds the resolved
  `menu.*` string into the same `baseText` payload so locale switches repaint
  the native menu without a rebuild. Modifier-click Check for Updates variants
  are read on Windows through `GetAsyncKeyState` at click time and forwarded
  as `UpdateCheckOptions`, and macOS modifier flags need a Cocoa binding before
  they can be read inside the menu action.
  Pinned build jumps (`channel` + `targetTag`) and the Shift/Ctrl variants now
  resolve against the GitHub release list in `poc_updater_check` — same
  newest-newer selection Electron runs over its atom feed, perf tags excluded
  from the prerelease series — and report availability with the release-page
  URL, while installation of channel builds stays manual with a guided
  download error (mirroring Electron's own pinned-dev-channel behavior on
  signed builds). Dismissing an un-acted channel card abandons the pinned session
  and returns status to idle like Electron, while plain signed-feed cards keep
  dismissing renderer-locally (resolver unit tests; proven live by
  `tauri-poc/scripts/check-updater-dismiss.mjs`: pinned check, dismiss, idle, pin cleared).
  The Window menu gains the macOS-only `Zoom` entry (Electron `role: 'zoom'`),
  routed to the same maximize/restore pair the renderer uses, and the Quit item
  keeps Electron's platform convention: `Cmd+Q` on macOS, `Ctrl+Q` on Linux,
  unbound `Exit` on Windows.
  Menu zoom follows the focused window like Electron: a focused Workspace
  Space window (or a future dashboard pop-out) steps its own `set_zoom`
  against a Rust-side per-window log-level map, so zooming the Space window
  never changes the main window. Main-window zoom still routes through the
  `terminal:zoom` renderer listener so editor font, PDF, and UI zoom pick the
  right target. `poc_workspace_space_open` seeds the new window's zoom from
  the level the main renderer most recently pushed through `poc_set_zoom`,
  mirroring Electron's `dom-ready` → `webContents.setZoomLevel(uiZoomLevel)`
  replay. The renderer's own startup hydration also calls
  `window.api.ui.setZoomLevel(uiZoomLevel)` once `ui.get` lands, so a Tauri
  relaunch does not silently reset zoom to 100%.
  `performNativePaste`/`performNativeSelectionAction` resolve through
  `document.execCommand` in the main renderer — the app-menu paste path already
  owns Orca-aware targets before it falls back, so the native call only needs
  the focused editable to accept the paste (WebView2 has no
  `pasteAndMatchStyle`, so both modes land on plain paste). The
  focus-mirror methods (`setMarkdownEditorFocused`, `setTerminalInputFocused`,
  `setFloatingFocus`, `setShortcutRecorderFocused`), `syncTrafficLights`, and
  the `setRichMarkdownContextMenuTarget`/`onRichMarkdownContextCommand` pair are
  inert stubs: Electron reads them in `before-input-event` and its native
  `context-menu` handler, neither of which exists on Tauri — shortcut routing
  already runs in the renderer keydown path, and a WebView2 right-click cannot
  be intercepted into a native menu. The rich-markdown editor closes its part of that gap
  with a renderer-owned DOM menu (see the slice list above); plain inputs and textareas close the rest of that gap with a second renderer-owned DOM menu that mirrors the native edit template (Cut/Copy/Paste/Paste-as-plain-text/Select all), proven live by `tauri-poc/scripts/check-plain-editable-dom-menu.mjs`, while spellcheck suggestions stay Electron-only.
- Remote SSH external-editor launching now resolves the host-owned VS Code Remote authority;
  configured compound commands in the argv-expressible subset (`code --new-window`, quoted
  launcher paths) parse into direct-exec argv without a shell, while shell-only constructs
  (pipes, substitution, env expansion) keep failing instead of launching the wrong target.
  Cross-platform end-to-end verification still remains.
- Remote SSH downloads require an active SSH2/SFTP transport; system-OpenSSH fallback still exposes
  file downloads only, because it does not provide the SFTP directory semantics used for safe folder
  traversal.
- macOS traffic lights and platform-specific behavior. Creation parity is in place: the
  shared window config pins the Overlay titlebar style with the (16, 12) traffic-light inset
  (both are mac-only in the Tauri runtime, so Windows/Linux are unaffected) and macOS
  restores decorations at startup, matching Electron's 1x-zoom layout. Zoom-level
  repositioning still needs a Tauri runtime setter that does not exist yet, and mac
  visual verification is still pending.
- Keep-awake-while-agents-run is wired end to end and live-verified on Windows: orcad
  `OrcadAgentAwakeService` owns the verdict (reuses `AgentAwakeStatusLease`,
  the agent hook-server status stream, and `onSettingsChanged` through
  `normalizeComputerAwakeMode`), publishes it over RPC
  (`agentAwake.getStatus` / `agentAwake.subscribeStatus`), and the renderer
  `tauri-native-agent-awake-api` subscribes at startup and forwards each
  verdict to `poc_agent_awake_set_active`. The Rust `AgentAwakeState` holds
  the OS blocker (Windows `SetThreadExecutionState`, macOS `caffeinate
  -dimsu` child, Linux `systemd-inhibit sleep:idle` child, released on
  window destroy) and re-emits `agentAwake:changed` for the
  `CaffeinateStatusSegment`. Settings (`computerAwakeMode`,
  `keepComputerAwakeWhileAgentsRun`) flow from the renderer through
  `RuntimeClientSettings` into the orcad profile store. Windows proof: `tauri-poc/scripts/check-keep-awake.mjs`
  drives the hidden development app through the Rust command, `window.api.agentAwake.getStatus()`,
  `agentAwake:changed` delivery, and release reset, while the Rust test in `agent_awake.rs`
  executes the `SetThreadExecutionState` call both ways (observing the held OS request needs
  elevation, so `powercfg /requests` cannot serve as the user-mode oracle). Remaining: macOS
  `caffeinate` / Linux `systemd-inhibit` mirror the Electron assertions but need live-OS
  verification, plus tray/dock live checks.
- Windows/WSL/SSH native-boundary audits and production signing.

Those systems are the remaining high-risk parity work; Electron remains the production desktop
until they have been migrated and verified on every supported host.
