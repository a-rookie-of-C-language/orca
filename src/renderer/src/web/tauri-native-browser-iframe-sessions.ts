import type { AutomationCommandContext, TauriCdpSender } from './tauri-native-browser-automation'
import { evaluatePageExpression, isRecord } from './tauri-native-browser-automation'
import {
  registerTauriBrowserCdpEventSink,
  subscribeTauriBrowserCdpEvents
} from './tauri-native-browser-cdp-events'
import { invokeNative } from './tauri-native-host'

// Iframe session tracking for the Tauri client host, mirroring the CDP
// bridge: flattened Target sessions give each OOPIF iframe its own AX/DOM
// tree. The registry maps target id to session id per page; element
// commands resolve their sender through the owning ref, while mouse input
// stays on the page with iframe-local coords translated to page space.

export const TAURI_BROWSER_TARGET_EVENTS = [
  'Target.attachedToTarget',
  'Target.detachedFromTarget'
] as const

const targetSessions = new Map<string, Map<string, string>>()
const sessionSenders = new Map<string, TauriCdpSender>()
let targetSinkInstalled = false

function sessionsFor(browserPageId: string): Map<string, string> {
  const existing = targetSessions.get(browserPageId)
  if (existing) {
    return existing
  }
  const created = new Map<string, string>()
  targetSessions.set(browserPageId, created)
  return created
}

function enableSessionDomains(browserPageId: string, sessionId: string): void {
  const send = createTauriSessionCdpSender(browserPageId, sessionId)
  send('DOM.enable', {}).catch(() => undefined)
  send('Accessibility.enable', {}).catch(() => undefined)
}

function handleTargetDetached(browserPageId: string, params: Record<string, unknown>): void {
  const detached = params.sessionId
  if (typeof detached !== 'string' || detached.length === 0) {
    return
  }
  const sessions = sessionsFor(browserPageId)
  for (const [targetId, sessionId] of sessions) {
    if (sessionId === detached) {
      sessions.delete(targetId)
      sessionSenders.delete(`${browserPageId}\n${detached}`)
      break
    }
  }
}

function handleTargetAttached(browserPageId: string, params: Record<string, unknown>): void {
  const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : {}
  const targetId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : ''
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  if (!targetId || !sessionId) {
    return
  }
  const type = typeof targetInfo.type === 'string' ? targetInfo.type : ''
  if (type !== 'iframe') {
    return
  }
  const sessions = sessionsFor(browserPageId)
  sessions.set(targetId, sessionId)
  enableSessionDomains(browserPageId, sessionId)
}

function ensureTargetSink(): void {
  if (targetSinkInstalled) {
    return
  }
  targetSinkInstalled = true
  registerTauriBrowserCdpEventSink('Target.attachedToTarget', (browserPageId, params) => {
    handleTargetAttached(browserPageId, params)
  })
  registerTauriBrowserCdpEventSink('Target.detachedFromTarget', (browserPageId, params) => {
    handleTargetDetached(browserPageId, params)
  })
}

export async function ensureTauriIframeTracking(
  browserPageId: string,
  send: TauriCdpSender
): Promise<void> {
  ensureTargetSink()
  await subscribeTauriBrowserCdpEvents(browserPageId, TAURI_BROWSER_TARGET_EVENTS)
  // OOPIF iframes stay invisible to the page session without flattening.
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  }).catch(() => {
    throw new Error('browser_cdp_error')
  })
}

export function listTauriIframeSessions(browserPageId: string): Map<string, string> {
  return new Map(sessionsFor(browserPageId))
}

export function createTauriSessionCdpSender(
  browserPageId: string,
  sessionId: string
): TauriCdpSender {
  const key = `${browserPageId}\n${sessionId}`
  const cached = sessionSenders.get(key)
  if (cached) {
    return cached
  }
  const send: TauriCdpSender = async (
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> => {
    const envelope = await invokeNative<unknown>('poc_browser_cdp_session', {
      args: { browserPageId, sessionId, method, params }
    }).catch(() => {
      throw new Error('browser_cdp_error')
    })
    if (!isRecord(envelope)) {
      throw new Error('browser_cdp_error')
    }
    if (isRecord(envelope.error)) {
      throw new Error('browser_cdp_error')
    }
    // Same single-wrapped contract as the page sender above: the session
    // pipe returns the raw CDP method result, never an extra envelope.
    return envelope
  }
  sessionSenders.set(key, send)
  return send
}

export function senderForAutomationEntry(
  context: AutomationCommandContext,
  entry: { sessionId?: string }
): TauriCdpSender {
  if (entry.sessionId) {
    return createTauriSessionCdpSender(context.browserPageId, entry.sessionId)
  }
  return context.send
}

type IframeRect = { x: number; y: number; src: string }

function matchRectByUrl(rects: IframeRect[], targetUrl: string): IframeRect | undefined {
  for (const rect of rects) {
    if (rect.src === targetUrl) {
      return rect
    }
  }
  try {
    const targetOrigin = new URL(targetUrl).origin
    for (const rect of rects) {
      if (rect.src) {
        try {
          if (new URL(rect.src).origin === targetOrigin) {
            return rect
          }
        } catch {
          continue
        }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

// Iframe-local coords (getBoundingClientRect inside the frame) translate to
// page space through the frame element offset, since Input events dispatch
// on the page session. Best effort: unknown frames keep local coords.
export async function pageCoordinatesForAutomationEntry(
  context: AutomationCommandContext,
  entry: { sessionId?: string },
  x: number,
  y: number
): Promise<{ x: number; y: number }> {
  if (!entry.sessionId) {
    return { x, y }
  }
  try {
    let targetUrl = ''
    for (const [targetId, sessionId] of sessionsFor(context.browserPageId)) {
      if (sessionId !== entry.sessionId) {
        continue
      }
      const info = await context.send('Target.getTargetInfo', { targetId }).catch(() => null)
      if (isRecord(info) && isRecord(info.targetInfo)) {
        const url = info.targetInfo.url
        if (typeof url === 'string') {
          targetUrl = url
        }
      }
      break
    }
    const rawRects = await evaluatePageExpression(
      context.send,
      '(() => { const frames = document.querySelectorAll("iframe, frame"); const rects = []; for (const f of frames) { const rect = f.getBoundingClientRect(); rects.push({ x: rect.x, y: rect.y, src: f.src || "" }); } return JSON.stringify(rects); })()'
    ).catch(() => null)
    let rects: IframeRect[] = []
    try {
      const parsed: unknown = typeof rawRects === 'string' ? JSON.parse(rawRects) : rawRects
      if (Array.isArray(parsed)) {
        rects = parsed.filter(
          (item): item is IframeRect =>
            isRecord(item) &&
            typeof item.x === 'number' &&
            typeof item.y === 'number' &&
            typeof item.src === 'string'
        )
      }
    } catch {
      return { x, y }
    }
    if (rects.length === 0) {
      return { x, y }
    }
    if (targetUrl) {
      const matched = matchRectByUrl(rects, targetUrl)
      if (matched) {
        return { x: x + matched.x, y: y + matched.y }
      }
    }
    if (rects.length === 1) {
      return { x: x + rects[0].x, y: y + rects[0].y }
    }
  } catch {
    return { x, y }
  }
  return { x, y }
}

export function retireTauriIframeSessions(browserPageId: string): void {
  const sessions = targetSessions.get(browserPageId)
  if (sessions) {
    for (const sessionId of sessions.values()) {
      sessionSenders.delete(`${browserPageId}\n${sessionId}`)
    }
  }
  targetSessions.delete(browserPageId)
}

export function resetTauriIframeSessionsForTest(): void {
  targetSessions.clear()
  sessionSenders.clear()
}
