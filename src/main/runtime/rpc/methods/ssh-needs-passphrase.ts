import { SshTarget } from '../../../../shared/rpc-contract/ssh-params'
import { isSshCredentialDeclined } from '../../../ssh/ssh-credential-decline'
import { getSshConnectionManager, listRegisteredSshTargets } from '../../../ssh/ssh-target-registry'
import { defineMethod } from '../core'

export const SSH_NEEDS_PASSPHRASE_METHODS = [
  defineMethod({
    name: 'ssh.needsPassphrasePrompt',
    permission: 'workspace',
    params: SshTarget,
    handler: (params) => {
      // Why: mirror the desktop handler — a declined credential always reprompts; otherwise
      // prompt only when the last connect needed a passphrase and nothing live has it cached.
      if (isSshCredentialDeclined(params.targetId)) {
        return { needsPrompt: true }
      }
      const target = listRegisteredSshTargets().find(
        (candidate) => candidate.id === params.targetId
      )
      if (!target?.lastRequiredPassphrase) {
        return { needsPrompt: false }
      }
      const manager = getSshConnectionManager()
      return { needsPrompt: !manager || !manager.hasCachedCredential(target) }
    }
  })
]
