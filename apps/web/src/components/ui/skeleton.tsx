import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bc-shimmer animate-bc-shimmer rounded-xl bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
