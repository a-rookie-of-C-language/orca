import type { PageLogBuffers } from './tauri-native-browser-cdp-events'
import { isRecord } from './tauri-native-browser-automation'

// Network log assembly for the Tauri CDP event tap: merges the per-request
// DevTools events into completed entries. Redirects reuse the request id for
// the next leg, so each leg closes before the next starts.

const MAX_NETWORK_ENTRIES = 1000
const MAX_NETWORK_PENDING = 2000

export type PendingNetworkRequest = {
  url: string
  method: string
  timestamp: number
  status: number
  mimeType: string
}

function pushCompletedNetworkEntry(
  buffers: PageLogBuffers,
  pending: PendingNetworkRequest,
  size: number
): void {
  buffers.networkEntries.push({
    url: pending.url,
    method: pending.method,
    status: pending.status,
    mimeType: pending.mimeType,
    size,
    timestamp: pending.timestamp
  })
  if (buffers.networkEntries.length > MAX_NETWORK_ENTRIES) {
    buffers.networkEntries.splice(0, buffers.networkEntries.length - MAX_NETWORK_ENTRIES)
    buffers.networkTruncated = true
  }
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return Date.now()
  }
  if (value >= 1_000_000_000_000) {
    return Math.floor(value)
  }
  if (value >= 1_000_000_000) {
    return Math.floor(value * 1000)
  }
  return Date.now()
}

export function recordNetworkEvent(
  buffers: PageLogBuffers,
  event: string,
  params: Record<string, unknown>
): void {
  const requestId = typeof params.requestId === 'string' ? params.requestId : ''
  if (!requestId) {
    return
  }
  if (event === 'Network.requestWillBeSent') {
    const request = isRecord(params.request) ? params.request : {}
    const finished = buffers.networkPending.get(requestId)
    if (finished && isRecord(params.redirectResponse)) {
      buffers.networkPending.delete(requestId)
      pushCompletedNetworkEntry(buffers, finished, 0)
    }
    buffers.networkPending.set(requestId, {
      url: typeof request.url === 'string' ? request.url : '',
      method: typeof request.method === 'string' ? request.method : '',
      timestamp: normalizeTimestamp(params.timestamp),
      status: 0,
      mimeType: ''
    })
    if (buffers.networkPending.size > MAX_NETWORK_PENDING) {
      const oldest = buffers.networkPending.keys().next()
      if (!oldest.done) {
        buffers.networkPending.delete(oldest.value)
        buffers.networkTruncated = true
      }
    }
    return
  }
  if (event === 'Network.responseReceived') {
    const response = isRecord(params.response) ? params.response : {}
    const pending = buffers.networkPending.get(requestId)
    if (!pending) {
      return
    }
    if (typeof response.status === 'number') {
      pending.status = response.status
    }
    if (typeof response.mimeType === 'string') {
      pending.mimeType = response.mimeType
    }
    return
  }
  if (event === 'Network.loadingFinished') {
    const pending = buffers.networkPending.get(requestId)
    if (!pending) {
      return
    }
    buffers.networkPending.delete(requestId)
    const encodedLength = params.encodedDataLength
    pushCompletedNetworkEntry(
      buffers,
      pending,
      typeof encodedLength === 'number' && encodedLength >= 0 ? Math.floor(encodedLength) : 0
    )
    return
  }
  if (event === 'Network.loadingFailed') {
    const pending = buffers.networkPending.get(requestId)
    if (!pending) {
      return
    }
    buffers.networkPending.delete(requestId)
    pushCompletedNetworkEntry(buffers, pending, 0)
  }
}
