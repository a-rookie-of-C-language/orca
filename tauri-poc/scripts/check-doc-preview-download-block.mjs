import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof that a grant-bound preview guest cannot download: clicking
// a download link in the served entry denies the download before anything is
// reserved or written, the shell learns through doc-preview:load-failure with
// reason download-blocked and no path, a second rapid click adds no second
// notice, and the page stays on the grant entry. Refuses visible windows and
// foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19242
const STAMP = Date.now().toString(36)
const PAGE_ID = 'e2e-doc-download-block-' + STAMP
const DOC_MARKER = 'DOC-DOWNLOAD-BLOCK-ENTRY'
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

async function trustedClick(page, pageId, elementId) {
  const rectJson = await childEvaluate(
    page,
    pageId,
    `(() => { const el = document.getElementById('${elementId}'); el.scrollIntoView({ block: 'center' }); const rect = el.getBoundingClientRect(); return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); })()`,
    true
  )
  const rect = JSON.parse(rectJson)
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await invoke(page, 'poc_browser_cdp', {
      args: {
        browserPageId: pageId,
        method: 'Input.dispatchMouseEvent',
        params: { type, x, y, button: 'left', clickCount: 1 }
      }
    })
  }
}

function step(message) {
  console.log(`[doc-download-block-check] ${message}`)
}

let server
let page
try {
  server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><h1>unused</h1></body></html>')
  })
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')
  await page.evaluate(() => {
    window.__docDownloadBlockFailures = []
    window.__docDownloadBlockRequested = []
    if (window.__docDownloadBlockListenersInstalled) return
    window.__docDownloadBlockListenersInstalled = true
    window.__TAURI__.event
      .listen('doc-preview:load-failure', (incident) => {
        window.__docDownloadBlockFailures.push(incident.payload)
      })
      .catch(() => {})
    window.__TAURI__.event
      .listen('browser:download-requested', (incident) => {
        window.__docDownloadBlockRequested.push(incident.payload)
      })
      .catch(() => {})
  })
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
      owner: { kind: 'ssh', connectionId: 'download-block-check' },
      requestBase: '/docs',
      root: '/docs',
      entryRelativePath: 'probe.html',
      browserPageId: PAGE_ID
    }
  })
  assert.match(grant.grantId, /^[0-9a-f]{32}$/, `mint grant id: ${JSON.stringify(grant)}`)
  assert.equal(
    await invoke(page, 'poc_doc_preview_authorize_directory', {
      grantId: grant.grantId,
      relativePath: 'sibling.html'
    }),
    true,
    'sibling directory never authorized'
  )
  const cached = await invoke(page, 'poc_doc_preview_cache_file', {
    request: {
      grantId: grant.grantId,
      relativePath: 'probe.html',
      filePath: '/docs/probe.html',
      contentBase64: Buffer.from(
        `<!doctype html><html><body><h1>${DOC_MARKER}</h1><a id="dllink" href="sibling.html" download="sibling.html">download</a></body></html>`,
        'utf8'
      ).toString('base64')
    }
  })
  assert.equal(cached, true, 'grant entry never cached')
  const cachedSibling = await invoke(page, 'poc_doc_preview_cache_file', {
    request: {
      grantId: grant.grantId,
      relativePath: 'sibling.html',
      filePath: '/docs/sibling.html',
      contentBase64: Buffer.from(
        '<!doctype html><html><body><h1>sibling</h1></body></html>',
        'utf8'
      ).toString('base64')
    }
  })
  assert.equal(cachedSibling, true, 'sibling entry never cached')
  step('grant minted and entries cached')
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
  await trustedClick(page, PAGE_ID, 'dllink')
  await trustedClick(page, PAGE_ID, 'dllink')
  let failures = []
  for (let attempt = 0; attempt < 100; attempt++) {
    failures = await page.evaluate(() => window.__docDownloadBlockFailures || [])
    if (failures.length > 0) break
    await delay(100)
  }
  assert.equal(failures.length, 1, `download-block notice missing: ${JSON.stringify(failures)}`)
  assert.equal(failures[0].grantId, grant.grantId)
  assert.equal(failures[0].reason, 'download-blocked')
  assert.ok(!('relativePath' in failures[0]), `notice names a path: ${JSON.stringify(failures[0])}`)
  step('blocked download notifies once without a path')
  await delay(300)
  const requested = await page.evaluate(() => window.__docDownloadBlockRequested || [])
  assert.equal(
    requested.filter((event) => event?.browserPageId === PAGE_ID).length,
    0,
    `preview download escaped: ${JSON.stringify(requested).slice(0, 200)}`
  )
  step('no download reserved or written')
  const hrefAfter = await childEvaluate(page, PAGE_ID, 'location.href', true)
  assert.ok(
    hrefAfter.includes('orca-preview.') && hrefAfter.includes('probe'),
    `guest left the grant page: ${String(hrefAfter).slice(0, 120)}`
  )
  step('guest stayed on the grant page')
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
