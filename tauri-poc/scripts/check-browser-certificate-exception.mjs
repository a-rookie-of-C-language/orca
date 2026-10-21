import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live WebView2 proof for the certificate exception boundary: a hidden child
// webview navigates to a self-signed local HTTPS server, the check observes
// the -202 challenge overlay event, rejects a bogus challenge, proceeds with
// the real one, reads the page back, closes the page, then proves a fresh
// page to the same endpoint is challenged again instead of riding the
// remembered WebView2 bypass. Refuses visible windows and other checkouts
// like the sibling checks.

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
const MARKER = 'tauri-cert-exception-marker'
const GEN1 = 'tauri-cert-check-gen1'
const GEN2 = 'tauri-cert-check-gen2'

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, { args }),
    { command, args }
  )
}

function step(message) {
  console.log(`[cert-check] ${message}`)
}

async function waitForChallenge(page, timeoutMs) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 250) {
    const events = await page.evaluate(() => window.__certCheckEvents ?? [])
    const failure = events.find((entry) => entry.kind === 'cert' && entry.payload?.failure)
    if (failure) {
      return failure.payload.failure
    }
    await delay(250)
  }
  return null
}

async function waitForFail(page, pageId, timeoutMs = 30000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 250) {
    const events = await page.evaluate(() => window.__certCheckEvents ?? [])
    const fail = events.find(
      (entry) =>
        entry.kind === 'page' &&
        entry.payload?.browserPageId === pageId &&
        entry.payload?.eventType === 'did-fail-load'
    )
    if (fail) {
      return fail.payload
    }
    await delay(250)
  }
  return null
}

async function readMarker(page, pageId, timeoutMs = 30000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 500) {
    const reply = await invoke(page, 'poc_browser_cdp', {
      browserPageId: pageId,
      method: 'Runtime.evaluate',
      params: { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }
    })
    const text = reply?.result?.value ?? ''
    if (text.includes(MARKER)) {
      return text
    }
    await delay(500)
  }
  return ''
}

let server
let page
try {
  const certificateSource = await readFile(
    join(root, 'src/main/browser/browser-local-https-test-certificate.ts'),
    'utf8'
  )
  const key = certificateSource.match(
    /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/
  )?.[0]
  const cert = certificateSource.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/
  )?.[0]
  assert.ok(key && cert, 'The static local HTTPS test identity is missing.')
  server = createServer({ key, cert }, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<html><body>${MARKER}</body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const target = `https://127.0.0.1:${server.address().port}/`
  step(`serving ${target}`)

  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')

  await page.evaluate(() => {
    window.__certCheckEvents = []
    void window.__TAURI__.event
      .listen('browser:certificate-failure-changed', (incident) =>
        window.__certCheckEvents.push({ kind: 'cert', payload: incident.payload })
      )
      .catch(() => {})
    void window.__TAURI__.event
      .listen('browser:page-event', (incident) =>
        window.__certCheckEvents.push({ kind: 'page', payload: incident.payload })
      )
      .catch(() => {})
  })
  step('event listeners installed')

  for (const stale of [GEN1, GEN2]) {
    try {
      await invoke(page, 'poc_browser_close', { browserPageId: stale })
    } catch {
      // No stale page from a previous run; create fresh below.
    }
  }

  await invoke(page, 'poc_browser_create', {
    browserPageId: GEN1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false
  })
  await invoke(page, 'poc_browser_navigate', { browserPageId: GEN1, url: target })
  step('gen1 navigating')
  const challenge = await waitForChallenge(page, 30000)
  assert.ok(challenge?.canProceed, 'Gen1 raised no proceedable certificate challenge.')
  assert.equal(challenge.errorCode, -202, 'Gen1 challenge is not the expected -202.')
  const fail = await waitForFail(page, GEN1)
  assert.equal(fail?.errorCode, -202, 'Gen1 raised no -202 did-fail-load.')
  step(`gen1 challenged (${challenge.challengeId})`)

  const bogus = await invoke(page, 'poc_browser_proceed_certificate', {
    browserPageId: GEN1,
    challengeId: 'bogus-challenge'
  })
  assert.equal(bogus?.ok, false, 'A bogus challenge id proceeded.')
  const proceeded = await invoke(page, 'poc_browser_proceed_certificate', {
    browserPageId: GEN1,
    challengeId: challenge.challengeId
  })
  assert.equal(proceeded?.ok, true, 'The real challenge did not proceed.')
  step('gen1 proceeded')

  const gen1Text = await readMarker(page, GEN1)
  assert.ok(gen1Text.includes(MARKER), 'Gen1 did not load after proceed.')
  await invoke(page, 'poc_browser_close', { browserPageId: GEN1 })
  step('gen1 loaded and closed')

  await page.evaluate(() => {
    window.__certCheckEvents = []
  })
  await invoke(page, 'poc_browser_create', {
    browserPageId: GEN2,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false
  })
  await invoke(page, 'poc_browser_navigate', { browserPageId: GEN2, url: target })
  step('gen2 navigating')
  const rechallenge = await waitForChallenge(page, 15000)
  assert.ok(
    rechallenge?.canProceed,
    'Gen2 loaded the endpoint with no challenge: the remembered WebView2 bypass outlived its page.'
  )
  step(`gen2 rechallenged (${rechallenge.challengeId})`)
  await invoke(page, 'poc_browser_close', { browserPageId: GEN2 })

  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  await writeFile(
    join(cache, 'tauri-cert-check-latest.json'),
    JSON.stringify(
      { target, gen1Challenge: challenge.challengeId, gen2Challenge: rechallenge.challengeId },
      null,
      2
    )
  )
  step('certificate exception boundary verified on WebView2')
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
}
