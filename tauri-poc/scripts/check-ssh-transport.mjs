import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for the direct-SSH transport on Tauri: a loopback ssh2
// server with password auth and a canned `uname` answer serves as the remote,
// the renderer adds it as a target, the password prompt is bridged back
// through submitCredential, and ssh.testConnection reports success with a
// connected state through the orcad sidecar. A full ssh.connect is also
// attempted to pin the dev boundary: dev builds carry no orcad template, so
// the managed-server decision shared with Electron reports
// artifacts_unavailable and the transport is dropped, exactly like Electron
// main in dev. Refuses visible windows and foreign checkouts, and always
// removes the target, disconnects, and stops the server.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const USERNAME = 'orca-probe'
const PASSWORD = 'probe-only-password-not-a-secret'

const require = createRequire(import.meta.url)
const { Server } = require('ssh2')

const connections = new Set()
let page
let targetId
let server

async function startLoopbackServer() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  server = new Server(
    { hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] },
    (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
          ctx.accept()
        } else {
          ctx.reject()
        }
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptChannel, reject, info) => {
            // Canned platform answer: the transport probes `uname` for platform detection.
            if (/uname/.test(info.command)) {
              const channel = acceptChannel()
              channel.stdout.write('Linux\n')
              channel.exit(0)
              channel.end()
            } else {
              reject()
            }
          })
        })
      })
    }
  )
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise)
      resolvePromise()
    })
  })
  return server.address().port
}

try {
  const port = await startLoopbackServer()
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const added = await page.evaluate(
    (params) =>
      window.api.ssh.addTarget({
        target: {
          label: 'tauri-probe-transport',
          host: '127.0.0.1',
          port: params.port,
          username: params.username
        }
      }),
    { port, username: USERNAME }
  )
  targetId = added?.target?.id ?? added?.id
  assert.ok(targetId, 'addTarget returned no target id.')
  await page.evaluate(
    (params) => {
      window.__sshProbeCredentials = []
      window.api.ssh.onCredentialRequest((request) => {
        if (request.targetId !== params.targetId) {
          return
        }
        window.__sshProbeCredentials.push(request.kind)
        void window.api.ssh.submitCredential({
          requestId: request.requestId,
          value: params.password
        })
      })
    },
    { targetId, password: PASSWORD }
  )
  const tested = await page.evaluate(
    (id) => window.api.ssh.testConnection({ targetId: id }),
    targetId
  )
  assert.equal(tested?.success, true, `ssh.testConnection failed: ${JSON.stringify(tested)}`)
  assert.equal(tested?.state?.status, 'connected', 'testConnection reported no connected state.')
  const credentials = await page.evaluate(() => window.__sshProbeCredentials)
  assert.ok(
    credentials.includes('password'),
    `No password prompt was bridged: ${JSON.stringify(credentials)}`
  )
  let connectError = null
  try {
    await page.evaluate((id) => window.api.ssh.connect({ targetId: id }), targetId)
  } catch (error) {
    connectError = String(error?.message ?? error)
  }
  assert.ok(connectError, 'ssh.connect resolved for a host dev builds cannot provision.')
  assert.ok(
    /SSH connection unavailable/.test(connectError),
    `ssh.connect rejected with an unrelated error: ${connectError}`
  )
  const state = await page.evaluate((id) => window.api.ssh.getState({ targetId: id }), targetId)
  assert.equal(state, null, 'ssh.getState retained state for the unprovisionable host.')
  await page.evaluate((id) => window.api.ssh.removeTarget({ id }), targetId)
  targetId = null
  const evidence = { tested, credentials, connectError, at: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-ssh-transport-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(
    'Direct SSH transport proves password auth and platform detection; full connect pins the dev template boundary.'
  )
} finally {
  try {
    if (page && targetId) {
      await page.evaluate(
        (id) => window.api.ssh.disconnect({ targetId: id }).catch(() => {}),
        targetId
      )
      await page.evaluate((id) => window.api.ssh.removeTarget({ id }).catch(() => {}), targetId)
    }
  } finally {
    await new Promise((resolvePromise) =>
      server ? server.close(resolvePromise) : resolvePromise()
    )
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
