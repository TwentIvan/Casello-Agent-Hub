import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Pulsante di Botcave (design/components/Button): tre livelli.
// - principale (default): fondo accent, testo on-accent; uno per schermata, per l'azione più frequente;
// - secondario (secondary, outline): fondo surface-2, bordo border-strong; destructive è un secondario col testo danger;
// - discreto (ghost, link): testo accent-text, senza fondo.
// Space Grotesk 14/500, raggio radius-sm, anello di focus da 2 px col colore focus.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent font-sans text-sm font-medium leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-brand text-on-brand hover:bg-[color-mix(in_srgb,var(--accent)_88%,var(--ink))]",
        destructive: "bg-surface-2 text-danger border-border-strong hover:bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface-2))]",
        outline: "bg-surface-2 text-ink border-border-strong hover:bg-[color-mix(in_srgb,var(--ink)_5%,var(--surface-2))]",
        secondary: "bg-surface-2 text-ink border-border-strong hover:bg-[color-mix(in_srgb,var(--ink)_5%,var(--surface-2))]",
        ghost: "bg-transparent text-accent-text hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]",
        link: "bg-transparent text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 px-3 py-1 text-xs",
        lg: "min-h-10 px-6 py-2",
        icon: "h-9 w-9",
      },
    },
    // Le icone hanno il colore del testo che accompagnano: un pulsante discreto di sola icona resta in inchiostro
    compoundVariants: [{ variant: "ghost", size: "icon", class: "text-ink" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
