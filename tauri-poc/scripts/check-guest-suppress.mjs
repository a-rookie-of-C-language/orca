import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for guest suppression of handled chords: the main renderer publishes the live keybinding-registry chord set, Rust pushes it into every guest page load and re-pushes it into all live guests whenever the set changes, and the guest init script preventDefaults handled chords. Live registry updates reach the sitting page without reload, and unhandled chords are left alone. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19232
const PAGE_ID = `e2e-guest-suppress-${Date.now().toString(36)}`
const connections = new Set()

// Why contentEditable + input: suppression only matters where the guest has a
// default key handling to suppress; a bare button proves nothing.
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
  console.log(`[guest-suppress-check] ${message}`)
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

  // Why after init: capture listeners run in registration order, so recording
  // here observes defaultPrevented as the init script left it.
  await childEvaluate(
    page,
    `window.__suppressSeen = []; document.addEventListener("keydown", (event) => window.__suppressSeen.push({ key: event.key, code: event.code, prevented: event.defaultPrevented }), true);`
  )
  const recorder = await childEvaluate(page, 'Array.isArray(window.__suppressSeen)')
  assert.equal(recorder, true, 'The guest suppression recorder never installed.')
  step('guest recorder installed')

  // The live set is published by the App hook; read it instead of hardcoding.
  const chords = await invoke(page, 'poc_browser_get_handled_shortcuts', {})
  assert.ok(
    Array.isArray(chords) && chords.length > 0,
    'The handled set is empty; the App hook may not be mounted.'
  )
  step(`live handled set has ${chords.length} chords`)
  const boundMatch = chords.find((chord) => /^c:1000:Key[A-Z]$/.test(chord))
  assert.ok(boundMatch, 'No Ctrl+letter chord in the live set to test suppression against.')
  const boundLetter = boundMatch.slice('c:1000:Key'.length)
  const unboundLetter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .find(
      (letter) => !chords.includes(`c:1000:Key${letter}`) && !chords.includes(`k:1000:${letter}`)
    )
  assert.ok(
    unboundLetter,
    'Every Ctrl+letter chord is handled; nothing left to test the negative case.'
  )
  step(`bound=${boundLetter} unbound=${unboundLetter}`)

  // Probe arrays are per-file: the hidden renderer outlives runs, so a shared name would double-count stale listeners.
  await page.evaluate(() => {
    window.__guestSuppressNative = []
    if (window.__guestSuppressObserverInstalledV2) {
      return
    }
    window.__guestSuppressObserverInstalledV2 = true
    void window.__TAURI__.event
      .listen('browser:guest-shortcut', (incident) =>
        window.__guestSuppressNative.push(incident.payload)
      )
      .catch(() => {})
  })
  step('main-window observers installed')

  async function pressCtrlLetter(letter) {
    const lower = letter.toLowerCase()
    const upper = letter.toUpperCase()
    await childKey(page, {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17
    })
    await childKey(page, {
      type: 'keyDown',
      modifiers: 2,
      key: lower,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0)
    })
    await childKey(page, {
      type: 'keyUp',
      modifiers: 2,
      key: lower,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0)
    })
    await childKey(page, {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17
    })
  }

  async function bridgeCount() {
    const native = await page.evaluate(() => window.__guestSuppressNative ?? [])
    return native.length
  }

  async function pressAndWaitLetter(letter) {
    const before = await childEvaluate(page, 'window.__suppressSeen.length')
    await pressCtrlLetter(letter)
    let record
    for (let attempt = 0; attempt < 100; attempt++) {
      const seen = await childEvaluate(page, 'window.__suppressSeen')
      if (Array.isArray(seen) && seen.length > before) {
        record = seen.at(-1)
        break
      }
      await delay(100)
    }
    return record
  }

  const boundRecord = await pressAndWaitLetter(boundLetter)
  assert.ok(boundRecord, 'The bound chord never reached the guest recorder.')
  assert.equal(
    boundRecord.prevented,
    true,
    `Bound Ctrl+${boundLetter} was not suppressed in the guest.`
  )
  step(`bound Ctrl+${boundLetter} suppressed`)
  const bridgedAfterBound = await bridgeCount()
  assert.ok(bridgedAfterBound >= 2, 'The bound chord never bridged to the main window.')
  step('bound chord still bridged')

  const unboundRecord = await pressAndWaitLetter(unboundLetter)
  assert.ok(unboundRecord, 'The unbound chord never reached the guest recorder.')
  assert.equal(
    unboundRecord.prevented,
    false,
    `Unbound Ctrl+${unboundLetter} was wrongly suppressed in the guest.`
  )
  step(`unbound Ctrl+${unboundLetter} left alone`)
  const bridgedAfterUnbound = await bridgeCount()
  assert.ok(
    bridgedAfterUnbound > bridgedAfterBound,
    'The unbound chord never bridged to the main window.'
  )
  step('unbound chord still bridged')

  // Live update: a registry change must reach the sitting page without reload.
  const added = [`c:1000:Key${unboundLetter}`, `k:1000:${unboundLetter}`]
  await invoke(page, 'poc_browser_set_handled_shortcuts', { chords: [...chords, ...added] })
  await delay(500)
  const liveRecord = await pressAndWaitLetter(unboundLetter)
  assert.ok(liveRecord, 'The live-updated chord never reached the guest recorder.')
  assert.equal(
    liveRecord.prevented,
    true,
    `Ctrl+${unboundLetter} was not suppressed after the live set update.`
  )
  step(`live update suppresses Ctrl+${unboundLetter} without reload`)

  // Restore the published set so later runs start from the registry truth.
  await invoke(page, 'poc_browser_set_handled_shortcuts', { chords })
  await delay(500)
  const restoredRecord = await pressAndWaitLetter(unboundLetter)
  assert.ok(restoredRecord, 'The restored chord never reached the guest recorder.')
  assert.equal(
    restoredRecord.prevented,
    false,
    `Ctrl+${unboundLetter} stayed suppressed after the set was restored.`
  )
  step('restored set leaves the chord alone again')

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-suppress-check-latest.json'),
    JSON.stringify(
      { chords: chords.length, boundLetter, unboundLetter, boundRecord, unboundRecord },
      null,
      2
    )
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
