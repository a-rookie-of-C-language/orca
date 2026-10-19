import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRightIcon } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { cn } from '@/lib/utils'
import {
  buildRichMarkdownDomContextMenuModel,
  runRichMarkdownDomMenuEditAction,
  type RichMarkdownDomMenuCellType,
  type RichMarkdownDomMenuEntry
} from './rich-markdown-dom-context-menu-model'
import {
  isRichMarkdownContextCommandTarget,
  runRichMarkdownContextCommand
} from './rich-markdown-context-command-routing'

// Why: Radix ContextMenu primitives need a trigger element to anchor on, but
// the menu opens at the raw cursor point inside the ProseMirror DOM. Copy the
// shadcn context-menu class strings onto plain menuitem divs instead, like the
// editor's existing floating menus (slash menu, link bubble), which are also
// manually positioned portals.
const MENU_PANEL_CLASS =
  'z-[70] min-w-[11rem] overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-[4px] text-black dark:text-white shadow-[0_12px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_16px_34px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.04)]'
const MENU_ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-[4px] text-[12px] leading-[17px] font-[450] outline-hidden select-none hover:bg-black/8 dark:hover:bg-white/14 hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"
const MENU_SEPARATOR_CLASS = 'my-[3px] h-px bg-border/60'
const SUBMENU_WIDTH_ESTIMATE = 240

type DomMenuState = {
  x: number
  y: number
  cellType: RichMarkdownDomMenuCellType | null
}

export function RichMarkdownDomContextMenu({
  editor,
  rootRef,
  toggleLink,
  pickImage
}: {
  editor: Editor | null
  rootRef: { readonly current: HTMLElement | null }
  toggleLink: () => void
  pickImage: () => void
}): React.JSX.Element | null {
  const [menu, setMenu] = useState<DomMenuState | null>(null)
  const [openSubmenu, setOpenSubmenu] = useState<{ label: string; flip: boolean } | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!editor) {
      return
    }
    const dom = editor.view.dom
    const onContextMenu = (event: MouseEvent): void => {
      if (!editor.isEditable) {
        return
      }
      // Why: WebView2 shows its own default menu otherwise; Electron never
      // reaches this component because the native menu handles it there.
      event.preventDefault()
      const target = event.target instanceof Element ? event.target.closest('td, th') : null
      const cell = target && dom.contains(target) ? target : null
      setOpenSubmenu(null)
      setPosition(null)
      setMenu({
        x: event.clientX,
        y: event.clientY,
        cellType: cell ? (cell.tagName === 'TH' ? 'header' : 'body') : null
      })
    }
    dom.addEventListener('contextmenu', onContextMenu)
    return () => {
      dom.removeEventListener('contextmenu', onContextMenu)
    }
  }, [editor])

  useEffect(() => {
    if (!menu) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) {
        return
      }
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
      }
    }
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  useLayoutEffect(() => {
    if (!menu || !panelRef.current) {
      return
    }
    // Why: the body portal escapes editor clipping, so clamp the measured
    // panel into the viewport like the link bubble does.
    const rect = panelRef.current.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    })
  }, [menu])

  if (!editor || !menu) {
    return null
  }

  const panelPosition: React.CSSProperties = {
    left: position?.x ?? menu.x,
    top: position?.y ?? menu.y
  }

  const dispatchEntry = (entry: RichMarkdownDomMenuEntry): void => {
    if (entry.kind === 'edit') {
      runRichMarkdownDomMenuEditAction(editor, entry.action)
      setMenu(null)
      return
    }
    if (entry.kind !== 'command') {
      return
    }
    const payload = { command: entry.command, x: menu.x, y: menu.y }
    if (!isRichMarkdownContextCommandTarget(payload, rootRef.current)) {
      setMenu(null)
      return
    }
    runRichMarkdownContextCommand({ payload, editor, toggleLink, pickImage })
    setMenu(null)
  }

  const model = buildRichMarkdownDomContextMenuModel({
    cellType: menu.cellType,
    hasSelection: !editor.state.selection.empty
  })

  const renderEntries = (
    entries: RichMarkdownDomMenuEntry[],
    submenuLabel: string
  ): React.JSX.Element[] =>
    entries.map((entry, index) => {
      const key = `${submenuLabel}:${index}`
      if (entry.kind === 'separator') {
        return <div key={key} role="separator" className={MENU_SEPARATOR_CLASS} />
      }
      if (entry.kind === 'submenu') {
        const open = openSubmenu?.label === `${submenuLabel}>${entry.label}`
        // Why: spread a CSSProperties-typed offset like components/ui/context-menu
        // does so the Electron-only drag-region opt-out compiles the same way.
        const submenuOffset: React.CSSProperties = openSubmenu?.flip
          ? { right: 'calc(100% - 2px)' }
          : { left: 'calc(100% - 2px)' }
        return (
          <div
            key={key}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open}
            data-submenu={entry.label}
            className={cn(MENU_ITEM_CLASS, 'justify-between')}
            onMouseEnter={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setOpenSubmenu({
                label: `${submenuLabel}>${entry.label}`,
                flip: rect.right + SUBMENU_WIDTH_ESTIMATE > window.innerWidth
              })
            }}
            onClick={() => setOpenSubmenu({ label: `${submenuLabel}>${entry.label}`, flip: false })}
          >
            <span>{entry.label}</span>
            <ChevronRightIcon />
            {open && (
              <div
                role="menu"
                aria-label={entry.label}
                className={cn(MENU_PANEL_CLASS, 'absolute top-[-4px]')}
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebkitAppRegion is Electron's drag-region hint and absent from csstype, like the shadcn context-menu primitive this mirrors.
                style={{ ...submenuOffset, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                {renderEntries(entry.items, `${submenuLabel}>${entry.label}`)}
              </div>
            )}
          </div>
        )
      }
      return (
        <div
          key={key}
          role="menuitem"
          data-command={entry.kind === 'command' ? entry.command : undefined}
          data-edit={entry.kind === 'edit' ? entry.action : undefined}
          data-disabled={entry.disabled === true ? 'true' : undefined}
          aria-disabled={entry.disabled === true}
          className={MENU_ITEM_CLASS}
          onMouseEnter={() => setOpenSubmenu(null)}
          onClick={() => {
            if (entry.disabled === true) {
              return
            }
            dispatchEntry(entry)
          }}
        >
          <span>{entry.label}</span>
        </div>
      )
    })

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label="Markdown editing"
      data-testid="rich-markdown-dom-context-menu"
      className={cn(MENU_PANEL_CLASS, 'fixed')}
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebkitAppRegion is Electron's drag-region hint and absent from csstype, like the shadcn context-menu primitive this mirrors.
      style={{ ...panelPosition, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onMouseLeave={() => setOpenSubmenu(null)}
    >
      {renderEntries(model, 'root')}
    </div>,
    document.body
  )
}
