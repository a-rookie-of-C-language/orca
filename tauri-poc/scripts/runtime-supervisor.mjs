import { spawnProcess } from '@orca/process-host'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Reuse orcad's launcher-disconnect contract; never terminate the persistent PTY daemon.
export function superviseRuntime({ entry, input, owner = process, spawn = spawnProcess }) {
  const child = spawn({
    program: process.execPath,
    args: [entry, '--bind', '127.0.0.1', '--port', '0', '--json'],
    env: { ...process.env, ORCA_BUNDLED_LAUNCHER_CHANNEL: '1' },
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  let stopping = false
  const stop = () => {
    if (stopping) {
      return
    }
    stopping = true
    if (child.connected) {
      child.disconnect()
    }
  }
  const cleanup = () => {
    input.off('end', stop)
    input.off('error', stop)
    input.off('data', stop)
    owner.off('SIGINT', stop)
    owner.off('SIGTERM', stop)
    input.pause()
  }
  input.once('end', stop)
  input.once('error', stop)
  input.once('data', stop)
  owner.on('SIGINT', stop)
  owner.on('SIGTERM', stop)
  child.once('error', () => {
    cleanup()
    console.error('[tauri] Could not launch the Node runtime.')
    owner.exitCode = 1
  })
  child.once('exit', (code) => {
    cleanup()
    owner.exitCode = code ?? 1
  })
  input.resume()
  return child
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    throw new Error('An orcad server entry is required.')
  }
  superviseRuntime({ entry: resolve(process.argv[2]), input: process.stdin })
}
