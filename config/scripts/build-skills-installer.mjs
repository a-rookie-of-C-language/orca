import { build } from 'esbuild'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')

function bundledDependencyNotices(inputs, installerRoot) {
  const packageDirectories = new Set()
  for (const input of Object.keys(inputs)) {
    let directory = dirname(resolve(root, input))
    while (directory !== dirname(directory)) {
      const manifestPath = join(directory, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.name) {
          if (directory !== installerRoot) {
            packageDirectories.add(directory)
          }
          break
        }
      }
      directory = dirname(directory)
    }
  }
  return [...packageDirectories]
    .sort()
    .map((directory) => {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      const licenses = readdirSync(directory).filter((name) =>
        /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name)
      )
      if (licenses.length === 0) {
        throw new Error(`Missing redistribution notice for bundled ${manifest.name}`)
      }
      return [
        `Bundled dependency: ${manifest.name}@${manifest.version} (${manifest.license ?? 'see license below'})`,
        ...licenses.sort().map((name) => `${name}\n${readFileSync(join(directory, name), 'utf8')}`)
      ].join('\n\n')
    })
    .join('\n\n---\n\n')
}

// Bundle the published package unchanged; upstream owns targets and placement semantics.
export async function buildSkillsInstaller(outputDirectory) {
  const require = createRequire(join(root, 'package.json'))
  const packageRoot = dirname(require.resolve('skills/package.json'))
  const installerRequire = createRequire(join(packageRoot, 'package.json'))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.version !== '1.7.2') {
    throw new Error('The reviewed skills installer must be version 1.7.2')
  }
  mkdirSync(outputDirectory, { recursive: true })
  const result = await build({
    entryPoints: [join(packageRoot, 'dist', 'cli.mjs')],
    outfile: join(outputDirectory, 'skills-installer', 'dist', 'cli.mjs'),
    bundle: true,
    // tar's default entry embeds dependencies outside the lockfile; use its published modules.
    alias: {
      tar: join(dirname(installerRequire.resolve('tar/package.json')), 'dist', 'esm', 'index.js')
    },
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: {
      js: 'import { createRequire as __orcaCreateRequire } from "node:module"; const require = __orcaCreateRequire(import.meta.url);'
    },
    metafile: true,
    logLevel: 'error'
  })
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external)
  if (externalImports.some((entry) => !isBuiltin(entry.path))) {
    throw new Error('The skills installer must bundle every non-builtin dependency')
  }
  for (const filename of ['package.json', 'LICENSE']) {
    copyFileSync(join(packageRoot, filename), join(outputDirectory, 'skills-installer', filename))
  }
  writeFileSync(
    join(outputDirectory, 'skills-installer', 'ThirdPartyNoticeText.txt'),
    [
      readFileSync(join(packageRoot, 'ThirdPartyNoticeText.txt'), 'utf8'),
      'Additional dependencies bundled by Orca from its lockfile:',
      bundledDependencyNotices(result.metafile.inputs, packageRoot)
    ].join('\n\n')
  )
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSkillsInstaller(join(root, 'out', 'cli'))
}
