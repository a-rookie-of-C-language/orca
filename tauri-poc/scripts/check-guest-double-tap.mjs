import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for bare-modifier double-tap parity: bare modifier taps cross the bridge in down/up order with the tap gap inside the detector window, so the main window can complete a double-tap exactly like a local press while the guest still sees its own key events. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19234
const PAGE_ID = `e2e-guest-double-tap-${Date.now().toString(36)}`
const connections = new Set()

// Why contentEditable + input: modifier taps must land in a focused editable,
// mirroring a user double-tapping a modifier while the guest has focus.
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
  console.log(`[guest-double-tap-check] ${message}`)
}

async function tapShiftTwice(page) {
  await childKey(page, {
    type: 'keyDown',
    modifiers: 8,
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16
  })
  await childKey(page, {
    type: 'keyUp',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16
  })
  await delay(60)
  await childKey(page, {
    type: 'keyDown',
    modifiers: 8,
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16
  })
  await childKey(page, {
    type: 'keyUp',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16
  })
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
  await childEvaluate(
    page,
    `window.__doubleTapSeenDown = 0; window.__doubleTapSeenUp = 0; document.addEventListener("keydown", () => window.__doubleTapSeenDown++, true); document.addEventListener("keyup", () => window.__doubleTapSeenUp++, true);`
  )
  step('guest counters installed')

  // Probe arrays are per-file: the hidden renderer outlives runs, so a shared name would double-count stale listeners.
  await page.evaluate(() => {
    window.__guestDoubleTapNativeFwd = []
    window.__guestDoubleTapDispatchedFwd = []
    if (window.__guestDoubleTapObserversInstalledV2) {
      return
    }
    window.__guestDoubleTapObserversInstalledV2 = true
    void window.__TAURI__.event
      .listen('browser:guest-shortcut', (incident) =>
        window.__guestDoubleTapNativeFwd.push({ ...incident.payload, at: Date.now() })
      )
      .catch(() => {})
    const record = (event) => {
      if (event.key !== 'Shift') {
        return
      }
      window.__guestDoubleTapDispatchedFwd.push({
        type: event.type,
        key: event.key,
        code: event.code,
        at: Date.now()
      })
    }
    window.addEventListener('keydown', record, { capture: true })
    window.addEventListener('keyup', record, { capture: true })
  })
  step('main-window observers installed')

  await tapShiftTwice(page)
  step('guest Shift double-tapped')
  console.log(
    `[guest-double-tap-check] guest counters: ${JSON.stringify(await childEvaluate(page, '({seenDown: window.__doubleTapSeenDown, seenUp: window.__doubleTapSeenUp})'))}`
  )
  // Why resend: a fresh hidden child sometimes swallows the first trusted
  // sequence before its input pipeline is warm; the sibling probes resend once.
  if (!(await childEvaluate(page, 'window.__doubleTapSeenDown + window.__doubleTapSeenUp > 0'))) {
    step('guest saw no keys, resending once')
    await tapShiftTwice(page)
    step('guest Shift double-tap resent')
  }

  let native = []
  let dispatched = []
  for (let attempt = 0; attempt < 100; attempt++) {
    const seen = await page.evaluate(() => ({
      native: window.__guestDoubleTapNativeFwd,
      dispatched: window.__guestDoubleTapDispatchedFwd
    }))
    native = seen.native.filter((entry) => entry.code === 'ShiftLeft')
    dispatched = seen.dispatched
    if (native.length >= 4 && dispatched.length >= 4) {
      break
    }
    await delay(100)
  }
  console.log(`[guest-double-tap-check] native payloads: ${JSON.stringify(native)}`)
  console.log(`[guest-double-tap-check] dispatched: ${JSON.stringify(dispatched)}`)
  const nativeKinds = native.map((entry) => entry.eventType)
  assert.deepEqual(
    nativeKinds.slice(0, 4),
    ['keydown', 'keyup', 'keydown', 'keyup'],
    'The bare-modifier releases never bridged; the main window cannot complete a double-tap.'
  )
  step('down/up/down/up bridged in order')
  const dispatchedKinds = dispatched.map((entry) => entry.type)
  assert.deepEqual(
    dispatchedKinds.slice(0, 4),
    ['keydown', 'keyup', 'keydown', 'keyup'],
    'The modifier taps were never re-dispatched as window keyboard events.'
  )
  step('window re-dispatch preserves the tap sequence')
  // Why timing: the shared detector arms on the first release with a 300ms
  // deadline, so the re-dispatched gap must hold across the bridge.
  const releaseToPress = dispatched[2].at - dispatched[1].at
  assert.ok(
    releaseToPress >= 0 && releaseToPress < 300,
    `The re-dispatched tap gap is ${releaseToPress}ms; the detector window would lapse.`
  )
  step(`tap gap ${releaseToPress}ms holds inside the detector window`)

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-double-tap-check-latest.json'),
    JSON.stringify({ native, dispatched }, null, 2)
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
console.log('[guest-double-tap-check] passed')
