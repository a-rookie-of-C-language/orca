import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for agent-marked guest input: automation key/text input marks the page so injected keys still reach the page but never bridge to the main window and never run app shortcuts, and physical keys bridge again once the mark ends. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19235
const PAGE_ID = `e2e-guest-agent-${Date.now().toString(36)}`
const connections = new Set()
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
    params: { expression, returnByValue: true, awaitPromise: true }
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
  console.log(`[guest-agent-check] ${message}`)
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
  await childEvaluate(
    page,
    `window.__agentSeen = []; document.addEventListener("keydown", (event) => window.__agentSeen.push(event.code), true);`
  )
  await page.evaluate(() => {
    window.__guestAgentNative = []
    if (window.__guestAgentObserverInstalled) {
      return
    }
    window.__guestAgentObserverInstalled = true
    void window.__TAURI__.event
      .listen('browser:guest-shortcut', (incident) =>
        window.__guestAgentNative.push(incident.payload)
      )
      .catch(() => {})
  })
  step('observers installed')

  const chords = await invoke(page, 'poc_browser_get_handled_shortcuts', {})
  const boundMatch = chords.find((chord) => /^c:1000:Key[A-Z]$/.test(chord))
  assert.ok(boundMatch, 'No Ctrl+letter chord in the live set to test against.')
  const letter = boundMatch.slice('c:1000:Key'.length)
  const upper = letter.toUpperCase()
  step(`agent chord=Ctrl+${letter}`)

  async function pressLetter() {
    await childKey(page, {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17
    })
    await childKey(page, {
      type: 'keyDown',
      modifiers: 2,
      key: letter.toLowerCase(),
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0)
    })
    await childKey(page, {
      type: 'keyUp',
      modifiers: 2,
      key: letter.toLowerCase(),
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

  async function guestCount() {
    const seen = await childEvaluate(page, 'window.__agentSeen')
    return Array.isArray(seen) ? seen.length : -1
  }

  async function bridgeCount() {
    const native = await page.evaluate(() => window.__guestAgentNative ?? [])
    return native.length
  }

  // Agent-marked: the page still receives the key, the app never sees it.
  await invoke(page, 'poc_browser_agent_input_begin', { browserPageId: PAGE_ID })
  const seenBefore = await guestCount()
  const bridgedBefore = await bridgeCount()
  await pressLetter()
  let agentSeen = -1
  for (let attempt = 0; attempt < 100; attempt++) {
    agentSeen = await guestCount()
    if (agentSeen > seenBefore) {
      break
    }
    await delay(100)
  }
  assert.ok(agentSeen > seenBefore, 'The agent key never reached the page.')
  await delay(800)
  assert.equal(
    await bridgeCount(),
    bridgedBefore,
    'An agent-injected key bridged to the main window.'
  )
  step('agent key reached the page but never bridged')
  await invoke(page, 'poc_browser_agent_input_end', { browserPageId: PAGE_ID })

  // Unmarked again: the same chord bridges (grace expiry is covered by unit test timing).
  await delay(800)
  const bridgedAfterEnd = await bridgeCount()
  await pressLetter()
  let bridged = bridgedAfterEnd
  for (let attempt = 0; attempt < 100; attempt++) {
    bridged = await bridgeCount()
    if (bridged > bridgedAfterEnd) {
      break
    }
    await delay(100)
  }
  assert.ok(bridged > bridgedAfterEnd, 'The physical key never bridged after the agent mark ended.')
  step('physical key bridges again after end')

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-agent-check-latest.json'),
    JSON.stringify({ letter, agentSeen, bridged }, null, 2)
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
