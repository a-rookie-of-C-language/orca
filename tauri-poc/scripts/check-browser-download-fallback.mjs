import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  assertReadyHidden,
  connectDevelopmentRenderer
} from '../scripts/hidden-renderer-connection.mjs'

// Live Windows proof that a guest attachment download lands even though
// WebView2 never raises DownloadStarting here: the response hook records the
// attachment, the abort consumes it, the bytes come back in-page over the
// native message pipe, and the shell surfaces the same download events
// Electron emits. Refuses visible windows and foreign checkouts like the
// sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const HOST = '127.0.0.1'
const PORT = 19261
const SIZE = Number(process.env.ORCA_DL_FALLBACK_BYTES ?? 3 * 1024 * 1024)
const STAMP = Date.now().toString(36)
const PAGE_ID = 'e2e-dl-fallback-' + STAMP
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

const payload = Buffer.alloc(SIZE, 0x62)
const server = await serve((req, res) => {
  if (req.url === '/file.bin') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="fallback.bin"',
      'content-length': String(payload.length)
    })
    res.end(payload)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body>fallback check</body></html>')
})
let page
let downloadedPath = null
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  console.log('[download-fallback-check] renderer ready and hidden')
  // Re-runs in one app process must not stack listeners: every prior run left one
  // live listener per event, which would multiply every observed event.
  await page.evaluate(async () => {
    if (window.__evtsUnlisten) {
      for (const unlisten of window.__evtsUnlisten) {
        try {
          await unlisten()
        } catch {}
      }
    }
    window.__evts = []
    window.__evtsUnlisten = []
    for (const name of [
      'browser:page-event',
      'browser:download-requested',
      'browser:download-progress',
      'browser:download-finished'
    ]) {
      try {
        window.__evtsUnlisten.push(
          await window.__TAURI__.event.listen(name, (incident) => {
            window.__evts.push([name, incident.payload])
          })
        )
      } catch {}
    }
  })
  try {
    await invoke(page, 'poc_browser_close', { args: { browserPageId: PAGE_ID } })
  } catch {}
  await invoke(page, 'poc_browser_create', {
    args: {
      browserPageId: PAGE_ID,
      partition: 'e2e-dl-fallback',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false
    }
  })
  await invoke(page, 'poc_browser_navigate', {
    args: { browserPageId: PAGE_ID, url: `http://${HOST}:${PORT}/` }
  })
  await delay(1500)
  await invoke(page, 'poc_browser_navigate', {
    args: { browserPageId: PAGE_ID, url: `http://${HOST}:${PORT}/file.bin` }
  })
  let evts = []
  const deadline = Date.now() + 60000
  let finished = null
  while (Date.now() < deadline) {
    await delay(1000)
    evts = await page.evaluate(() => window.__evts || [])
    finished = evts.find((entry) => entry[0] === 'browser:download-finished')
    if (finished) {
      break
    }
  }
  const requested = evts.filter((entry) => entry[0] === 'browser:download-requested')
  const progress = evts.filter((entry) => entry[0] === 'browser:download-progress')
  console.log(
    `[download-fallback-check] requested=${requested.length} progress=${progress.length} finished=${finished ? finished[1].status : 'none'}`
  )
  assert.equal(requested.length, 1, 'expected exactly one download-requested')
  assert.equal(requested[0][1].filename, 'fallback.bin')
  assert.equal(requested[0][1].totalBytes, SIZE, 'expected content-length total')
  assert.equal(requested[0][1].mimeType, 'application/octet-stream', 'expected server mime type')
  assert.ok(progress.length >= 1, 'expected progress events')
  assert.equal(progress[0][1].totalBytes, SIZE, 'expected progress to carry the total')
  assert.ok(finished, 'expected download-finished within the deadline')
  assert.equal(finished[1].status, 'completed')
  const savePath = finished[1].savePath
  assert.ok(savePath, 'finished carries the save path')
  downloadedPath = savePath
  const data = readFileSync(savePath)
  assert.equal(data.length, SIZE)
  assert.equal(data.subarray(0, 16).toString(), 'b'.repeat(16))
  console.log(`[download-fallback-check] ${SIZE} bytes landed at ${savePath}`)
  mkdirSync(join(root, '.cache'), { recursive: true })
  writeFileSync(
    join(root, '.cache', 'tauri-download-fallback-check-latest.json'),
    JSON.stringify(
      {
        bytes: SIZE,
        requested: requested.length,
        progress: progress.length,
        status: finished[1].status,
        at: new Date().toISOString()
      },
      null,
      2
    )
  )
} finally {
  try {
    // The probe owns the staged file, so remove it instead of littering Downloads.
    if (downloadedPath) {
      unlinkSync(downloadedPath)
    }
  } catch {}
  try {
    await invoke(page, 'poc_browser_close', { args: { browserPageId: PAGE_ID } })
  } catch {}
  for (const browser of connections) {
    try {
      await browser.close()
    } catch {}
  }
  server.destroySockets()
  server.close()
}
