import type { AutomationCommandContext, TauriCdpSender } from './tauri-native-browser-automation'
import { withTauriAgentBrowserInput } from './tauri-native-browser-agent-input'
import {
  evaluatePageExpression,
  isRecord,
  resolveAutomationRef,
  resolveElementObjectId
} from './tauri-native-browser-automation'
import {
  pageCoordinatesForAutomationEntry,
  senderForAutomationEntry
} from './tauri-native-browser-iframe-sessions'
import { dispatchMouse } from './tauri-native-browser-automation-pointer'

async function callElementFunction(
  send: TauriCdpSender,
  objectId: string,
  functionDeclaration: string
): Promise<unknown> {
  const response = await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  }).catch(() => {
    throw new Error('browser_element_not_interactable')
  })
  if (!isRecord(response) || response.exceptionDetails !== undefined) {
    throw new Error('browser_element_not_interactable')
  }
  const result = response.result
  if (!isRecord(result)) {
    return null
  }
  return result.value ?? null
}

async function elementCenter(
  context: AutomationCommandContext,
  element: string
): Promise<{ x: number; y: number; objectId: string }> {
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  const center = await callElementFunction(
    send,
    objectId,
    'function() { this.scrollIntoView({ block: "center", inline: "center" }); const rect = this.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }; }'
  )
  if (!isRecord(center)) {
    throw new Error('browser_element_not_interactable')
  }
  const x = center.x
  const y = center.y
  const width = center.width
  const height = center.height
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error('browser_element_not_interactable')
  }
  if (typeof width === 'number' && typeof height === 'number' && (width <= 0 || height <= 0)) {
    throw new Error('browser_element_not_interactable')
  }
  // Iframe rects are frame-local; mouse input dispatches on the page.
  const point = await pageCoordinatesForAutomationEntry(context, entry, x, y)
  return { x: point.x, y: point.y, objectId }
}

export async function dragAutomationElements(
  context: AutomationCommandContext,
  from: string,
  to: string
): Promise<{ dragged: { from: string; to: string } }> {
  const start = await elementCenter(context, from)
  const end = await elementCenter(context, to)
  await dispatchMouse(context.send, 'mouseMoved', start)
  await dispatchMouse(context.send, 'mousePressed', start, { buttons: 1 })
  await dispatchMouse(context.send, 'mouseMoved', end, { buttons: 1 })
  await dispatchMouse(context.send, 'mouseReleased', end)
  return { dragged: { from, to } }
}

export async function clickAutomationElement(
  context: AutomationCommandContext,
  element: string,
  clickCount: number
): Promise<{ clicked: string }> {
  const point = await elementCenter(context, element)
  await dispatchMouse(context.send, 'mousePressed', point, {
    clickCount,
    buttons: 1
  })
  await dispatchMouse(context.send, 'mouseReleased', point, {
    clickCount,
    buttons: 1
  })
  return { clicked: element }
}

export async function hoverAutomationElement(
  context: AutomationCommandContext,
  element: string
): Promise<{ hovered: string }> {
  const point = await elementCenter(context, element)
  await dispatchMouse(context.send, 'mouseMoved', point)
  return { hovered: element }
}

export async function focusAutomationElement(
  context: AutomationCommandContext,
  element: string
): Promise<{ focused: string }> {
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  await callElementFunction(send, objectId, 'function() { this.focus(); }')
  return { focused: element }
}

export async function fillAutomationElement(
  context: AutomationCommandContext,
  element: string,
  value: string
): Promise<{ filled: string }> {
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  const escaped = JSON.stringify(value)
  await callElementFunction(
    send,
    objectId,
    `function() { this.focus(); const value = ${escaped}; if ('value' in this) { this.value = value; } else if (this.isContentEditable) { this.textContent = value; } this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`
  )
  return { filled: element }
}

export async function selectAutomationElement(
  context: AutomationCommandContext,
  element: string,
  value: string
): Promise<{ selected: string }> {
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  const escaped = JSON.stringify(value)
  await callElementFunction(
    send,
    objectId,
    `function() { this.focus(); this.value = ${escaped}; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`
  )
  return { selected: element }
}

export async function checkAutomationElement(
  context: AutomationCommandContext,
  element: string,
  checked: boolean
): Promise<{ checked: boolean }> {
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  const next = await callElementFunction(
    send,
    objectId,
    `function() { if (this.checked !== ${checked ? 'true' : 'false'}) { this.click(); } return Boolean(this.checked); }`
  )
  return { checked: typeof next === 'boolean' ? next : checked }
}

export async function selectAllAutomationElement(
  context: AutomationCommandContext,
  element: string
): Promise<{ selected: string }> {
  return withTauriAgentBrowserInput(context.browserPageId, async () => {
    const entry = resolveAutomationRef(context.refs, element)
    const send = senderForAutomationEntry(context, entry)
    const objectId = await resolveElementObjectId(send, entry)
    await callElementFunction(
      send,
      objectId,
      'function() { this.focus(); if (typeof this.select === "function") { try { this.select(); } catch {} } }'
    )
    await context
      .send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2
      })
      .catch(() => {
        throw new Error('browser_cdp_error')
      })
    await context
      .send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: 2
      })
      .catch(() => {
        throw new Error('browser_cdp_error')
      })
    return { selected: element }
  })
}

export async function scrollAutomationPage(
  context: AutomationCommandContext,
  direction: string,
  amount?: number
): Promise<{ scrolled: 'up' | 'down' }> {
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('browser_invalid_params')
  }
  const distance = typeof amount === 'number' && amount > 0 ? amount : 0
  await evaluatePageExpression(
    context.send,
    `(() => { const distance = ${distance}; const delta = distance > 0 ? distance : Math.floor(window.innerHeight * 0.8); window.scrollBy(0, ${direction === 'up' ? '-' : ''}delta); return true; })()`
  )
  return { scrolled: direction }
}

export async function scrollIntoViewAutomationElement(
  context: AutomationCommandContext,
  element: string
): Promise<{ scrolledIntoView: string }> {
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  await send('DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {
    throw new Error('browser_element_not_interactable')
  })
  return { scrolledIntoView: element }
}

export async function insertAutomationText(
  context: AutomationCommandContext,
  text: string
): Promise<{ typed: boolean }> {
  return withTauriAgentBrowserInput(context.browserPageId, async () => {
    const remaining = text
    const chunkSize = 8000
    for (let offset = 0; offset < remaining.length; offset += chunkSize) {
      const chunk = remaining.slice(offset, offset + chunkSize)
      await context.send('Input.insertText', { text: chunk }).catch(() => {
        throw new Error('browser_cdp_error')
      })
    }
    return { typed: true }
  })
}

export async function pressAutomationKey(
  context: AutomationCommandContext,
  key: string
): Promise<{ pressed: string }> {
  return withTauriAgentBrowserInput(context.browserPageId, async () => {
    await context.send('Input.dispatchKeyEvent', { type: 'keyDown', key }).catch(() => {
      throw new Error('browser_cdp_error')
    })
    await context.send('Input.dispatchKeyEvent', { type: 'keyUp', key }).catch(() => {
      throw new Error('browser_cdp_error')
    })
    return { pressed: key }
  })
}
