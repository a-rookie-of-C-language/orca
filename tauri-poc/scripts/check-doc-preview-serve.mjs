import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for document-preview serving through real hidden guest
// pages in the doc-preview partition: a plain http baseline renders, then a
// separate guest navigates the minted grant URL (rewritten to the WRY http
// alias, since WebView2 aborts raw post-creation custom-scheme navigations)
// and serves the cached entry bytes with no did-fail-load. Clicking an
// external link emits doc-preview:external-link without leaving the grant
// page, reload re-serves the cached entry, and closing auto-revokes the
// grant. Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19241
const STAMP = Date.now().toString(36)
const BASE_PAGE_ID = 'e2e-doc-serve-base-' + STAMP
const PAGE_ID = 'e2e-doc-serve-' + STAMP
const HTTP_MARKER = 'DOC-SERVE-HTTP-BASELINE'
const DOC_MARKER = 'DOC-SERVE-CACHED-ENTRY'
const EXT_URL = 'https://example.com/ext-proof'
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

async function childEvaluate(page, pageId, expression, strict) {
  const reply = await invoke(page, 'poc_browser_cdp', {
    args: {
      browserPageId: pageId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }
  })
  if (reply?.exceptionDetails && strict) {
    throw new Error(`guest evaluate threw: ${JSON.stringify(reply.exceptionDetails).slice(0, 200)}`)
  }
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
    window.__docServeExtEvents = []
    if (window.__docServeListenersInstalled) return
    window.__docServeListenersInstalled = true
    window.__TAURI__.event
      .listen('browser:page-event', (incident) => {
        window.__docServePageEvents.push(incident.payload)
      })
      .catch(() => {})
    window.__TAURI__.event
      .listen('doc-preview:external-link', (incident) => {
        window.__docServeExtEvents.push(incident.payload)
      })
      .catch(() => {})
  })
  try {
    await invoke(page, 'poc_browser_close', { args: { browserPageId: BASE_PAGE_ID } })
  } catch {}
  await invoke(page, 'poc_browser_create', {
    args: {
      browserPageId: BASE_PAGE_ID,
      partition: 'orca-doc-preview',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false
    }
  })
  await invoke(page, 'poc_browser_navigate', {
    args: { browserPageId: BASE_PAGE_ID, url: `http://${HOST}:${PORT}/` }
  })
  let httpText = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    httpText =
      (await childEvaluate(page, BASE_PAGE_ID, 'location.href + "|" + document.body.innerText')) ??
      ''
    if (httpText.includes(HTTP_MARKER)) break
    await delay(100)
  }
  assert.ok(httpText.includes(HTTP_MARKER), `guest baseline never rendered: ${httpText}`)
  step('http baseline renders in the partitioned guest')
  await invoke(page, 'poc_browser_close', { args: { browserPageId: BASE_PAGE_ID } })
  try {
    await invoke(page, 'poc_browser_close', { args: { browserPageId: PAGE_ID } })
  } catch {}
  await invoke(page, 'poc_browser_create', {
    args: {
      browserPageId: PAGE_ID,
      partition: 'orca-doc-preview',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false
    }
  })
  step('partitioned guest created')
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
        `<!doctype html><html><body><h1>${DOC_MARKER}</h1><a id="extlink" href="${EXT_URL}">external</a></body></html>`,
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
    docText =
      (await childEvaluate(page, PAGE_ID, 'location.href + "|" + document.body.innerText')) ?? ''
    if (docText.includes(DOC_MARKER)) break
    await delay(100)
  }
  assert.ok(docText.includes(DOC_MARKER), `grant never served: ${docText}`)
  step('grant serves through the guest')
  const bridged = await childEvaluate(
    page,
    PAGE_ID,
    'window.__orcaDocPreviewLinkBridge === true',
    true
  )
  assert.equal(bridged, true, 'guest link bridge never installed')
  const anchorHref = await childEvaluate(
    page,
    PAGE_ID,
    'document.getElementById("extlink")?.href ?? null',
    true
  )
  assert.equal(anchorHref, EXT_URL, 'served entry has no external link')
  await childEvaluate(page, PAGE_ID, 'document.getElementById("extlink").click()', true)
  let ext = []
  for (let attempt = 0; attempt < 100; attempt++) {
    ext = await page.evaluate(() => window.__docServeExtEvents || [])
    if (ext.length > 0) break
    await delay(100)
  }
  assert.equal(ext.length, 1, `external link signal missing: ${JSON.stringify(ext).slice(0, 200)}`)
  assert.equal(ext[0].browserPageId, PAGE_ID)
  assert.equal(ext[0].url, EXT_URL)
  step('external link intercepted')
  const hrefAfter = await childEvaluate(page, PAGE_ID, 'location.href', true)
  assert.ok(
    hrefAfter.includes('orca-preview.') && !hrefAfter.includes('orca-internal'),
    `guest left the grant page: ${String(hrefAfter).slice(0, 120)}`
  )
  step('guest stayed on the grant page')
  await invoke(page, 'poc_browser_reload', { args: { browserPageId: PAGE_ID } })
  let reloaded = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    reloaded =
      (await childEvaluate(page, PAGE_ID, 'location.href + "|" + document.body.innerText')) ?? ''
    if (reloaded.includes(DOC_MARKER)) break
    await delay(100)
  }
  assert.ok(
    reloaded.includes(DOC_MARKER),
    `reload lost the served entry: ${reloaded.slice(0, 160)}`
  )
  step('reload re-serves the cached entry')
  const failures = await page.evaluate(
    (wanted) =>
      (window.__docServePageEvents || []).filter(
        (event) =>
          event?.browserPageId === wanted &&
          event?.eventType === 'did-fail-load' &&
          !String(event?.url ?? '').includes('orca-internal')
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
    await invoke(page, 'poc_browser_close', { args: { browserPageId: BASE_PAGE_ID } })
  } catch {}
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
