import { mkdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { getCatalogModel } from './model-catalog'
import { getSpeechModelCacheDirCandidates, type SpeechModelCacheDir } from './model-cache-path'

export function prepareSpeechModelsDir(requestedModelsDir: string): SpeechModelCacheDir {
  let lastError: unknown = null
  for (const candidate of getSpeechModelCacheDirCandidates(requestedModelsDir)) {
    try {
      mkdirSync(candidate.modelsDir, { recursive: true })
      return candidate
    } catch (error) {
      lastError = error
      if (candidate.migrationSourceDir) {
        console.warn('[speech] Failed to prepare ASCII speech model cache:', error)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export function getSafeSpeechModelDir(
  modelId: string,
  modelsDir: string,
  root = modelsDir
): string {
  if (!getCatalogModel(modelId)) {
    throw new Error(`Unknown model: ${modelId}`)
  }
  const modelsRoot = resolve(root)
  const modelDir = resolve(modelsRoot, modelId)
  const rel = relative(modelsRoot, modelDir)
  if (rel.startsWith('..') || rel === '' || rel.includes('..') || resolve(rel) === rel) {
    throw new Error(`Invalid model id: ${modelId}`)
  }
  return modelDir
}
