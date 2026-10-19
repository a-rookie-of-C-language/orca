import { useEffect } from 'react'
import { dispatchAppMenuEditAction, type AppMenuEditAction } from '@/lib/app-menu-edit-actions'

export function useAppMenuEditActions(): void {
  useEffect(() => {
    return window.api.ui.onAppMenuEditAction((action: AppMenuEditAction) => {
      if (!dispatchAppMenuEditAction(action)) {
        window.api.ui.performNativeEditAction(action)
      }
    })
  }, [])
}
