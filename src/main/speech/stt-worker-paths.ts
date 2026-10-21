import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

function firstExistingPath(candidates: string[]): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function getSttWorkerPath(): string {
  if (getAppEnvironment().isPackaged()) {
    const appPath = getAppEnvironment().getAppPath()
    return firstExistingPath([
      join(appPath, 'stt-worker.js'),
      join(process.resourcesPath, 'app.asar', 'out', 'main', 'stt-worker.js'),
      join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'stt-worker.js')
    ])
  }
  return join(__dirname, 'stt-worker.js')
}

export function getSherpaModulePath(): string {
  const nativePackage =
    process.platform === 'win32' && process.arch === 'x64'
      ? 'sherpa-onnx-win-x64'
      : `sherpa-onnx-${process.platform}-${process.arch}`

  if (getAppEnvironment().isPackaged()) {
    return firstExistingPath([
      join(getAppEnvironment().getAppPath(), 'node_modules', nativePackage),
      join(process.resourcesPath, 'node_modules', nativePackage),
      join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', nativePackage)
    ])
  }

  const resolved = require.resolve(nativePackage)
  return join(resolved, '..')
}
