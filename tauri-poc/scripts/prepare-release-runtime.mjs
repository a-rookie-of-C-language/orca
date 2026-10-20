import { build } from 'esbuild'
import { copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output = join(root, 'out', 'orcad', 'tauri-runtime-supervisor.mjs')
const resourceRoot = join(root, 'tauri-poc', 'resources')

await build({
  entryPoints: [join(root, 'tauri-poc/scripts/runtime-supervisor.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: output,
  // Why: esbuild wraps the CommonJS process-host dependency in a runtime
  // require; release Node runs the supervisor as a native ESM module.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  },
  sourcemap: false,
  minify: true,
  logLevel: 'error'
})

for (const name of ['orcad', 'runtimes']) {
  const source = join(root, 'out', name)
  const destination = join(resourceRoot, name)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true })
}

// Why fail loudly here: the packaged admin probe and orcad CLI slot both run
// `orcad/bin/orca.exe` from the resources bundle, and a bundle without it would
// only surface as Admin-unknown plus dead CLI registration on the installed app.
if (process.platform === 'win32') {
  const launcher = join(resourceRoot, 'orcad', 'bin', 'orca.exe')
  if (!existsSync(launcher)) {
    throw new Error(`Packaged Tauri runtime is missing the Windows CLI launcher: ${launcher}`)
  }
}

// Why fail loudly here: the packaged elevation flow spawns
// `orcad/bin/orca-administrator-restart.exe` beside the CLI launcher, and a
// bundle without it would only surface as a dead restart-as-administrator
// action on the installed app.
if (process.platform === 'win32') {
  const restartHelperSource = join(
    root,
    '.build',
    'windows-cli-launcher',
    process.arch,
    'orca-administrator-restart.exe'
  )
  if (!existsSync(restartHelperSource)) {
    throw new Error(
      `Packaged Tauri runtime is missing the Windows administrator restart helper: ${restartHelperSource}`
    )
  }
  copyFileSync(
    restartHelperSource,
    join(resourceRoot, 'orcad', 'bin', 'orca-administrator-restart.exe')
  )
}

const nativePackage =
  process.platform === 'win32' && process.arch === 'x64'
    ? 'sherpa-onnx-win-x64'
    : `sherpa-onnx-${process.platform}-${process.arch}`
const nativeSource = join(root, 'node_modules', nativePackage)
if (!existsSync(nativeSource)) {
  throw new Error(`Missing speech native package: ${nativeSource}`)
}
const nativeDestination = join(resourceRoot, 'node_modules', nativePackage)
mkdirSync(join(resourceRoot, 'node_modules'), { recursive: true })
cpSync(realpathSync(nativeSource), nativeDestination, { recursive: true })

console.log(`Prepared Tauri runtime supervisor at ${output}`)
