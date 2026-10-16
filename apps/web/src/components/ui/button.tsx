import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-4xl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Lime, lit from above; on hover it brightens and casts its own glow.
        default:
          "bg-primary font-semibold text-primary-foreground shadow-[inset_0_1px_0_0_color-mix(in_oklch,white_24%,transparent)] hover:bg-[color-mix(in_oklch,var(--primary)_92%,white)] hover:shadow-[inset_0_1px_0_0_color-mix(in_oklch,white_24%,transparent),0_8px_24px_-10px_color-mix(in_oklch,var(--primary)_70%,transparent)]",
        outline:
          "border-border hover:border-foreground/20 hover:bg-foreground/5 hover:text-foreground aria-expanded:border-foreground/20 aria-expanded:bg-foreground/5 aria-expanded:text-foreground",
        secondary:
          "border-border bg-secondary text-secondary-foreground shadow-[var(--highlight)] hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)] aria-expanded:text-secondary-foreground",
        // An ink wash rather than a surface token: it reads the same on the
        // canvas, the sidebar, the rail and a dialog, in either theme, and a
        // call site's own hover colour still wins in both themes.
        ghost:
          "hover:bg-foreground/7 hover:text-foreground aria-expanded:bg-foreground/7 aria-expanded:text-foreground",
        // Light mode deepens the red so it keeps 4.5:1 on its own tint.
        destructive:
          "bg-destructive/10 text-[color-mix(in_oklch,var(--destructive)_85%,black)] hover:bg-destructive/16 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:text-destructive dark:hover:bg-destructive/25 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
