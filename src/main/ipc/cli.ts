import { ipcMain } from 'electron'
import { createCliRegistrationService } from '../cli/cli-registration-service'

export function registerCliHandlers(): void {
  const service = createCliRegistrationService()
  ipcMain.handle('cli:getInstallStatus', service.getCliInstallStatus)
  ipcMain.handle('cli:install', service.installCli)
  ipcMain.handle('cli:remove', service.removeCli)
  ipcMain.handle('cli:getWslInstallStatus', (_event, args?: { distro?: string | null }) =>
    service.getWslCliInstallStatus(args)
  )
  ipcMain.handle('cli:installWsl', (_event, args?: { distro?: string | null }) =>
    service.installWslCli(args)
  )
  ipcMain.handle('cli:removeWsl', (_event, args?: { distro?: string | null }) =>
    service.removeWslCli(args)
  )
}
