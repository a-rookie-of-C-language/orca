// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

afterEach(cleanup)

it.each([undefined, 'default', 'surface', 'tab-preview'] as const)(
  'uses theme-matched surface and arrow tokens for the %s tooltip',
  (variant) => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button>Help</button>
          </TooltipTrigger>
          <TooltipContent variant={variant}>Tooltip label</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    const label = screen.getByRole('tooltip')
    const content = label.closest('[data-slot="tooltip-content"]')
    expect(content?.classList.contains('bg-popover')).toBe(true)
    expect(content?.classList.contains('text-popover-foreground')).toBe(true)
    expect(content?.classList.contains('border-border')).toBe(true)
    expect(content?.classList.contains('bg-foreground')).toBe(false)
    expect(content?.classList.contains('text-background')).toBe(false)
    expect(content?.querySelector('svg')?.classList.contains('fill-popover')).toBe(true)
    expect(content?.querySelector('svg')?.classList.contains('bg-popover')).toBe(true)
  }
)

it('still allows callers to hide the tooltip arrow', () => {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger asChild>
          <button>Help</button>
        </TooltipTrigger>
        <TooltipContent showArrow={false}>Tooltip label</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
  expect(
    screen.getByRole('tooltip').closest('[data-slot="tooltip-content"]')?.querySelector('svg')
  ).toBeNull()
})
