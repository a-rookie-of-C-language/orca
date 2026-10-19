export type TauriPtyDataEvent = {
  id: string
  data: string
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  droppedOutput?: boolean
}

type TauriPtyExitEvent = {
  id: string
  code: number
  preserveRendererBinding?: boolean
}

const dataListeners = new Set<(event: TauriPtyDataEvent) => void>()
const replayListeners = new Set<(data: { id: string; data: string }) => void>()
const exitListeners = new Set<(data: TauriPtyExitEvent) => void>()
const spawnedListeners = new Set<(data: { id: string }) => void>()
const writeUnavailableListeners = new Set<(data: { id: string }) => void>()

export function emitTauriPtyData(event: TauriPtyDataEvent): void {
  for (const listener of dataListeners) {
    listener(event)
  }
}

export function emitTauriPtyReplay(id: string, data: string): void {
  for (const listener of replayListeners) {
    listener({ id, data })
  }
}

export function emitTauriPtyExit(id: string, code: number, preserveRendererBinding = false): void {
  for (const listener of exitListeners) {
    listener({
      id,
      code,
      ...(preserveRendererBinding ? { preserveRendererBinding: true } : {})
    })
  }
}

export function emitTauriPtySpawned(id: string): void {
  for (const listener of spawnedListeners) {
    listener({ id })
  }
}

export function notifyTauriPtyWriteUnavailable(id: string): void {
  for (const listener of writeUnavailableListeners) {
    listener({ id })
  }
}

export function addTauriPtyDataListener(listener: (event: TauriPtyDataEvent) => void): () => void {
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}

export function addTauriPtyReplayListener(
  listener: (data: { id: string; data: string }) => void
): () => void {
  replayListeners.add(listener)
  return () => replayListeners.delete(listener)
}

export function addTauriPtyExitListener(listener: (data: TauriPtyExitEvent) => void): () => void {
  exitListeners.add(listener)
  return () => exitListeners.delete(listener)
}

export function addTauriPtySpawnedListener(listener: (data: { id: string }) => void): () => void {
  spawnedListeners.add(listener)
  return () => spawnedListeners.delete(listener)
}

export function addTauriPtyWriteUnavailableListener(
  listener: (data: { id: string }) => void
): () => void {
  writeUnavailableListeners.add(listener)
  return () => writeUnavailableListeners.delete(listener)
}
