import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for Shift-held chords: Shift-held chords cross the bridge with the shift flag intact, so typing a capital between two Shift taps resets the shared double-tap detector instead of phantom-triggering it, while plain typing still lands in the guest unsuppressed. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19236
const PAGE_ID = `e2e-guest-shift-chord-${Date.now().toString(36)}`
const connections = new Set()

// Why input focused: Shift+A must land as plain typing in a focused editable,
// mirroring a user typing a capital while the guest has focus.
const guestHtml = `<!doctype html><html><body><input id="f" value=""><script>document.getElementById("f").focus();</script></body></html>`

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
  console.log(`[guest-shift-chord-check] ${message}`)
}

// Why one Shift tap, then Shift+A, then Shift tap: Electron feeds every guest
// key into the shared double-tap detector, so the chord must reset it; without
// the bridge the main window would see down/up/down/up and phantom-trigger.
async function tapShiftChordShift(page) {
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
  await childKey(page, {
    type: 'keyDown',
    modifiers: 8,
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16
  })
  await childKey(page, {
    type: 'keyDown',
    modifiers: 8,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    text: 'A'
  })
  await childKey(page, {
    type: 'keyUp',
    modifiers: 8,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65
  })
  await childKey(page, {
    type: 'keyUp',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16
  })
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
    `window.__shiftChordPrevented = []; document.addEventListener("keydown", (event) => window.__shiftChordPrevented.push(event.defaultPrevented), true);`
  )
  step('guest observer installed')

  // Probe arrays are per-file: the hidden renderer outlives runs, so a shared name would double-count stale listeners.
  await page.evaluate(() => {
    window.__guestShiftChordNativeFwd = []
    window.__guestShiftChordDispatchedFwd = []
    if (window.__guestShiftChordObserversInstalledV1) {
      return
    }
    window.__guestShiftChordObserversInstalledV1 = true
    void window.__TAURI__.event
      .listen('browser:guest-shortcut', (incident) =>
        window.__guestShiftChordNativeFwd.push({ ...incident.payload, at: Date.now() })
      )
      .catch(() => {})
    const record = (event) => {
      window.__guestShiftChordDispatchedFwd.push({
        type: event.type,
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        at: Date.now()
      })
    }
    window.addEventListener('keydown', record, { capture: true })
    window.addEventListener('keyup', record, { capture: true })
  })
  step('main-window observers installed')

  await tapShiftChordShift(page)
  step('guest Shift, Shift+A, Shift played')
  if (!(await childEvaluate(page, 'document.getElementById("f").value.length > 0'))) {
    step('guest saw no typing, resending once')
    await tapShiftChordShift(page)
    step('sequence resent')
  }

  let native = []
  let dispatched = []
  for (let attempt = 0; attempt < 100; attempt++) {
    const seen = await page.evaluate(() => ({
      native: window.__guestShiftChordNativeFwd,
      dispatched: window.__guestShiftChordDispatchedFwd
    }))
    native = seen.native
    dispatched = seen.dispatched
    if (native.length >= 8 && dispatched.length >= 8) {
      break
    }
    await delay(100)
  }
  console.log(`[guest-shift-chord-check] native payloads: ${JSON.stringify(native)}`)
  console.log(`[guest-shift-chord-check] dispatched: ${JSON.stringify(dispatched)}`)
  const chordNative = native.filter((entry) => entry.code === 'KeyA')
  assert.ok(chordNative.length >= 2, 'The Shift-held chord never crossed the bridge.')
  assert.deepEqual(
    chordNative.slice(0, 2).map((entry) => entry.eventType),
    ['keydown', 'keyup'],
    'The Shift+A chord never bridged down/up in order.'
  )
  assert.ok(
    chordNative.every((entry) => entry.shiftKey === true),
    'The bridged chord lost its shift flag.'
  )
  step('Shift+A bridged down/up with the shift flag intact')
  const chordDispatched = dispatched.filter((entry) => entry.code === 'KeyA')
  assert.deepEqual(
    chordDispatched.slice(0, 2).map((entry) => entry.type),
    ['keydown', 'keyup'],
    'The Shift+A chord was never re-dispatched as window keyboard events.'
  )
  step('window re-dispatch carries the chord')
  // Why order: the shared detector processes the same ordered stream, so a
  // chord re-dispatched between the taps resets it like a local press.
  const kinds = dispatched.slice(0, 8).map((entry) => `${entry.type}:${entry.code}`)
  assert.ok(
    kinds.indexOf('keydown:KeyA') > kinds.indexOf('keyup:ShiftLeft') &&
      kinds.lastIndexOf('keyup:ShiftLeft') > kinds.indexOf('keyup:KeyA'),
    `The chord was not ordered between the taps: ${kinds.join(',')}.`
  )
  step('chord ordered between the taps, no phantom double-tap')
  // Why typing: the chord is plain typing in the guest; only handled app
  // chords may preventDefault, so the capital must still land.
  const guestState = await childEvaluate(
    page,
    '({value: document.getElementById("f").value, prevented: window.__shiftChordPrevented})'
  )
  console.log(`[guest-shift-chord-check] guest state: ${JSON.stringify(guestState)}`)
  assert.ok(guestState.prevented.length > 0, 'The guest never saw the chord keydown.')
  assert.ok(
    guestState.prevented.every((prevented) => prevented === false),
    'An unhandled Shift+A chord was preventDefaulted in the guest.'
  )
  assert.ok(guestState.value.includes('A'), 'Typing the capital never landed in the guest.')
  step('plain typing still lands in the guest')

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-shift-chord-check-latest.json'),
    JSON.stringify({ native, dispatched, guestState }, null, 2)
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
console.log('[guest-shift-chord-check] passed')
