import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createEmptyDocument, isJsonObject, type JsonObject } from './keybinding-document'

export {
  FILE_VERSION,
  createEmptyDocument,
  isJsonObject,
  normalizeWriteBindingValue,
  parseBindingSection,
  parsePlatformOverrides,
  removeConflictingOverrides,
  type JsonObject
} from './keybinding-document'

export function readJsonDocument(path: string): {
  exists: boolean
  document: JsonObject | null
  error?: string
} {
  if (!existsSync(path)) {
    return { exists: false, document: createEmptyDocument() }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isJsonObject(parsed)) {
      return { exists: true, document: null, error: 'Keybindings file must contain a JSON object.' }
    }
    return { exists: true, document: parsed }
  } catch (error) {
    return {
      exists: true,
      document: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function writeJsonDocument(path: string, document: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(tempPath, path)
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // Ignore cleanup failure; the original write error is more actionable.
    }
    throw error
  }
}
