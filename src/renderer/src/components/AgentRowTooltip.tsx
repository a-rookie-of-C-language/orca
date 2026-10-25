import type { ComponentProps, ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function AgentRowTooltip({
  label,
  side = 'top',
  children
}: {
  label?: string | null
  side?: ComponentProps<typeof TooltipContent>['side']
  children: ReactElement
}): React.JSX.Element {
  if (!label) {
    return children
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={4}
        className="max-w-sm whitespace-pre-wrap break-words"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
