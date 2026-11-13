import { WandSparkles } from "lucide-react";
import { AlfredMark, LuciusMark } from "@/components/brand/marks";
import { cn } from "@/lib/utils";
import type { Character } from "./adapters";

/** Segno del personaggio nella chat: Alfred e Lucius dai file di `design/`, il Responsabile con l'icona AI. */
export function CharacterMark({ character, size = 15, className }: { character: Character; size?: number; className?: string }) {
  if (character === "alfred") return <AlfredMark size={size} className={className} />;
  if (character === "lucius") return <LuciusMark size={size} className={className} />;
  return <WandSparkles aria-hidden="true" style={{ width: size, height: size }} className={cn("shrink-0 text-ink", className)} />;
}
