import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderPrimitive.Root.Props) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control
        // The control keeps a thumb-tall hit area round the slimmer track.
        className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-horizontal:min-h-5 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:min-w-5 data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted shadow-[inset_0_0_0_1px_var(--border)] select-none data-horizontal:h-1.5 data-horizontal:w-full data-vertical:h-full data-vertical:w-1.5"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="rounded-full bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            index={index}
            aria-label={props['aria-label']}
            aria-labelledby={props['aria-labelledby']}
            className="block size-4 shrink-0 rounded-full bg-white shadow-[0_0_0_1px_color-mix(in_oklch,black_10%,transparent),0_1px_3px_color-mix(in_oklch,black_35%,transparent)] ring-ring/30 transition-[box-shadow] duration-150 select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden data-dragging:ring-4 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
