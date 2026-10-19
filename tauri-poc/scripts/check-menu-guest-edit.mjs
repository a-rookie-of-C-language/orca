import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for Edit > Copy/SelectAll/Paste guest routing: the guest
// init script reports focus over the shortcut bridge so the host knows the
// most recently focused page, and the menu handler evaluates execCommand
// inside that child webview instead of bouncing off the unfocused main
// window, matching Electron's webContents.getFocusedWebContents() branch. A
// poc command drives the same shared helper the menu calls: selectAll shows
// an observable selection, copy fires an observable copy event, unknown
// commands are rejected, and a closed guest reports false so the caller falls
// back to the renderer event. Refuses visible windows and foreign checkouts
// like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19236
const PAGE_ID = `e2e-guest-edit-${Date.now().toString(36)}`
const connections = new Set()

// Why a focused input with a known value: the menu route must land in the
// guest document, so selectAll has an observable selection and copy has an
// observable copy event to prove the execCommand ran there.
const guestHtml = `<!doctype html><html><body><input id="f" value="hello"><script>document.getElementById("f").focus();</script></body></html>`

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

async function guestEdit(page, command) {
  return invoke(page, 'poc_browser_guest_edit', { command })
}

function step(message) {
  console.log(`[guest-edit-check] ${message}`)
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

  // The guest posts focus over the shortcut bridge; poll until the host
  // records this page as the focused guest (same state the menu reads).
  let routed = false
  for (let attempt = 0; attempt < 100; attempt++) {
    routed = await guestEdit(page, 'selectAll')
    if (routed) {
      break
    }
    await delay(100)
  }
  assert.equal(routed, true, 'The focused guest never registered for menu routing.')
  step('host routes into the focused guest')

  const selection = await childEvaluate(
    page,
    "[document.getElementById('f').selectionStart, document.getElementById('f').selectionEnd]"
  )
  assert.deepEqual(selection, [0, 5], 'selectAll did not select the guest input value.')
  step('selectAll selected the guest input through the menu route')

  await childEvaluate(
    page,
    "window.__copySeen = 0; document.addEventListener('copy', () => window.__copySeen++, true);"
  )
  assert.equal(await guestEdit(page, 'copy'), true, 'copy did not route into the focused guest.')
  let copySeen = 0
  for (let attempt = 0; attempt < 100; attempt++) {
    copySeen = await childEvaluate(page, 'window.__copySeen')
    if (copySeen > 0) {
      break
    }
    await delay(100)
  }
  assert.ok(copySeen > 0, 'copy never executed in the guest document.')
  step('copy executed in the guest document through the menu route')

  await assert.rejects(guestEdit(page, 'document.cookie'), /unknown guest edit command/)
  step('arbitrary scripts are rejected')

  await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID })
  await delay(500)
  assert.equal(
    await guestEdit(page, 'selectAll'),
    false,
    'A closed guest still claims menu routing.'
  )
  step('closed guest falls back to the renderer event')

  await mkdir(join(root, '.cache'), { recursive: true })
  await writeFile(
    join(root, '.cache', 'tauri-menu-guest-edit-check-latest.json'),
    JSON.stringify({ selection, copySeen }, null, 2)
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
console.log('[guest-edit-check] passed')
