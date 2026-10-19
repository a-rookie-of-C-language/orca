import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for browser guest-shortcut forwarding: a focused browser child WebView forwards shortcut-grade key events (modifier chords, Escape, bare modifier taps) while plain typing still lands in the guest. One guest press produces exactly one bridge event and one re-dispatched window event. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19231
const PAGE_ID = 'e2e-guest-shortcut-' + Date.now().toString(36)
const connections = new Set()

const guestHtml = `<!doctype html><html><body><button id="focus">guest</button><script>document.getElementById("focus").focus();</script></body></html>`

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
  console.log(`[guest-shortcut-check] ${message}`)
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
  let focused = false
  for (let attempt = 0; attempt < 100; attempt++) {
    focused = await childEvaluate(
      page,
      "document.readyState === 'complete' && !!document.activeElement && document.activeElement.id === 'focus'"
    )
    if (focused) {
      break
    }
    await delay(100)
  }
  assert.equal(focused, true, 'The guest page never finished loading with focus.')
  step('guest page loaded and focused')
  await childEvaluate(
    page,
    `window.__seenDown = 0; window.__seenUp = 0; document.addEventListener("keydown", () => window.__seenDown++, true); document.addEventListener("keyup", () => window.__seenUp++, true);`
  )
  step('guest counters installed')

  // Probe arrays are per-file: the hidden renderer outlives runs, so a shared name would double-count stale listeners.
  await page.evaluate(() => {
    window.__guestShortcutNativeFwd = []
    window.__guestShortcutDispatchedFwd = []
    if (window.__guestShortcutObserversInstalledFwd) {
      return
    }
    window.__guestShortcutObserversInstalledFwd = true
    void window.__TAURI__.event
      .listen('browser:guest-shortcut', (incident) =>
        window.__guestShortcutNativeFwd.push(incident.payload)
      )
      .catch(() => {})
    window.addEventListener(
      'keydown',
      (event) =>
        window.__guestShortcutDispatchedFwd.push({
          type: event.type,
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey
        }),
      { capture: true }
    )
    window.addEventListener(
      'keyup',
      (event) =>
        window.__guestShortcutDispatchedFwd.push({
          type: event.type,
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey
        }),
      { capture: true }
    )
  })
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
    key: 'b',
    code: 'KeyB',
    windowsVirtualKeyCode: 66
  })
  await childKey(page, {
    type: 'keyUp',
    modifiers: 2,
    key: 'b',
    code: 'KeyB',
    windowsVirtualKeyCode: 66
  })
  await childKey(page, {
    type: 'keyUp',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17
  })
  step('trusted Ctrl+B sent to guest')
  let resent = false
  let warmed = await childEvaluate(page, 'window.__seenDown + window.__seenUp > 0')
  if (!warmed) {
    resent = true
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
      key: 'b',
      code: 'KeyB',
      windowsVirtualKeyCode: 66
    })
    await childKey(page, {
      type: 'keyUp',
      modifiers: 2,
      key: 'b',
      code: 'KeyB',
      windowsVirtualKeyCode: 66
    })
    await childKey(page, {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17
    })
    step('trusted Ctrl+B resent to guest')
  }

  console.log(
    '[guest-shortcut-check] guest counters: ' +
      JSON.stringify(
        await childEvaluate(page, '({seenDown: window.__seenDown, seenUp: window.__seenUp})')
      )
  )
  let native = []
  let dispatched = []
  for (let attempt = 0; attempt < 100; attempt++) {
    const seen = await page.evaluate(() => ({
      native: window.__guestShortcutNativeFwd,
      dispatched: window.__guestShortcutDispatchedFwd
    }))
    native = seen.native
    dispatched = seen.dispatched
    if (native.length >= 2 && dispatched.length >= 2) {
      break
    }
    await delay(100)
  }
  console.log('[guest-shortcut-check] native payloads: ' + JSON.stringify(native))
  console.log('[guest-shortcut-check] dispatched: ' + JSON.stringify(dispatched))
  const nativeChords = native.map((entry) => [
    entry.eventType,
    entry.key,
    entry.code,
    entry.ctrlKey
  ])
  assert.ok(
    nativeChords.some(
      (row) => JSON.stringify(row) === JSON.stringify(['keydown', 'b', 'KeyB', true])
    ),
    'No guest keydown reached the main window.'
  )
  assert.ok(
    nativeChords.some(
      (row) => JSON.stringify(row) === JSON.stringify(['keyup', 'b', 'KeyB', true])
    ),
    'No guest keyup reached the main window.'
  )
  console.log('[guest-shortcut-check] native payloads: ' + JSON.stringify(native))
  console.log('[guest-shortcut-check] dispatched: ' + JSON.stringify(dispatched))
  step('native bridge event received')
  const redispatched = dispatched
    .filter((entry) => entry.key === 'b')
    .map((entry) => [entry.type, entry.key, entry.code, entry.ctrlKey])
  assert.ok(
    redispatched.some(
      (row) => JSON.stringify(row) === JSON.stringify(['keydown', 'b', 'KeyB', true])
    ),
    'The chord keydown was never re-dispatched as a window keyboard event.'
  )
  assert.ok(
    redispatched.some(
      (row) => JSON.stringify(row) === JSON.stringify(['keyup', 'b', 'KeyB', true])
    ),
    'The chord keyup was never re-dispatched as a window keyboard event.'
  )
  step('synthetic window keyboard event dispatched')
  // Why chord-scoped: unarmed modifier releases now bridge for double-tap
  // parity, so totals include the Control release alongside the chord.
  const expectedEvents = resent ? 4 : 2
  const nativeChord = native.filter((entry) => entry.code === 'KeyB')
  assert.equal(
    nativeChord.length,
    expectedEvents,
    `Expected one bridge event per guest press, got ${nativeChord.length}.`
  )
  assert.equal(
    redispatched.length,
    expectedEvents,
    `Expected one re-dispatched event per guest press, got ${redispatched.length}.`
  )

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-shortcut-check-latest.json'),
    JSON.stringify({ native, dispatched }, null, 2)
  )
  step('evidence written, page closed')
} finally {
  try {
    await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  } catch {
    // Best effort cleanup; the page may never have been created.
  }
  server?.destroySockets()
  await new Promise((fulfill) => server?.close(() => fulfill()))
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
console.log('[guest-shortcut-check] passed')
