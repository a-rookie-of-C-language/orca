import { spawnProcess } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { superviseDevelopmentApp } from './dev-app-supervisor.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtimeEntry = resolve(root, '.cache/orcad-dev/orcad-server.js')
if (!existsSync(runtimeEntry)) {
  console.error('Tauri development runtime is not built.')
  console.error('Run: node tauri-poc/scripts/build-runtime.mjs')
  process.exitCode = 1
  process.exit()
}

const manifest = resolve(root, 'tauri-poc/src-tauri/Cargo.toml')
const viteEntry = resolve(root, 'node_modules/vite/bin/vite.js')
const cargo = process.env.CARGO ?? 'cargo'
const environment = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: process.env.ORCA_BACKGROUND_LAUNCH ?? '1',
  ORCA_DEV_REPO_ROOT: root,
  ORCA_TAURI_DEV_SUPERVISED: '1',
  ORCA_TAURI_NODE: process.execPath
}

const vite = spawnProcess({
  program: process.execPath,
  args: [
    viteEntry,
    '--config',
    'vite.web.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '5174',
    '--strictPort'
  ],
  cwd: root,
  env: environment,
  stdio: 'inherit'
})
let appSupervisor = null

let stopping = false
const stop = (signal) => {
  if (stopping) {
    return
  }
  stopping = true
  vite.kill()
  appSupervisor?.stop(signal)
}
const forwardSignal = (signal) => stop(signal)
process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))

vite.once('error', (error) => {
  console.error(`Could not start Vite: ${error.message}`)
  stop()
  process.exitCode = 1
})

async function waitForVite() {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:5174/web-index.html')
      if (response.ok) {
        return
      }
    } catch {
      // Vite is still starting.
    }
    await delay(200)
  }
  throw new Error('Vite did not become ready within 15 seconds.')
}

try {
  await waitForVite()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  stop()
  process.exitCode = 1
  process.exit()
}

appSupervisor = superviseDevelopmentApp({
  launch: () =>
    spawnProcess({
      program: cargo,
      args: ['run', '--manifest-path', manifest],
      cwd: root,
      env: environment,
      stdio: 'inherit'
    }),
  stopVite: () => vite.kill()
})
