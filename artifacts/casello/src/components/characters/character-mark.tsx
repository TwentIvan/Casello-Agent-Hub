import { AlfredMark, BarbaraMark, LuciusMark } from "@/components/brand/marks";
import type { Character } from "./adapters";

/** Segno del personaggio nella chat: Alfred, Lucius e Barbara (la Responsabile) dai file di `design/`. */
export function CharacterMark({ character, size = 15, className }: { character: Character; size?: number; className?: string }) {
  if (character === "alfred") return <AlfredMark size={size} className={className} />;
  if (character === "lucius") return <LuciusMark size={size} className={className} />;
  return <BarbaraMark size={size} className={className} />;
}
