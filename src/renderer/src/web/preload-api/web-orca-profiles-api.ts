import type { OrcaProfileApi } from '../../../../preload/api/orca-profile-api'
import type { OrcaCloudSignInProgress } from '../../../../shared/orca-profiles'
import { subscribeRuntimeClientEvents } from '../../runtime/runtime-client-events'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'

const authStatusListeners = new Set<() => void>()
const signInProgressListeners = new Set<(progress: OrcaCloudSignInProgress | null) => void>()
let eventsSubscription: { unsubscribe: () => void } | null = null
let eventsPromise: Promise<void> | null = null

function ensureEventsSubscription(): void {
  if (eventsSubscription || eventsPromise) {
    return
  }
  if (authStatusListeners.size === 0 && signInProgressListeners.size === 0) {
    return
  }
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return
  }
  eventsPromise = subscribeRuntimeClientEvents(
    environment.id,
    (event) => {
      if (event.type === 'orcaProfileAuthStatusChanged') {
        for (const listener of authStatusListeners) {
          listener()
        }
      }
      if (event.type === 'orcaProfileSignInProgressChanged') {
        for (const listener of signInProgressListeners) {
          listener(event.progress)
        }
      }
    },
    () => {}
  )
    .then((next) => {
      eventsPromise = null
      if (authStatusListeners.size === 0 && signInProgressListeners.size === 0) {
        next.unsubscribe()
        return
      }
      eventsSubscription = next
    })
    .catch(() => {
      eventsPromise = null
    })
}

function releaseEventsIfUnused(): void {
  if (authStatusListeners.size > 0 || signInProgressListeners.size > 0) {
    return
  }
  eventsSubscription?.unsubscribe()
  eventsSubscription = null
}

export function createWebOrcaProfilesApi(): { orcaProfiles: OrcaProfileApi } {
  return {
    orcaProfiles: {
      list: () => callRuntimeResult('orcaProfiles.list', {}),
      authStatus: () => callRuntimeResult('orcaProfiles.authStatus', {}),
      onAuthStatusChanged: (callback) => {
        authStatusListeners.add(callback)
        ensureEventsSubscription()
        return () => {
          authStatusListeners.delete(callback)
          releaseEventsIfUnused()
        }
      },
      onSignInProgressChanged: (callback) => {
        signInProgressListeners.add(callback)
        ensureEventsSubscription()
        return () => {
          signInProgressListeners.delete(callback)
          releaseEventsIfUnused()
        }
      },
      // Why: switching/creating local profiles mutates the profile index the running host
      // is bound to; on Electron that is a relaunch flow — not available in the web client.
      createLocal: () =>
        Promise.reject(new Error('Local profiles are not available over the remote connection.')),
      createCloudLinked: (args) =>
        callRuntimeResult('orcaProfiles.createCloudLinked', args ?? {}),
      switchProfile: () =>
        Promise.reject(
          new Error('Profile switching restarts the host; use the desktop app for it.')
        ),
      transferProject: () =>
        Promise.reject(new Error('Profile project transfer is not available remotely.')),
      findProjectProfiles: () => Promise.resolve({ projects: [] }),
      connectCurrent: () => callRuntimeResult('orcaProfiles.connectCurrent', {}),
      signInProgress: () =>
        callRuntimeResult<OrcaCloudSignInProgress | null>('orcaProfiles.signInProgress', {}),
      cancelSignIn: () => callRuntimeResult('orcaProfiles.cancelSignIn', {}),
      refreshAuth: () => callRuntimeResult('orcaProfiles.refreshAuth', {}),
      signOutCurrent: () => callRuntimeResult('orcaProfiles.signOutCurrent', {}),
      selectOrg: (args) => callRuntimeResult('orcaProfiles.selectOrg', args),
      orgMembersList: () => Promise.resolve({ status: 'unconfigured' }),
      orgMemberInvite: () => Promise.resolve({ status: 'unconfigured' }),
      orgInviteRevoke: () => Promise.resolve({ status: 'unconfigured' }),
      orgMemberChangeRole: () => Promise.resolve({ status: 'unconfigured' }),
      orgMemberRemove: () => Promise.resolve({ status: 'unconfigured' })
    }
  }
}
