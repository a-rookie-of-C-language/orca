import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for document-preview serving through a real hidden guest
// page: the guest renders a plain http baseline, then navigates the minted
// grant URL (rewritten to the WRY http alias, since WebView2 aborts raw
// post-creation custom-scheme navigations) and serves the cached entry bytes
// with no did-fail-load, and closing the page auto-revokes the grant.
// Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19241
const PAGE_ID = 'e2e-doc-preview-serve-' + Date.now().toString(36)
const HTTP_MARKER = 'DOC-SERVE-HTTP-BASELINE'
const DOC_MARKER = 'DOC-SERVE-CACHED-ENTRY'
const connections = new Set()

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
  return page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })
}

async function childEvaluate(page, expression) {
  const reply = await invoke(page, 'poc_browser_cdp', {
    args: {
      browserPageId: PAGE_ID,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }
  })
  return reply?.result?.value
}

function step(message) {
  console.log(`[doc-preview-serve-check] ${message}`)
}

let server
let page
try {
  server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body><h1>${HTTP_MARKER}</h1></body></html>`)
  })
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')
  await page.evaluate(() => {
    window.__docServePageEvents = []
    if (window.__docServePageEventsInstalled) return
    window.__docServePageEventsInstalled = true
    window.__TAURI__.event
      .listen('browser:page-event', (incident) => {
        window.__docServePageEvents.push(incident.payload)
      })
      .catch(() => {})
  })
  try {
    await invoke(page, 'poc_browser_close', { args: { browserPageId: PAGE_ID } })
  } catch {
    // No stale page from a previous run; create fresh below.
  }
  await invoke(page, 'poc_browser_create', {
    args: {
      browserPageId: PAGE_ID,
      partition: 'orca-doc-preview',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false
    }
  })
  step('partitioned guest created')
  await invoke(page, 'poc_browser_navigate', {
    args: { browserPageId: PAGE_ID, url: `http://${HOST}:${PORT}/` }
  })
  let httpText = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    httpText = (await childEvaluate(page, 'location.href + "|" + document.body.innerText')) ?? ''
    if (httpText.includes(HTTP_MARKER)) break
    await delay(100)
  }
  assert.ok(httpText.includes(HTTP_MARKER), `guest baseline never rendered: ${httpText}`)
  step('http baseline renders in the partitioned guest')
  const grant = await invoke(page, 'poc_doc_preview_mint_grant', {
    request: {
      owner: { kind: 'ssh', connectionId: 'serve-check' },
      requestBase: '/docs',
      root: '/docs',
      entryRelativePath: 'probe.html',
      browserPageId: PAGE_ID
    }
  })
  assert.match(grant.grantId, /^[0-9a-f]{32}$/, `mint grant id: ${JSON.stringify(grant)}`)
  const cached = await invoke(page, 'poc_doc_preview_cache_file', {
    request: {
      grantId: grant.grantId,
      relativePath: 'probe.html',
      filePath: '/docs/probe.html',
      contentBase64: Buffer.from(
        `<!doctype html><html><body><h1>${DOC_MARKER}</h1></body></html>`,
        'utf8'
      ).toString('base64')
    }
  })
  assert.equal(cached, true, 'grant entry never cached')
  step('grant minted and entry cached')
  await invoke(page, 'poc_browser_navigate', {
    args: { browserPageId: PAGE_ID, url: grant.url }
  })
  let docText = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    docText = (await childEvaluate(page, 'location.href + "|" + document.body.innerText')) ?? ''
    if (docText.includes(DOC_MARKER)) break
    await delay(100)
  }
  assert.ok(docText.includes(DOC_MARKER), `grant never served: ${docText}`)
  step('grant serves through the guest')
  const failures = await page.evaluate(
    (wanted) =>
      (window.__docServePageEvents || []).filter(
        (event) => event?.browserPageId === wanted && event?.eventType === 'did-fail-load'
      ),
    PAGE_ID
  )
  assert.equal(failures.length, 0, `guest failed loads: ${JSON.stringify(failures)}`)
  step('no failed guest loads')
  await invoke(page, 'poc_browser_close', { args: { browserPageId: PAGE_ID } })
  const revoked = await invoke(page, 'poc_doc_preview_revoke_grant', {
    grantId: grant.grantId
  })
  assert.equal(revoked, false, 'grant survived the page close')
  step('page close auto-revoked the grant')
} finally {
  try {
    await invoke(page, 'poc_browser_close', { args: { browserPageId: PAGE_ID } })
  } catch {}
  for (const browser of connections) {
    try {
      await browser.close()
    } catch {}
  }
  if (server) {
    server.destroySockets()
    await new Promise((resolve) => server.close(resolve))
  }
}
