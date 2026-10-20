import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live WebView2 proof for the new client-route cookie jar names: resolving a
// synthetic route identity yields a `persist:tauri-browser-v1-<slug>-<hash>`
// partition plus a 64-hex binding fingerprint, repeat resolves are identical,
// and a different environment derives a different partition. A hidden WebView2
// on the resolved partition proves the round trip live: a cookie written
// through CDP reads back on the same partition. Cross-partition isolation is
// NOT asserted: Tauri documents `data_store_identifier` as macOS/iOS-only and
// drops it on Windows (tauri-runtime-wry gates it out; wry's `with_profile_name`
// is never wired), so all child webviews share one jar there. The observed
// sharing is recorded in the evidence instead of pinned. Refuses visible
// windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19231
const PAGE_A = 'e2e-jar-check-a'
const PAGE_B = 'e2e-jar-check-b'
const connections = new Set()

const pageHtml = `<!doctype html><html><head><title>Jar</title></head><body>jar probe</body></html>`

function serve() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(pageHtml)
  })
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

async function waitForReady(pageId, page, timeoutMs = 30000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 500) {
    const state = await invoke(page, 'poc_browser_cdp', {
      browserPageId: pageId,
      method: 'Runtime.evaluate',
      params: { expression: 'document.readyState', returnByValue: true }
    })
    if (state?.result?.value === 'complete') {
      return
    }
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${pageId} to load.`)
}

async function readCookie(pageId, page) {
  const result = await invoke(page, 'poc_browser_cdp', {
    browserPageId: pageId,
    method: 'Runtime.evaluate',
    params: { expression: 'document.cookie', returnByValue: true }
  })
  return result?.result?.value ?? ''
}

let server
let page
try {
  server = await serve()
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)

  const identityA = {
    environmentId: 'jar-probe-env-a',
    profileId: 'jar-probe-profile',
    executionHostKey: 'jar-probe-host'
  }
  const resolvedA = await invoke(page, 'poc_browser_client_route_resolve_partition', identityA)
  assert.match(resolvedA.partition, /^persist:tauri-browser-v1-jar-probe-profile-[0-9a-f]{16}$/)
  assert.match(resolvedA.bindingFingerprint, /^[0-9a-f]{64}$/)
  const resolvedA2 = await invoke(page, 'poc_browser_client_route_resolve_partition', identityA)
  assert.deepEqual(resolvedA2, resolvedA)
  const resolvedB = await invoke(page, 'poc_browser_client_route_resolve_partition', {
    ...identityA,
    environmentId: 'jar-probe-env-b'
  })
  assert.notEqual(resolvedB.partition, resolvedA.partition)
  assert.notEqual(resolvedB.bindingFingerprint, resolvedA.bindingFingerprint)

  for (const pageId of [PAGE_A, PAGE_B]) {
    try {
      await invoke(page, 'poc_browser_close', { browserPageId: pageId })
    } catch {
      // No stale page from a previous run; create fresh below.
    }
  }
  await invoke(page, 'poc_browser_create', {
    browserPageId: PAGE_A,
    partition: resolvedA.partition,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false
  })
  await invoke(page, 'poc_browser_create', {
    browserPageId: PAGE_B,
    partition: resolvedB.partition,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false
  })
  await invoke(page, 'poc_browser_navigate', {
    browserPageId: PAGE_A,
    url: `http://${HOST}:${PORT}/`
  })
  await invoke(page, 'poc_browser_navigate', {
    browserPageId: PAGE_B,
    url: `http://${HOST}:${PORT}/`
  })
  await waitForReady(PAGE_A, page)
  await waitForReady(PAGE_B, page)
  for (const pageId of [PAGE_A, PAGE_B]) {
    await invoke(page, 'poc_browser_cdp', {
      browserPageId: pageId,
      method: 'Network.clearBrowserCookies',
      params: {}
    })
  }
  await invoke(page, 'poc_browser_cdp', {
    browserPageId: PAGE_A,
    method: 'Runtime.evaluate',
    params: { expression: "document.cookie = 'jarprobe=partition-a'", returnByValue: true }
  })
  const cookieA = await readCookie(PAGE_A, page)
  assert.ok(cookieA.includes('jarprobe='), `The jar on partition A missed the cookie: ${cookieA}`)
  const cookieB = await readCookie(PAGE_B, page)
  const crossPartitionIsolated = !cookieB.includes('jarprobe=')

  await mkdir(join(root, '.cache'), { recursive: true })
  const evidence = {
    partitionA: resolvedA.partition,
    fingerprintA: resolvedA.bindingFingerprint,
    partitionB: resolvedB.partition,
    cookieA,
    cookieB,
    crossPartitionIsolated,
    verifiedAt: new Date().toISOString()
  }
  await writeFile(
    join(root, '.cache', 'tauri-jar-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(
    `Jar names ${resolvedA.partition}: write/read on A, cross-partition isolated=${crossPartitionIsolated}.`
  )
} catch (error) {
  console.error(`[jar-check] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try {
    if (page) {
      await invoke(page, 'poc_browser_close', { browserPageId: PAGE_A }).catch(() => {})
      await invoke(page, 'poc_browser_close', { browserPageId: PAGE_B }).catch(() => {})
    }
  } finally {
    server?.destroySockets()
    await new Promise((fulfill) => (server ? server.close(() => fulfill()) : fulfill()))
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
  process.exit(process.exitCode ?? 0)
}
