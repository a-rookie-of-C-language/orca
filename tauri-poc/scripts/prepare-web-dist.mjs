import { cp, mkdir, rm, rename } from 'node:fs/promises'
import { resolve } from 'node:path'

const tauriPocDir = resolve(import.meta.dirname, '..')
const sourceDir = resolve(tauriPocDir, '..', 'out', 'web')
const destinationDir = resolve(tauriPocDir, 'dist')

await rm(destinationDir, { recursive: true, force: true })
await mkdir(destinationDir, { recursive: true })
await cp(sourceDir, destinationDir, { recursive: true })
await rename(resolve(destinationDir, 'web-index.html'), resolve(destinationDir, 'index.html'))

console.log(`[orca-tauri-poc] prepared ${destinationDir}`)
