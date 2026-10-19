import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
// Live Windows proof for single-instance enforcement: a second OS launch exits
// fast, its argv reaches the running app as a second-instance payload, opened
// documents resolve, --open-settings flips the pending flag once, share links
// and documents reach live renderer listeners, and the main window stays
// hidden. Refuses visible windows and foreign checkouts like the sibling checks.
function step(message) {
  writeSync(1, `[second-instance-check] ${message}\n`)
}
const invoke = (page, cmd, payload) =>
  page.evaluate(
    ([c, p]) =>
      p === undefined
        ? window.__TAURI_INTERNALS__.invoke(c)
        : window.__TAURI_INTERNALS__.invoke(c, p),
    [cmd, payload]
  )
let page
const scratch = mkdtempSync(join(tmpdir(), 'orca-second-instance-'))
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')
  const drained = await invoke(page, 'poc_consume_second_instance_events')
  step(`drained events=${Array.isArray(drained) ? drained.length : 'non-array'}`)
  await invoke(page, 'poc_consume_pending_open_settings')
  const doc = join(scratch, 'notes.md')
  writeFileSync(doc, '# probe\n')
  await page.evaluate(() => {
    window.__probeShare = null
    window.__probeDocs = null
    window.api.ui.onOpenSkillShare((id) => {
      window.__probeShare = id
    })
    window.api.ui.onOpenMarkdownFiles((docs) => {
      window.__probeDocs = docs
    })
  })
  step('listeners installed')
  const exe = join(root, 'tauri-poc', 'src-tauri', 'target', 'debug', 'orca-tauri-poc.exe')
  const link = 'orca://skills/share/probe-7'
  const child = spawn(exe, [doc, link, '--open-settings'], {
    cwd: scratch,
    windowsHide: true,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  const exited = await new Promise((res) => {
    const timer = setTimeout(() => res('timeout'), 60000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      res(`exit:${code}`)
    })
  })
  step(`second instance ${exited}`)
  let payload = null
  for (let i = 0; i < 40 && !payload; i++) {
    const events = await invoke(page, 'poc_consume_second_instance_events')
    if (Array.isArray(events) && events.length > 0) {
      payload = events.at(-1)
    } else {
      await delay(250)
    }
  }
  if (!payload) {
    throw new Error('no second-instance payload arrived')
  }
  step(`payload id=${payload.id} args=${JSON.stringify(payload.args)}`)
  if (!payload.args.includes(doc)) {
    throw new Error('doc path missing from forwarded argv')
  }
  if (!payload.args.includes(link)) {
    throw new Error('share link missing from forwarded argv')
  }
  const resolved = await invoke(page, 'poc_resolve_opened_documents', { paths: payload.args })
  step(`resolved=${JSON.stringify(resolved)}`)
  if (!resolved.some((d) => d.basename === 'notes.md')) {
    throw new Error('notes.md not resolved')
  }
  const pending = await invoke(page, 'poc_consume_pending_open_settings')
  const pendingAgain = await invoke(page, 'poc_consume_pending_open_settings')
  step(`pending settings first=${pending} second=${pendingAgain}`)
  if (pending !== true || pendingAgain !== false) {
    throw new Error('open-settings flag mismatch')
  }
  await delay(1000)
  const share = await page.evaluate(() => window.__probeShare)
  const docs = await page.evaluate(() => window.__probeDocs)
  step(`renderer share=${share} docs=${JSON.stringify(docs)}`)
  if (share !== 'probe-7') {
    throw new Error('share link did not reach renderer')
  }
  if (!Array.isArray(docs) || !docs.some((d) => d.basename === 'notes.md')) {
    throw new Error('docs did not reach renderer')
  }
  const visible = await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible())
  step(`main visible=${visible}`)
  if (visible) {
    throw new Error('second launch stole focus in background mode')
  }
  step('done')
} finally {
  rmSync(scratch, { recursive: true, force: true })
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
step('passed')
