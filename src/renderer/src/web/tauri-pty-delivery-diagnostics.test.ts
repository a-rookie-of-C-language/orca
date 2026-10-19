import { describe, expect, it } from 'vitest'
import { createTauriPtyDeliveryDiagnostics } from './tauri-pty-delivery-diagnostics'

describe('Tauri PTY delivery diagnostics', () => {
  it('tracks renderer output until the cumulative ACK catches up', () => {
    const diagnostics = createTauriPtyDeliveryDiagnostics()

    diagnostics.recordData('pty-1', 5)
    diagnostics.recordData('pty-1', 7)
    expect(
      diagnostics.report({ receivedCharsByPty: { 'pty-1': 12 }, processedCharsByPty: {} })
    ).toMatchObject({
      inFlightTotalChars: 12,
      inFlightPtyCount: 1,
      msSinceLastAck: null
    })

    diagnostics.recordAck('pty-1', 5, 5)
    expect(
      diagnostics.report({
        receivedCharsByPty: { 'pty-1': 12 },
        processedCharsByPty: { 'pty-1': 5 }
      })
    ).toMatchObject({ inFlightTotalChars: 7, inFlightPtyCount: 1 })

    diagnostics.recordAck('pty-1', 7, 12)
    expect(
      diagnostics.report({
        receivedCharsByPty: { 'pty-1': 12 },
        processedCharsByPty: { 'pty-1': 12 }
      })
    ).toMatchObject({ inFlightTotalChars: 0, inFlightPtyCount: 0 })
  })

  it('records the renderer state used by freeze diagnostics', () => {
    const diagnostics = createTauriPtyDeliveryDiagnostics()
    diagnostics.setDispatcherReady(true)
    diagnostics.setActive('pty-1', true)
    diagnostics.setVisible('pty-1', false)
    diagnostics.setHidden('pty-1', true)
    diagnostics.setInterested('pty-1', true)
    diagnostics.recordData('pty-1', 4)

    const snapshot = diagnostics.snapshot()
    expect(snapshot.rendererPtyDispatcherReady).toBe(true)
    expect(snapshot.activeRendererPtyCount).toBe(1)
    expect(snapshot.hiddenDeliveryGatedPtyCount).toBe(1)
    expect(snapshot.deliveryInterestPtyCount).toBe(1)
    expect(snapshot.diagnostics.perPty).toEqual([
      expect.objectContaining({
        id: 'pty-1',
        sentChars: 4,
        ackedChars: 0,
        inFlightChars: 4,
        hidden: true,
        visible: false,
        active: true
      })
    ])
  })

  it('removes a PTY after its stream exits and resets the dispatcher state', () => {
    const diagnostics = createTauriPtyDeliveryDiagnostics()
    diagnostics.recordData('pty-1', 10)
    diagnostics.setDispatcherReady(true)
    diagnostics.remove('pty-1')
    expect(diagnostics.snapshot().diagnostics.perPty).toEqual([])

    diagnostics.reset()
    expect(diagnostics.snapshot()).toMatchObject({
      rendererPtyDispatcherReady: false,
      rendererInFlightChars: 0
    })
  })
})
