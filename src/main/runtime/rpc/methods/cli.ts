import { CliWslInstall } from '../../../../shared/rpc-contract/cli-params'
import {
  getCliInstallStatus,
  getWslCliInstallStatus,
  installCli,
  installWslCli,
  removeCli,
  removeWslCli
} from '../../../cli/cli-registration-service'
import { defineMethod } from '../core'

export const CLI_METHODS = [
  defineMethod({
    name: 'cli.getInstallStatus',
    permission: 'workspace',
    params: null,
    handler: () => getCliInstallStatus()
  }),
  defineMethod({
    name: 'cli.install',
    permission: 'host-admin',
    params: null,
    handler: () => installCli()
  }),
  defineMethod({
    name: 'cli.remove',
    permission: 'host-admin',
    params: null,
    handler: () => removeCli()
  }),
  defineMethod({
    name: 'cli.getWslInstallStatus',
    permission: 'workspace',
    params: CliWslInstall,
    handler: (params) => getWslCliInstallStatus(params)
  }),
  defineMethod({
    name: 'cli.installWsl',
    permission: 'host-admin',
    params: CliWslInstall,
    handler: (params) => installWslCli(params)
  }),
  defineMethod({
    name: 'cli.removeWsl',
    permission: 'host-admin',
    params: CliWslInstall,
    handler: (params) => removeWslCli(params)
  })
]
