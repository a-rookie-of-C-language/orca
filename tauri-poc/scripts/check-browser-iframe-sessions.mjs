import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live WebView2 proof for the iframe session chain: a hidden child webview
// loads a parent page with a cross-origin iframe, then the check drives the
// real CDP path (autoattach, attach events, session AX reads, detach).
// Refuses visible windows and other checkouts like the sibling checks.

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const PARENT_HOST = '127.0.0.1'
const PARENT_PORT = 19223
const FRAME_HOST = '127.0.0.2'
const FRAME_PORT = 19224
const PAGE_ID = 'e2e-iframe-check'
const connections = new Set()

function serve(host, port, handler) {
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
  return new Promise((fulfill) => server.listen(port, host, () => fulfill(server)))
}

// Why two loopback IPs: same-host different-port iframes stay in-process,
// so no flattened session is ever attached. Distinct hosts force OOPIF.
const parentHtml = `<!doctype html><html><body><button>Parent Button</button><iframe src="http://${FRAME_HOST}:${FRAME_PORT}/frame.html" width="400" height="300"></iframe></body></html>`
const frameHtml = `<!doctype html><html><head><title>Framed</title></head><body><button>Framed Button</button></body></html>`

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, { args }),
    { command, args }
  )
}

function step(message) {
  console.log(`[iframe-check] ${message}`)
}

async function waitForEvent(page, predicate, timeoutMs = 30000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 250) {
    const found = await page.evaluate(
      (source) => (window.__iframeCheckEvents ?? []).filter((entry) => entry.event === source),
      predicate
    )
    if (found.length > 0) {
      return found
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for browser:cdp-event ${predicate}.`)
}

let parentServer
let frameServer
let page
try {
  parentServer = await serve(PARENT_HOST, PARENT_PORT, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(parentHtml)
  })
  frameServer = await serve(FRAME_HOST, FRAME_PORT, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(frameHtml)
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
  await page.evaluate(() => {
    window.__iframeCheckEvents = []
    void window.__TAURI__.event
      .listen('browser:cdp-event', (incident) => window.__iframeCheckEvents.push(incident.payload))
      .catch(() => {})
  })
  step('event listener installed')
  for (const eventName of ['Target.attachedToTarget', 'Target.detachedFromTarget']) {
    await invoke(page, 'poc_browser_cdp_subscribe', { browserPageId: PAGE_ID, eventName })
  }
  step('target events subscribed')
  await invoke(page, 'poc_browser_cdp', {
    browserPageId: PAGE_ID,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
  })
  step('autoattach enabled')
  await invoke(page, 'poc_browser_navigate', {
    browserPageId: PAGE_ID,
    url: `http://${PARENT_HOST}:${PARENT_PORT}/`
  })
  step('navigated to parent page')
  const attached = await waitForEvent(page, 'Target.attachedToTarget')
  step(`saw ${attached.length} attach events`)
  const iframeAttach = attached.find((entry) => entry.params?.targetInfo?.type === 'iframe')
  assert.ok(iframeAttach, 'No flattened iframe session was attached.')
  assert.ok(
    typeof iframeAttach.params.sessionId === 'string' && iframeAttach.params.sessionId.length > 0,
    'The iframe attach carried no session id.'
  )
  const sessionId = iframeAttach.params.sessionId

  const parentTree = await invoke(page, 'poc_browser_cdp', {
    browserPageId: PAGE_ID,
    method: 'Accessibility.getFullAXTree',
    params: {}
  })
  assert.ok(
    JSON.stringify(parentTree).includes('Parent Button'),
    'The parent AX tree missed the parent button.'
  )
  const frameTree = await invoke(page, 'poc_browser_cdp_session', {
    browserPageId: PAGE_ID,
    sessionId,
    method: 'Accessibility.getFullAXTree',
    params: {}
  })
  assert.ok(
    JSON.stringify(frameTree).includes('Framed Button'),
    'The iframe session AX tree missed the framed button.'
  )
  const frameTitle = await invoke(page, 'poc_browser_cdp_session', {
    browserPageId: PAGE_ID,
    sessionId,
    method: 'Runtime.evaluate',
    params: { expression: 'document.title', returnByValue: true }
  })
  assert.equal(frameTitle?.result?.value, 'Framed', 'The session evaluate missed the frame title.')

  await invoke(page, 'poc_browser_navigate', { browserPageId: PAGE_ID, url: 'about:blank' })
  await waitForEvent(page, 'Target.detachedFromTarget')

  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  const evidence = {
    sessionId,
    parentBytes: JSON.stringify(parentTree).length,
    frameBytes: JSON.stringify(frameTree).length,
    verifiedAt: new Date().toISOString()
  }
  await writeFile(join(cache, 'tauri-iframe-check-latest.json'), JSON.stringify(evidence, null, 2))
  console.log(
    `Iframe session ${sessionId}: attach, session AX/eval and detach verified on WebView2.`
  )
} catch (error) {
  // Why explicit: finally calls process.exit, which would swallow a
  // pending throw and mask the failure as success.
  console.error(`[iframe-check] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try {
    if (page) {
      await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID }).catch(() => {})
    }
  } finally {
    parentServer?.destroySockets()
    frameServer?.destroySockets()
    await Promise.all([
      new Promise((fulfill) => parentServer?.close(() => fulfill())),
      new Promise((fulfill) => frameServer?.close(() => fulfill()))
    ])
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
  // Sockets are destroyed above so no keep-alive holds the loop open; force
  // out to mirror the sibling checks instead of lingering on CDP handles.
  process.exit(process.exitCode ?? 0)
}
