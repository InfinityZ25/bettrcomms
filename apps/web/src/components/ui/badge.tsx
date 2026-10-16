import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-semibold whitespace-nowrap tabular-nums transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground [a]:hover:bg-[color-mix(in_oklch,var(--primary)_92%,white)]",
        secondary:
          "border-border bg-secondary text-secondary-foreground [a]:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_7%)]",
        // Light mode deepens the red so 12px text keeps 4.5:1 on its tint.
        destructive:
          "bg-destructive/10 text-[color-mix(in_oklch,var(--destructive)_85%,black)] focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:text-destructive dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/16",
        outline:
          "border-border text-foreground [a]:hover:bg-foreground/5",
        ghost: "hover:bg-foreground/7 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
