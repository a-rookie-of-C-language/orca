export const APP_MENU_EDIT_ACTION_EVENT = 'orca-app-menu-edit-action'

export type AppMenuEditAction = 'undo' | 'redo'

export function dispatchAppMenuEditAction(
  action: AppMenuEditAction,
  target: Window = window
): boolean {
  const event = new CustomEvent<AppMenuEditAction>(APP_MENU_EDIT_ACTION_EVENT, {
    detail: action,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}
