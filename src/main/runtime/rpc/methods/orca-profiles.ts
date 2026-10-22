// Why: the orcaProfiles IPC handlers serve the Electron renderer; Tauri/web clients need the
// same profile auth surface over runtime RPC so cloud sign-in and Relay status work there.
import { defineMethod } from '../core'
import { getOrcaProfileListState } from '../../../orca-profiles/profile-index-store'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../../../orca-profiles/profile-ui-scope'
import {
  connectCurrentOrcaProfile,
  createCloudLinkedOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  refreshCurrentOrcaProfileAuth,
  selectCurrentOrcaProfileOrg,
  signOutCurrentOrcaProfile
} from '../../../orca-profiles/profile-cloud-service'
import {
  cancelOrcaCloudSignIn,
  getOrcaCloudSignInProgress
} from '../../../orca-profiles/profile-cloud-sign-in-progress'
import {
  OrcaProfileCreateCloudLinkedParams,
  OrcaProfileSelectOrgParams
} from '../../../../shared/rpc-contract/mobile-params'

export const ORCA_PROFILE_METHODS = [
  defineMethod({
    name: 'orcaProfiles.list',
    permission: 'workspace',
    params: null,
    handler: () => ({
      ...getOrcaProfileListState(),
      multiProfileUi: isMultiProfileUiEnabled()
    })
  }),
  defineMethod({
    name: 'orcaProfiles.authStatus',
    permission: 'workspace',
    params: null,
    handler: () => getCurrentOrcaProfileAuthStatus(getProfileUserDataPath())
  }),
  defineMethod({
    name: 'orcaProfiles.connectCurrent',
    permission: 'workspace',
    params: null,
    handler: () => connectCurrentOrcaProfile(getProfileUserDataPath())
  }),
  defineMethod({
    name: 'orcaProfiles.createCloudLinked',
    permission: 'workspace',
    params: OrcaProfileCreateCloudLinkedParams,
    handler: (params) => createCloudLinkedOrcaProfile(getProfileUserDataPath(), params)
  }),
  defineMethod({
    name: 'orcaProfiles.refreshAuth',
    permission: 'workspace',
    params: null,
    handler: () => refreshCurrentOrcaProfileAuth(getProfileUserDataPath())
  }),
  defineMethod({
    name: 'orcaProfiles.signOutCurrent',
    permission: 'workspace',
    params: null,
    handler: () => signOutCurrentOrcaProfile(getProfileUserDataPath())
  }),
  defineMethod({
    name: 'orcaProfiles.selectOrg',
    permission: 'workspace',
    params: OrcaProfileSelectOrgParams,
    handler: (params) => selectCurrentOrcaProfileOrg(getProfileUserDataPath(), params.orgId)
  }),
  defineMethod({
    name: 'orcaProfiles.signInProgress',
    permission: 'workspace',
    params: null,
    handler: () => getOrcaCloudSignInProgress()
  }),
  defineMethod({
    name: 'orcaProfiles.cancelSignIn',
    permission: 'workspace',
    params: null,
    handler: () => {
      cancelOrcaCloudSignIn()
    }
  })
]
