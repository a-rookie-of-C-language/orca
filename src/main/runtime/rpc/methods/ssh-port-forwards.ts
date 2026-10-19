import type { PortForwardEntry } from '../../../../shared/ssh-types'
import {
  SshPortForwardAdd,
  SshPortForwardList,
  SshPortForwardRemove,
  SshPortForwardUpdate
} from '../../../../shared/rpc-contract/ssh-params'
import { persistSshPortForwards } from '../../../ssh/ssh-port-forward-persistence'
import {
  getSshConnectionManager,
  getSshPortForwardManager,
  getSshTargetRegistryStore
} from '../../../ssh/ssh-target-registry'
import { defineMethod } from '../core'

function notifySshPortForwardsChanged(
  targetId: string,
  runtime: {
    notifySshPortForwardsChanged: (targetId: string, forwards: PortForwardEntry[]) => void
  }
): void {
  const manager = getSshPortForwardManager()
  if (!manager) {
    return
  }
  runtime.notifySshPortForwardsChanged(targetId, manager.listForwards(targetId))
}

function getPortForwardPersistence() {
  const store = getSshTargetRegistryStore()
  const connectionManager = getSshConnectionManager()
  const portForwardManager = getSshPortForwardManager()
  if (!store || !connectionManager || !portForwardManager) {
    return null
  }
  return { store, connectionManager, portForwardManager }
}

export const SSH_PORT_FORWARD_METHODS = [
  defineMethod({
    name: 'ssh.addPortForward',
    permission: 'host-admin',
    params: SshPortForwardAdd,
    handler: async (params, { runtime }) => {
      const manager = getSshPortForwardManager()
      const connection = getSshConnectionManager()?.getConnection(params.targetId)
      if (!manager || !connection) {
        throw new Error(`SSH connection "${params.targetId}" not found`)
      }
      const entry = await manager.addForward(
        params.targetId,
        connection,
        params.localPort,
        params.remoteHost,
        params.remotePort,
        params.label
      )
      const persistence = getPortForwardPersistence()
      if (persistence) {
        persistSshPortForwards(persistence, params.targetId)
      }
      notifySshPortForwardsChanged(params.targetId, runtime)
      return entry
    }
  }),
  defineMethod({
    name: 'ssh.updatePortForward',
    permission: 'host-admin',
    params: SshPortForwardUpdate,
    handler: async (params, { runtime }) => {
      const manager = getSshPortForwardManager()
      const connection = getSshConnectionManager()?.getConnection(params.targetId)
      if (!manager || !connection) {
        throw new Error(`SSH connection "${params.targetId}" not found`)
      }
      try {
        const entry = await manager.updateForward(
          params.id,
          connection,
          params.localPort,
          params.remoteHost,
          params.remotePort,
          params.label
        )
        const persistence = getPortForwardPersistence()
        if (persistence) {
          persistSshPortForwards(persistence, entry.connectionId)
        }
        notifySshPortForwardsChanged(entry.connectionId, runtime)
        return entry
      } catch (error) {
        const persistence = getPortForwardPersistence()
        if (persistence) {
          persistSshPortForwards(persistence, params.targetId)
        }
        notifySshPortForwardsChanged(params.targetId, runtime)
        throw error
      }
    }
  }),
  defineMethod({
    name: 'ssh.removePortForward',
    permission: 'host-admin',
    params: SshPortForwardRemove,
    handler: async (params, { runtime }) => {
      const removed = (await getSshPortForwardManager()?.removeForwardAndWait(params.id)) ?? null
      if (removed) {
        const persistence = getPortForwardPersistence()
        if (persistence) {
          persistSshPortForwards(persistence, removed.connectionId)
        }
        notifySshPortForwardsChanged(removed.connectionId, runtime)
      }
      return removed
    }
  }),
  defineMethod({
    name: 'ssh.listPortForwards',
    permission: 'workspace',
    params: SshPortForwardList,
    handler: (params) => getSshPortForwardManager()?.listForwards(params.targetId) ?? []
  })
]
