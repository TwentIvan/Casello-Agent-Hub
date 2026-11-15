import { cn } from "@/lib/utils";
import logoLight from "@design/assets/Logo/botcave-logo-light.svg";
import logoDark from "@design/assets/Logo/botcave-logo-dark.svg";
import markLight from "@design/assets/Logo/botcave-mark-light.svg";
import markDark from "@design/assets/Logo/botcave-mark-dark.svg";
import alfredLight from "@design/assets/Alfred/alfred-mark-light.svg";
import alfredDark from "@design/assets/Alfred/alfred-mark-dark.svg";
import luciusLight from "@design/assets/Lucius/lucius-mark-light.svg";
import luciusDark from "@design/assets/Lucius/lucius-mark-dark.svg";
import barbaraLight from "@design/assets/Barbara/barbara-mark-light.svg";
import barbaraDark from "@design/assets/Barbara/barbara-mark-dark.svg";

// Logo e segni di Botcave: si usano solo i file di design/assets, mai ricomposti. Ogni elemento esiste in versione
// chiara e scura; si mostra quella del tema corrente con le classi theme-light-only / theme-dark-only (index.css).

interface ThemedProps {
  light: string;
  dark: string;
  alt: string;
  className?: string;
  height?: number;
}

function Themed({ light, dark, alt, className, height, tone }: ThemedProps & { tone?: "light" | "dark" }) {
  const style = height === undefined ? undefined : { height };
  // tone forza una versione: «light» su fondi chiari qualunque sia il tema (es. il pulsante ambra)
  if (tone) {
    return <img src={tone === "light" ? light : dark} alt={alt} style={style} className={cn("shrink-0", className)} draggable={false} />;
  }
  return (
    <>
      <img src={light} alt={alt} style={style} className={cn("theme-light-only shrink-0", className)} draggable={false} />
      <img src={dark} alt={alt} style={style} className={cn("theme-dark-only shrink-0", className)} draggable={false} />
    </>
  );
}

/** Logo orizzontale «bot cave»: almeno 96 px di larghezza (sotto si usa BotcaveMark). */
export function BotcaveLogo({ className, tone }: { className?: string; tone?: "light" | "dark" }) {
  return <Themed light={logoLight} dark={logoDark} alt="Botcave" tone={tone} className={cn("h-7 w-auto", className)} />;
}

/** Solo il segno (pipistrello nella caverna): per spazi stretti, regge fino a 16 px di altezza. */
export function BotcaveMark({ className }: { className?: string }) {
  return <Themed light={markLight} dark={markDark} alt="Botcave" className={cn("h-5 w-auto", className)} />;
}

/*
 * Alfred, Lucius e Barbara si mostrano con i pixel della stessa grandezza: il papillon ha 5 righe (39 unità), gli
 * occhiali 4 (31 unità), la chiave 3 (23 unità). Le altezze sono quindi in proporzione 39 : 31 : 23; `size` è l'altezza
 * del papillon in px.
 */
const LUCIUS_RATIO = 31 / 39;
const BARBARA_RATIO = 23 / 39;

/** Segno di Alfred (papillon), il maggiordomo: Quartier generale e voce. */
export function AlfredMark({
  size = 15,
  alt = "",
  tone,
  className,
}: {
  size?: number;
  alt?: string;
  tone?: "light" | "dark";
  className?: string;
}) {
  return <Themed light={alfredLight} dark={alfredDark} alt={alt} tone={tone} className={cn("w-auto", className)} height={size} />;
}

/** Segno di Lucius (occhiali), Lucius: Officina, analisi e chat del piano. */
export function LuciusMark({
  size = 15,
  alt = "",
  tone,
  className,
}: {
  size?: number;
  alt?: string;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <Themed
      light={luciusLight}
      dark={luciusDark}
      alt={alt}
      tone={tone}
      className={cn("w-auto", className)}
      height={size * LUCIUS_RATIO}
    />
  );
}

/** Segno di Barbara (chiave), la Responsabile di Botcave: chat dalla caverna e dal pannello. */
export function BarbaraMark({
  size = 15,
  alt = "",
  tone,
  className,
}: {
  size?: number;
  alt?: string;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <Themed
      light={barbaraLight}
      dark={barbaraDark}
      alt={alt}
      tone={tone}
      className={cn("w-auto", className)}
      height={size * BARBARA_RATIO}
    />
  );
}
