import { memo, useId, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionChoiceShortLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from './native-chat-session-option-labels'

/** Effort tiers that earn the glow treatment: the top end of each agent's ceiling. */
const GLOW_VALUES = new Set(['ultra', 'max', 'xhigh'])

export type NativeChatEffortPickerProps = {
  /** Null while a snapshot lacks effort; an open picker keeps its last levels, frozen. */
  descriptor: SessionOptionDescriptor | null
  isWorking: boolean
  busy: boolean
  onSet: (value: SessionOptionValue) => void
  /** A slash command asking for this picker; opens the popover once per request. */
  request?: NativeChatOptionPickerRequest | null
}

function LevelSegment(props: {
  optionId: string
  choice: SessionOptionSelectChoice
  glow: boolean
  selected: boolean
}): React.JSX.Element {
  const { optionId, choice, glow, selected } = props
  const detailId = useId()
  const label = nativeChatSessionChoiceLabel(choice, optionId)
  const shortLabel = nativeChatSessionChoiceShortLabel(choice, optionId)
  // What the segment's text leaves out: the full name behind an abbreviation, and the description.
  const detail = [label === shortLabel ? null : label, choice.description].filter(Boolean).join(' ')
  const item = (
    <ToggleGroupItem
      value={choice.value}
      aria-describedby={detail ? detailId : undefined}
      className={cn(
        'flex-1',
        selected && glow && 'shadow-[0_0_10px_-1px_oklch(0.65_0.22_300/60%)]'
      )}
    >
      {shortLabel}
    </ToggleGroupItem>
  )
  if (!detail) {
    return item
  }
  return (
    <Tooltip>
      {/* Wrap the tooltip trigger so its data-state cannot replace the segment's on/off state. */}
      <TooltipTrigger asChild>
        <span className="inline-flex flex-1">
          {item}
          <span id={detailId} className="sr-only">
            {detail}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <div>{label}</div>
        {choice.description ? <div>{choice.description}</div> : null}
      </TooltipContent>
    </Tooltip>
  )
}

/** The inline pill: model-adjacent, shows the current level's short name; glows
 *  when the level is a top-tier effort so the composer advertises peak mode. */
function NativeChatEffortPickerInner({
  descriptor,
  isWorking,
  busy,
  onSet,
  request
}: NativeChatEffortPickerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [seenRequest, setSeenRequest] = useState<NativeChatOptionPickerRequest | null>(null)
  if (request && request !== seenRequest) {
    setSeenRequest(request)
    setOpen(true)
  }
  const titleId = useId()
  // Hold the descriptor across a snapshot that drops effort while this picker is
  // mounted: its levels freeze disabled instead of the pill vanishing mid-visit.
  const last = useRef<SessionOptionDescriptor | null>(null)
  if (descriptor) {
    last.current = descriptor
  }
  const gone = descriptor === null
  const shown = descriptor ?? (open ? last.current : null)
  if (!shown || shown.kind.type !== 'select' || shown.kind.choices.length === 0) {
    return null
  }
  const descriptorShown = shown
  const kind = descriptorShown.kind
  if (kind.type !== 'select') {
    return null
  }
  const choices = kind.choices
  const current = gone ? undefined : kind.currentValue
  const disabled = gone || isWorking || !descriptorShown.settable
  // Busy gates writes but not the pill: a queued pick must not lock the picker shut.
  const writeDisabled = disabled || busy
  const disabledReason = nativeChatSessionOptionDisabledReason(descriptorShown.disabledReason)
  const currentChoice = choices.find((choice) => choice.value === current)
  const currentLabel = currentChoice
    ? nativeChatSessionChoiceShortLabel(currentChoice, descriptorShown.id)
    : '—'
  const glow = current !== undefined && GLOW_VALUES.has(current)
  const title = nativeChatSessionOptionLabel(descriptorShown)
  const currentIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === current)
  )

  const pick = (value: string): void => {
    if (!writeDisabled && value !== '' && value !== current) {
      onSet(value)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild disabled={disabled}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`${title} ${currentLabel}`}
              aria-busy={busy}
              className={cn(
                'max-w-40 gap-1',
                glow &&
                  'bg-[linear-gradient(115deg,oklch(0.28_0.12_290),oklch(0.35_0.18_310)_55%,oklch(0.30_0.14_280))] text-[oklch(0.92_0.05_300)] shadow-[0_0_12px_-2px_oklch(0.65_0.22_300/70%),inset_0_1px_0_oklch(1_0_0/15%)] hover:bg-[linear-gradient(115deg,oklch(0.33_0.14_290),oklch(0.40_0.20_310)_55%,oklch(0.35_0.16_280))]'
              )}
            >
              {glow ? <Sparkles className="size-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">{title}</span>
              <span className={cn('shrink-0 font-medium', !glow && 'text-chat-foreground')}>
                {currentLabel}
              </span>
              <ChevronDown className="size-3" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {disabledReason ?? title}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        side="top"
        collisionPadding={8}
        className="w-80 max-w-(--radix-popover-content-available-width) p-3"
      >
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <span id={titleId} className="text-xs font-medium text-muted-foreground">
              {title}
            </span>
            {currentChoice ? (
              <span
                className={cn(
                  'text-xs font-medium',
                  glow &&
                    'bg-[linear-gradient(90deg,oklch(0.75_0.2_300),oklch(0.85_0.16_320))] bg-clip-text text-transparent'
                )}
              >
                {nativeChatSessionChoiceLabel(currentChoice, descriptorShown.id)}
              </span>
            ) : null}
          </div>

          {/* Segmented strip: one segment per level, like the model picker's rows. */}
          <NativeChatSessionOptionWriteGroup busy={busy} className="flex flex-col gap-3">
            <ToggleGroup
              type="single"
              variant="segmented"
              size="xs"
              spacing={0.5}
              role="radiogroup"
              aria-labelledby={titleId}
              value={current ?? ''}
              disabled={writeDisabled}
              // Radix reports a press on the level in use as ''; the guard in pick drops it.
              onValueChange={pick}
              className="flex w-full"
            >
              {choices.map((choice) => (
                <LevelSegment
                  key={choice.value}
                  optionId={descriptorShown.id}
                  choice={choice}
                  glow={GLOW_VALUES.has(choice.value)}
                  selected={choice.value === current}
                />
              ))}
            </ToggleGroup>

            {/* Glow slider: same discrete levels as a stepped range — dragging the
             *  knob lands on the nearest level, and the filled track carries the
             *  sparkle gradient once the value reaches a top tier. */}
            <div className="space-y-1.5">
              <Slider
                min={0}
                max={choices.length - 1}
                step={1}
                value={[currentIndex]}
                disabled={writeDisabled}
                aria-labelledby={titleId}
                onValueChange={([index]) => {
                  const choice = choices[index]
                  if (choice) {
                    pick(choice.value)
                  }
                }}
                className={cn(
                  '[&_[data-slot=slider-range]]:transition-colors',
                  glow &&
                    '[&_[data-slot=slider-track]]:bg-[oklch(0.25_0.08_290/40%)] [&_[data-slot=slider-range]]:bg-[linear-gradient(90deg,oklch(0.55_0.2_280),oklch(0.65_0.24_300),oklch(0.7_0.2_320))] [&_[data-slot=slider-range]]:shadow-[0_0_8px_0_oklch(0.65_0.22_300/80%)]',
                  '[&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:transition-shadow',
                  glow &&
                    '[&_[data-slot=slider-thumb]]:shadow-[0_0_10px_1px_oklch(0.7_0.2_310/90%)] [&_[data-slot=slider-thumb]]:border-[oklch(0.85_0.12_310)]'
                )}
              />
              <div className="flex justify-between px-0.5">
                {choices.map((choice, index) => (
                  <button
                    key={choice.value}
                    type="button"
                    disabled={writeDisabled}
                    onClick={() => pick(choice.value)}
                    className={cn(
                      'size-1.5 rounded-full transition-colors',
                      index <= currentIndex
                        ? glow
                          ? 'bg-[oklch(0.7_0.2_305)] shadow-[0_0_4px_0_oklch(0.7_0.22_305/80%)]'
                          : 'bg-primary'
                        : 'bg-muted-foreground/30'
                    )}
                    aria-label={nativeChatSessionChoiceLabel(choice, descriptorShown.id)}
                  />
                ))}
              </div>
            </div>
          </NativeChatSessionOptionWriteGroup>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const NativeChatEffortPicker = memo(NativeChatEffortPickerInner)
