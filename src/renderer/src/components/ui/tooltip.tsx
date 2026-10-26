import * as React from 'react'
import * as TooltipPrimitive from 'radix-ui/tooltip'

import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

function TooltipProvider({
  delayDuration = 0,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  // Labels must not stay open through pointer hover and block the controls they describe.
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

const FLOATING_SURFACE_CLASSES =
  'border border-black/14 bg-[rgba(255,255,255,0.82)] text-black shadow-[0_12px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:text-white dark:shadow-[0_16px_34px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.04)]'

const TAB_PREVIEW_CLASSES = cn(
  'w-64 max-w-[calc(100vw-1rem)] p-3 motion-safe:animate-in motion-safe:fade-in-0 data-[state=closed]:animate-none',
  FLOATING_SURFACE_CLASSES
)

const tooltipContentVariants = cva('z-[90] rounded-md text-xs', {
  variants: {
    variant: {
      default: `pointer-events-none w-fit origin-(--radix-tooltip-content-transform-origin) animate-in px-3 py-1.5 text-balance shadow-[0_12px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 ${FLOATING_SURFACE_CLASSES}`,
      surface: `w-fit max-w-[calc(100vw-1rem)] px-3 py-1.5 motion-safe:animate-in motion-safe:fade-in-0 data-[state=closed]:animate-none ${FLOATING_SURFACE_CLASSES}`,
      'tab-preview': ['pointer-events-none', TAB_PREVIEW_CLASSES],
      // Why: a preview with its own controls takes the pointer; pair it with hoverable content.
      'tab-preview-interactive': TAB_PREVIEW_CLASSES
    }
  },
  defaultVariants: { variant: 'default' }
})

function TooltipContent({
  className,
  sideOffset = 0,
  showArrow = true,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> &
  VariantProps<typeof tooltipContentVariants> & { showArrow?: boolean; onPlaced?: () => void }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // Tooltip portals must layer above the menus/popovers that trigger them.
        className={cn(tooltipContentVariants({ variant }), className)}
        {...props}
      >
        {children}
        {showArrow ? (
          <TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] border border-black/14 bg-[rgba(255,255,255,0.82)] fill-[rgba(255,255,255,0.82)] dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:fill-[rgba(0,0,0,0.72)]" />
        ) : null}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
