import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for direct-SSH file transfer on Tauri: a loopback ssh2
// server with password auth and a read-only SFTP subsystem serves a scratch
// tree, and the renderer adds it as a target, answers the password prompt,
// connects, browses two levels, and caches a document-preview entry through
// the SSH-owner grant. Refuses visible windows and foreign checkouts, and
// always removes the target, disconnects, and stops the server.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const USERNAME = 'orca-probe'
const PASSWORD = 'probe-only-password-not-a-secret'

const require = createRequire(import.meta.url)
const { Server, SFTP_STATUS_CODE } = require('ssh2')

const connections = new Set()
let page
let targetId
let server
let serveRoot

function toServePath(sftpPath) {
  const parts = sftpPath.split('/').filter((part) => part && part !== '.')
  const resolved = resolve(serveRoot, ...parts)
  assert.ok(
    resolved === serveRoot || resolved.startsWith(`${serveRoot}${require('node:path').sep}`),
    `SFTP escape attempt: ${sftpPath}`
  )
  return resolved
}

function attrsOf(diskPath) {
  const stat = statSync(diskPath)
  return {
    mode: stat.isDirectory() ? 0o040755 : 0o100644,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  }
}

function longname(name, diskPath) {
  const stat = statSync(diskPath)
  return `${stat.isDirectory() ? 'd' : '-'}rwxr-xr-x 1 probe probe ${stat.size} Jan 1 00:00 ${name}`
}

async function startSftpServer() {
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
          session.on('exec', (accept, reject, info) => {
            // Canned platform answer: the fixture tree is posix-shaped either way.
            if (/uname/.test(info.command)) {
              const channel = accept()
              channel.stdout.write('Linux\n')
              channel.exit(0)
              channel.end()
            } else {
              reject()
            }
          })
          session.on('sftp', (accept) => {
            const sftp = accept()
            sftp.on('REALPATH', (reqid, givenPath) => {
              try {
                const diskPath = toServePath(givenPath === '.' ? '/' : givenPath)
                const { relative } = require('node:path')
                const rel = relative(serveRoot, diskPath).split(require('node:path').sep).join('/')
                const absolute = `/${rel}`.replace(/^\/\.$/, '/')
                sftp.name(reqid, [
                  {
                    filename: absolute === '/' ? '/' : absolute.replace(/\/$/, ''),
                    longname: absolute,
                    attrs: {}
                  }
                ])
              } catch {
                sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
              }
            })
            sftp.on('STAT', (reqid, path) => statPath(sftp, reqid, path))
            sftp.on('LSTAT', (reqid, path) => statPath(sftp, reqid, path))
            sftp.on('OPENDIR', (reqid, path) => {
              try {
                const diskPath = toServePath(path)
                const entries = readdirSync(diskPath)
                const handle = Buffer.from(`dir:${diskPath}`)
                openDirs.set(handle.toString('hex'), { diskPath, entries, offset: 0 })
                sftp.handle(reqid, handle)
              } catch {
                sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE)
              }
            })
            sftp.on('READDIR', (reqid, handle) => {
              const state = openDirs.get(handle.toString('hex'))
              if (!state) {
                sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
                return
              }
              if (state.offset >= state.entries.length) {
                sftp.status(reqid, SFTP_STATUS_CODE.EOF)
                return
              }
              const out = state.entries.slice(state.offset).map((name) => {
                const diskPath = join(state.diskPath, name)
                return {
                  filename: name,
                  longname: longname(name, diskPath),
                  attrs: attrsOf(diskPath)
                }
              })
              state.offset = state.entries.length
              sftp.name(reqid, out)
            })
            sftp.on('OPEN', (reqid, filename, flags, attrs) => {
              try {
                const diskPath = toServePath(filename)
                const fd = openSync(diskPath, 'r')
                const handle = Buffer.from(`file:${diskPath}:${fd}`)
                openFiles.set(handle.toString('hex'), { fd })
                sftp.handle(reqid, handle)
              } catch {
                sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE)
              }
            })
            sftp.on('READ', (reqid, handle, offset, length) => {
              const state = openFiles.get(handle.toString('hex'))
              if (!state) {
                sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
                return
              }
              const buffer = Buffer.alloc(length)
              let bytesRead
              try {
                bytesRead = readSync(state.fd, buffer, 0, length, offset)
              } catch {
                sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
                return
              }
              if (bytesRead === 0) {
                sftp.status(reqid, SFTP_STATUS_CODE.EOF)
                return
              }
              sftp.data(reqid, buffer.subarray(0, bytesRead))
            })
            sftp.on('FSTAT', (reqid, handle) => {
              const state = openFiles.get(handle.toString('hex'))
              if (!state) {
                sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
                return
              }
              sftp.attrs(reqid, {
                ...attrsOf(`/`),
                size: fstatSync(state.fd).size,
                mode: 0o100644
              })
            })
            sftp.on('CLOSE', (reqid, handle) => {
              const key = handle.toString('hex')
              const file = openFiles.get(key)
              if (file) {
                openFiles.delete(key)
                try {
                  closeSync(file.fd)
                } catch {}
                sftp.status(reqid, SFTP_STATUS_CODE.OK)
                return
              }
              if (openDirs.delete(key)) {
                sftp.status(reqid, SFTP_STATUS_CODE.OK)
                return
              }
              sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
            })
          })
        })
      })
    }
  )
  const openDirs = new Map()
  const openFiles = new Map()
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise)
      resolvePromise()
    })
  })
  return server.address().port

  function statPath(sftp, reqid, path) {
    try {
      const diskPath = toServePath(path)
      if (!existsSync(diskPath)) {
        sftp.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE)
        return
      }
      sftp.attrs(reqid, attrsOf(diskPath))
    } catch {
      sftp.status(reqid, SFTP_STATUS_CODE.FAILURE)
    }
  }
}

try {
  serveRoot = await mkdtemp(join(tmpdir(), 'tauri-ssh-fixture-'))
  await writeFile(join(serveRoot, 'hello.txt'), 'ssh-probe-bytes\n')
  await mkdir(join(serveRoot, 'sub'))
  await writeFile(join(serveRoot, 'sub', 'nested.txt'), 'nested-probe-bytes\n')
  const port = await startSftpServer()
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const added = await page.evaluate(
    (params) =>
      window.api.ssh.addTarget({
        target: {
          label: 'tauri-probe-sftp',
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
      window.__sshProbeStates = []
      window.__sshProbeCredentials = []
      window.__sshProbeUnsubs = [
        window.api.ssh.onStateChanged((change) => {
          if (change.targetId === params.targetId) {
            window.__sshProbeStates.push(change.state?.status)
          }
        }),
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
      ]
    },
    { targetId, password: PASSWORD }
  )
  const state = await page.evaluate((id) => window.api.ssh.connect({ targetId: id }), targetId)
  assert.ok(state, 'ssh.connect returned no state.')
  let connected = state?.status === 'connected'
  for (let attempt = 0; attempt < 100 && !connected; attempt++) {
    await delay(200)
    const current = await page.evaluate((id) => window.api.ssh.getState({ targetId: id }), targetId)
    connected = current?.status === 'connected'
  }
  assert.equal(connected, true, 'The loopback SFTP target never connected.')
  const credentials = await page.evaluate(() => window.__sshProbeCredentials)
  assert.ok(
    credentials.includes('password'),
    `No password prompt was bridged: ${JSON.stringify(credentials)}`
  )
  const listing = await page.evaluate(
    (id) => window.api.ssh.browseDir({ targetId: id, dirPath: '/' }),
    targetId
  )
  const names = new Map(listing.entries.map((entry) => [entry.name, entry.isDirectory]))
  assert.equal(
    names.get('hello.txt'),
    false,
    `Root listing missed hello.txt: ${JSON.stringify(listing.entries)}`
  )
  assert.equal(
    names.get('sub'),
    true,
    `Root listing missed sub/: ${JSON.stringify(listing.entries)}`
  )
  const nested = await page.evaluate(
    (id) => window.api.ssh.browseDir({ targetId: id, dirPath: '/sub' }),
    targetId
  )
  assert.ok(
    nested.entries.some((entry) => entry.name === 'nested.txt' && entry.isDirectory === false),
    `Sub listing missed nested.txt: ${JSON.stringify(nested.entries)}`
  )
  const contentBase64 = Buffer.from('ssh-probe-bytes\n').toString('base64')
  const grant = await page.evaluate(
    (params) =>
      window.api.docPreview.mintGrant({
        owner: { kind: 'ssh', connectionId: params.targetId },
        requestBase: '/',
        root: '/',
        entryRelativePath: 'hello.txt',
        browserPageId: 'tauri-probe-page'
      }),
    { targetId }
  )
  assert.ok(grant?.grantId, 'mintGrant returned no SSH grant.')
  const cached = await page.evaluate(
    (params) =>
      window.api.docPreview.cacheFile({
        grantId: params.grantId,
        relativePath: 'hello.txt',
        filePath: '/hello.txt',
        contentBase64: params.contentBase64,
        contentType: 'text/plain'
      }),
    { grantId: grant.grantId, contentBase64 }
  )
  assert.equal(cached, true, 'The SSH grant refused the cached file.')
  const evidence = {
    connected,
    credentialKinds: credentials,
    rootEntries: listing.entries.length,
    nestedEntries: nested.entries.length,
    grantCached: cached,
    at: new Date().toISOString()
  }
  await writeFile(
    join(root, '.cache', 'tauri-ssh-file-transfer-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(
    'Loopback SSH connects with a password prompt, browses two levels, and caches a preview entry.'
  )
} finally {
  try {
    if (page && targetId) {
      await page.evaluate(
        (id) => window.api.ssh.disconnect({ targetId: id }).catch(() => {}),
        targetId
      )
      await page.evaluate((id) => window.api.ssh.removeTarget({ id }).catch(() => {}), targetId)
      await page.evaluate(() => window.__sshProbeUnsubs?.forEach((unsub) => unsub()))
    }
  } finally {
    await new Promise((resolvePromise) =>
      server ? server.close(resolvePromise) : resolvePromise()
    )
    if (serveRoot) {
      await rm(serveRoot, { recursive: true, force: true })
    }
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
