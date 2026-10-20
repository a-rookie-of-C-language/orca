import type { AutomationCommandContext, TauriCdpSender } from './tauri-native-browser-automation'
import { evaluatePageExpression, isRecord, readNumber } from './tauri-native-browser-automation'

export async function dispatchMouse(
  send: TauriCdpSender,
  type: string,
  point: { x: number; y: number },
  extra: Record<string, unknown> = {}
): Promise<void> {
  await send('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
    ...extra
  }).catch(() => {
    throw new Error('browser_cdp_error')
  })
}

async function viewportCenter(send: TauriCdpSender): Promise<{ x: number; y: number }> {
  const size = await evaluatePageExpression(
    send,
    '(() => ({ width: window.innerWidth, height: window.innerHeight }))()'
  )
  if (isRecord(size) && typeof size.width === 'number' && typeof size.height === 'number') {
    return { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) }
  }
  return { x: 0, y: 0 }
}

async function pointerPosition(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ x: number; y: number }> {
  const x = readNumber(params, 'x')
  const y = readNumber(params, 'y')
  if (typeof x === 'number' && typeof y === 'number') {
    return { x, y }
  }
  return viewportCenter(context.send)
}

export async function moveAutomationPointer(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ moved: boolean }> {
  const point = await pointerPosition(context, params)
  await dispatchMouse(context.send, 'mouseMoved', point)
  return { moved: true }
}

export async function pressAutomationPointer(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ pressed: boolean }> {
  const point = await pointerPosition(context, params)
  await dispatchMouse(context.send, 'mousePressed', point, { buttons: 1 })
  return { pressed: true }
}

export async function releaseAutomationPointer(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ released: boolean }> {
  const point = await pointerPosition(context, params)
  await dispatchMouse(context.send, 'mouseReleased', point)
  return { released: true }
}

export async function clickAutomationPointer(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ clicked: boolean }> {
  const point = await pointerPosition(context, params)
  await dispatchMouse(context.send, 'mousePressed', point, { buttons: 1 })
  await dispatchMouse(context.send, 'mouseReleased', point)
  return { clicked: true }
}

export async function wheelAutomationPointer(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ wheeled: boolean }> {
  const dy = readNumber(params, 'dy')
  if (dy === undefined) {
    throw new Error('browser_invalid_params')
  }
  const dx = readNumber(params, 'dx') ?? 0
  const point = await pointerPosition(context, params)
  await dispatchMouse(context.send, 'mouseWheel', point, { deltaX: dx, deltaY: dy })
  return { wheeled: true }
}
