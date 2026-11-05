import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Etichetta neutra di Botcave: piccola, raggio radius-sm, senza fondi colorati (gli stati si mostrano con i LED,
// l'ambra resta per ciò che chiede attenzione: il primario è quindi riservato ai contatori).
const badgeVariants = cva(
  "whitespace-nowrap inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
  {
    variants: {
      variant: {
        default: "border-transparent bg-brand text-on-brand",
        secondary: "border-transparent bg-surface-2 text-ink",
        destructive: "border-border text-danger",
        outline: "border-border text-ink",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
