import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for the guest-held Ctrl+Tab switcher: the guest arms the shared tab switcher on a real Ctrl+Tab keydown inside a focused editable, the Ctrl-held Tab release bridges to the main window, and Control release arrives as a commit that synthesizes a Control keyup so the shared overlay cannot strand. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19233
const PAGE_ID = `e2e-guest-ctrl-tab-${Date.now().toString(36)}`
const connections = new Set()

// Why contentEditable + input: the guest script arms the switcher on a real
// Ctrl+Tab keydown inside a focused editable, mirroring normal use.
const guestHtml = `<!doctype html><html><body><div id="ed" contenteditable="true">hello</div><input id="f" value="world"><script>document.getElementById("f").focus();</script></body></html>`

function serve(handler) {
  const server = createServer(handler)
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.destroySockets = () => {
    for (const socket of sockets) {
      socket.destroy()
    }
  }
  return new Promise((fulfill) => server.listen(PORT, HOST, () => fulfill(server)))
}

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, { args }),
    { command, args }
  )
}

async function childEvaluate(page, expression) {
  const reply = await invoke(page, 'poc_browser_cdp', {
    browserPageId: PAGE_ID,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true }
  })
  return reply?.result?.value
}

async function childKey(page, params) {
  await invoke(page, 'poc_browser_cdp', {
    browserPageId: PAGE_ID,
    method: 'Input.dispatchKeyEvent',
    params
  })
}

function step(message) {
  console.log(`[guest-ctrl-tab-check] ${message}`)
}

let server
let page
try {
  server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(guestHtml)
  })
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')

  try {
    await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  } catch {
    // No stale page from a previous run; create fresh below.
  }
  await invoke(page, 'poc_browser_create', {
    browserPageId: PAGE_ID,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false
  })
  step('child webview created')
  await invoke(page, 'poc_browser_navigate', {
    browserPageId: PAGE_ID,
    url: `http://${HOST}:${PORT}/`
  })
  step('navigated to guest page')

  let installed = false
  for (let attempt = 0; attempt < 100; attempt++) {
    installed = await childEvaluate(page, 'window.__orcaGuestShortcutInstalled === true')
    if (installed) {
      break
    }
    await delay(100)
  }
  assert.equal(installed, true, 'The guest shortcut init script never ran.')
  step('guest init script installed')

  // Probe arrays are per-file: the hidden renderer outlives runs, so a shared name would double-count stale listeners.
  await page.evaluate(() => {
    window.__guestCtrlTabNativeFwd = []
    window.__guestCtrlTabCommitFwd = []
    window.__guestCtrlTabDispatchedFwd = []
    if (window.__guestCtrlTabObserversInstalledV2) {
      return
    }
    window.__guestCtrlTabObserversInstalledV2 = true
    void window.__TAURI__.event
      .listen('browser:guest-shortcut', (incident) =>
        window.__guestCtrlTabNativeFwd.push(incident.payload)
      )
      .catch(() => {})
    void window.__TAURI__.event
      .listen('browser:guest-ctrl-tab-commit', (incident) =>
        window.__guestCtrlTabCommitFwd.push(incident.payload)
      )
      .catch(() => {})
    window.addEventListener(
      'keyup',
      (event) =>
        window.__guestCtrlTabDispatchedFwd.push({
          type: event.type,
          key: event.key,
          code: event.code
        }),
      { capture: true }
    )
  })
  await childEvaluate(
    page,
    `window.__ctrlTabSeenDown = 0; window.__ctrlTabSeenUp = 0; document.addEventListener("keydown", () => window.__ctrlTabSeenDown++, true); document.addEventListener("keyup", () => window.__ctrlTabSeenUp++, true);`
  )
  step('guest counters installed')
  step('main-window observers installed')

  await childKey(page, {
    type: 'keyDown',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17
  })
  await childKey(page, {
    type: 'keyDown',
    modifiers: 2,
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9
  })
  await childKey(page, {
    type: 'keyUp',
    modifiers: 2,
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9
  })
  await childKey(page, {
    type: 'keyUp',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17
  })
  step('guest Ctrl+Tab pressed and Control released')
  console.log(
    `[guest-ctrl-tab-check] guest counters: ${JSON.stringify(await childEvaluate(page, '({seenDown: window.__ctrlTabSeenDown, seenUp: window.__ctrlTabSeenUp})'))}`
  )
  // Why resend: a fresh hidden child sometimes swallows the first trusted
  // sequence before its input pipeline is warm; the sibling shortcut probe
  // resends once for the same reason.
  if (!(await childEvaluate(page, 'window.__ctrlTabSeenDown + window.__ctrlTabSeenUp > 0'))) {
    step('guest saw no keys, resending once')
    await childKey(page, {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17
    })
    await childKey(page, {
      type: 'keyDown',
      modifiers: 2,
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9
    })
    await childKey(page, {
      type: 'keyUp',
      modifiers: 2,
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9
    })
    await childKey(page, {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17
    })
    step('guest Ctrl+Tab resent')
  }

  let native = []
  let commit = []
  let dispatched = []
  for (let attempt = 0; attempt < 100; attempt++) {
    const seen = await page.evaluate(() => ({
      native: window.__guestCtrlTabNativeFwd,
      commit: window.__guestCtrlTabCommitFwd,
      dispatched: window.__guestCtrlTabDispatchedFwd
    }))
    native = seen.native
    commit = seen.commit
    dispatched = seen.dispatched
    if (native.length >= 1 && commit.length >= 1 && dispatched.length >= 1) {
      break
    }
    await delay(100)
  }
  console.log(`[guest-ctrl-tab-check] native payloads: ${JSON.stringify(native)}`)
  console.log(`[guest-ctrl-tab-check] commit payloads: ${JSON.stringify(commit)}`)
  console.log(`[guest-ctrl-tab-check] dispatched: ${JSON.stringify(dispatched)}`)
  const nativeChords = native.map((entry) => [
    entry.eventType,
    entry.key,
    entry.code,
    entry.ctrlKey
  ])
  assert.ok(
    nativeChords.some(
      (row) => JSON.stringify(row) === JSON.stringify(['keyup', 'Tab', 'Tab', true])
    ),
    'No guest Ctrl-held Tab release reached the main window.'
  )
  step('switcher Tab bridged to the main window')
  assert.ok(commit.length >= 1, 'No guest Ctrl+Tab commit reached the main window.')
  // Why keyup, not keydown: the host may consume the Ctrl+Tab keydown as an
  // accelerator before it reaches the page; the Ctrl-held Tab keyup is what
  // still bridges and arms the switcher.
  assert.equal(commit[0]?.browserPageId, PAGE_ID, 'The commit carried the wrong page id.')
  step('Control release arrived as a commit')
  const controlReleases = dispatched.filter(
    (entry) => entry.type === 'keyup' && entry.key === 'Control'
  )
  assert.ok(
    controlReleases.length >= 1,
    'The commit never synthesized a Control keyup on the window.'
  )
  step('synthetic Control keyup dispatched so the overlay commits')

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-ctrl-tab-check-latest.json'),
    JSON.stringify({ native, commit, dispatched }, null, 2)
  )
  step('evidence written, page closed')
} finally {
  try {
    if (page && PAGE_ID) {
      await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID }).catch(() => {})
    }
  } catch {
    // Best effort cleanup.
  }
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
  if (server) {
    server.destroySockets()
    await new Promise((fulfill) => server.close(() => fulfill()))
  }
}
console.log('[guest-ctrl-tab-check] passed')
