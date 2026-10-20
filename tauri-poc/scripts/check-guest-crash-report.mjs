import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for guest renderer crash reports: killing a hidden
// guest renderer via CDP Page.crash records a pending crash report from Rust
// (the dead renderer cannot report itself) and pairs the WebView2 Crashpad
// dump the way Electron process-gone capture does. Refuses visible windows.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19239
const PAGE_ID = `e2e-guest-crash-${Date.now().toString(36)}`
const connections = new Set()

const guestHtml = `<!doctype html><html><head><title>crash-probe</title></head><body>crash me</body></html>`

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

function step(message) {
  console.log(`[guest-crash-check] ${message}`)
}

let server
let page
let reportId = null
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
  let loaded = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await invoke(page, 'poc_browser_cdp', {
      browserPageId: PAGE_ID,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true }
    })
    if (reply?.result?.value === 'crash-probe') {
      loaded = true
      break
    }
    await delay(100)
  }
  assert.equal(loaded, true, 'The guest page never loaded.')
  step('guest page loaded')

  try {
    await invoke(page, 'poc_browser_cdp', {
      browserPageId: PAGE_ID,
      method: 'Page.crash',
      params: {}
    })
  } catch (error) {
    // Page.crash kills the response channel with the renderer: no reply
    // IS the success signal. Anything else surfaces as a missing report
    // in the poll below.
    step(`crash call ended: ${error?.message ?? error}`)
  }
  step('renderer killed, waiting for the Rust-recorded report')
  let report = null
  for (let attempt = 0; attempt < 120; attempt++) {
    const latest = await invoke(page, 'poc_crash_reports_get_latest_pending')
    if (
      latest &&
      latest.details &&
      latest.details.browser_page_id === PAGE_ID &&
      latest.details.minidumpStatus
    ) {
      report = latest
      break
    }
    await delay(250)
  }
  assert.ok(report, 'No guest crash report with minidump status appeared.')
  assert.equal(report.processType, 'guest')
  assert.equal(report.details.minidumpStatus, 'captured')
  assert.equal(report.details.minidumpProcessType, 'renderer')
  reportId = report.id
  step(`report paired: ${report.details.minidumpPath}`)
  await assertReadyHidden(page, root)
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-guest-crash-check-latest.json'),
    JSON.stringify(
      {
        pageId: PAGE_ID,
        reportId,
        reason: report.reason,
        minidumpStatus: report.details.minidumpStatus,
        minidumpProcessType: report.details.minidumpProcessType,
        at: new Date().toISOString()
      },
      null,
      2
    )
  )
  step('evidence written')
} finally {
  try {
    if (page && PAGE_ID) {
      await invoke(page, 'poc_browser_close', { browserPageId: PAGE_ID }).catch(() => {})
    }
    if (page && reportId) {
      await invoke(page, 'poc_crash_reports_dismiss', { reportId }).catch(() => {})
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
