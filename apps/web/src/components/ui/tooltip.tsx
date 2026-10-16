import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          // A raised chip in the popover colour with a hairline edge. The
          // shadow is the soft one, which has no ring of its own, so the
          // arrow's outline below can continue the chip's border unbroken.
          className={cn(
            "relative z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-(--shadow-soft) has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-4xl data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow
            // A rotated square whose centre sits on the chip's border line,
            // outlined on its two outer edges only: the inner half hides the
            // chip's border where they overlap and the outer half carries it
            // on round the point.
            className="z-50 size-2 rotate-45 rounded-[2px] border-border bg-popover fill-popover data-[side=bottom]:top-0 data-[side=bottom]:translate-y-[calc(-50%-0.5px)] data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=inline-end]:top-1/2! data-[side=inline-end]:left-0 data-[side=inline-end]:translate-x-[calc(-50%-0.5px)] data-[side=inline-end]:-translate-y-1/2 data-[side=inline-end]:border-b data-[side=inline-end]:border-l data-[side=inline-start]:top-1/2! data-[side=inline-start]:right-0 data-[side=inline-start]:translate-x-[calc(50%+0.5px)] data-[side=inline-start]:-translate-y-1/2 data-[side=inline-start]:border-t data-[side=inline-start]:border-r data-[side=left]:top-1/2! data-[side=left]:right-0 data-[side=left]:translate-x-[calc(50%+0.5px)] data-[side=left]:-translate-y-1/2 data-[side=left]:border-t data-[side=left]:border-r data-[side=right]:top-1/2! data-[side=right]:left-0 data-[side=right]:translate-x-[calc(-50%-0.5px)] data-[side=right]:-translate-y-1/2 data-[side=right]:border-b data-[side=right]:border-l data-[side=top]:bottom-0 data-[side=top]:translate-y-[calc(50%+0.5px)] data-[side=top]:border-r data-[side=top]:border-b" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
