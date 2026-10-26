import type { PreloadApi } from '../../../../preload/api-types'
import type {
  BrowserWebAuthnAccountRequest,
  BrowserWebAuthnAccountResponse
} from '../../../../shared/browser-webauthn-account'
import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../../../shared/browser-user-agent-mode'
import { translate } from '@/i18n/i18n'
import { noopUnsubscribe } from './web-storage'

export function createBrowserApi(): NonNullable<Partial<PreloadApi>['browser']> {
  const browserApi = {
    registerGuest: () => Promise.resolve(false),
    isGuestRegistered: () => Promise.resolve(false),
    repairGuestRegistration: () => Promise.resolve(false),
    unregisterGuest: () => Promise.resolve(),
    onWebAuthnAccountRequest: (_callback: (request: BrowserWebAuthnAccountRequest) => void) =>
      noopUnsubscribe,
    onWebAuthnAccountRequestClosed: (_callback: (event: { requestId: string }) => void) =>
      noopUnsubscribe,
    respondWebAuthnAccount: (_response: BrowserWebAuthnAccountResponse) => Promise.resolve(false),
    openDevTools: () => Promise.resolve(false),
    setViewportOverride: () => Promise.resolve(false),
    reportViewportScrollState: () => {},
    setAnnotationViewportBridge: () => Promise.resolve(false),
    // A web client never hosts pages, so it has no lease to publish over.
    publishClientPageMetadata: () => Promise.resolve({ status: 'refused' }),
    onGuestLoadFailed: () => noopUnsubscribe,
    onCertificateFailureChanged: () => noopUnsubscribe,
    proceedCertificate: () => Promise.resolve({ ok: false, reason: 'missing' }),
    onPermissionDenied: () => noopUnsubscribe,
    onPopup: () => noopUnsubscribe,
    onDownloadRequested: () => noopUnsubscribe,
    onDownloadProgress: () => noopUnsubscribe,
    onDownloadFinished: () => noopUnsubscribe,
    onContextMenuRequested: () => noopUnsubscribe,
    onTargetUrlChanged: () => noopUnsubscribe,
    onContextMenuDismissed: () => noopUnsubscribe,
    onNavigationUpdate: () => noopUnsubscribe,
    onActivateView: () => noopUnsubscribe,
    onCapturePaintHold: (_callback: (event: { browserPageId: string; held: boolean }) => void) =>
      noopUnsubscribe,
    onAgentInputFocusGuard: (
      _callback: (event: { browserPageId: string; token: string; active: boolean }) => void
    ) => noopUnsubscribe,
    agentInputFocusGuardReady: (_token: string) => {},
    onPaneFocus: () => noopUnsubscribe,
    onOpenLinkInOrcaTab: () => noopUnsubscribe,
    cancelDownload: () => Promise.resolve(false),
    setGrabMode: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    awaitGrabSelection: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    cancelGrab: () => Promise.resolve(false),
    captureSelectionScreenshot: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.8dfcb7a351',
          'Selection screenshots are unavailable in the web client.'
        )
      }),
    extractHoverPayload: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.275a776357',
          'Hover extraction is unavailable in the web client.'
        )
      }),
    onGrabModeToggle: () => noopUnsubscribe,
    onGrabActionShortcut: () => noopUnsubscribe,
    sessionListProfiles: () => Promise.resolve([]),
    onSessionProfilesChanged: () => noopUnsubscribe,
    // Web clients render remote workspaces through the server; no local SSH routing exists.
    prepareSshWorkspacePartition: () =>
      Promise.reject(new Error('browser_local_route_unavailable')),
    sessionCreateProfile: () => Promise.resolve(null),
    sessionDeleteProfile: () => Promise.resolve(false),
    identityGet: (): Promise<BrowserIdentityModeStatus | null> => Promise.resolve(null),
    identitySet: (_mode: BrowserUserAgentMode): Promise<BrowserIdentityModeSetResult | null> =>
      Promise.resolve(null),
    sessionImportCookies: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionResolvePartition: () => Promise.resolve(null),
    sessionDetectBrowsers: () => Promise.resolve([]),
    sessionDetectBrowsersForClientHost: () => Promise.resolve(null),
    sessionImportFromBrowserForClientHost: () => Promise.resolve(null),
    sessionClientRouteImportSources: () => Promise.resolve({}),
    sessionImportFromBrowser: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionClearDefaultCookies: () => Promise.resolve(false),
    sitePermissionsList: () => Promise.resolve([]),
    sitePermissionsSet: () => Promise.resolve([]),
    notifyActiveTabChanged: () => Promise.resolve(false)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this browser fallback intentionally implements only the web-safe subset of the preload contract.
  return browserApi as unknown as NonNullable<Partial<PreloadApi>['browser']>
}

export function createEmulatorApi(): NonNullable<Partial<PreloadApi>['emulator']> {
  const emulatorApi = {
    onPaneFocus: () => noopUnsubscribe,
    onAutoAttach: () => noopUnsubscribe,
    startFrameStream: () => Promise.reject(new Error('Mobile emulator is unavailable on web.')),
    stopFrameStream: () => Promise.resolve(),
    onFrameStreamFrame: () => noopUnsubscribe,
    onFrameStreamError: () => noopUnsubscribe
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the web fallback exposes the emulator callbacks as explicit no-op implementations.
  return emulatorApi as unknown as NonNullable<Partial<PreloadApi>['emulator']>
}
