// Collegamento a una pagina della console dal pannello: nella console naviga con wouter (il pannello si chiude al
// cambio di pagina), nell'iframe dell'app ospite apre Botcave in una nuova scheda.
import type { ReactNode } from "react";
import { Link } from "wouter";
import { consoleUrl } from "@/embed/panel-helpers";
import { usePanel } from "./panel-context";

export function PanelLink({ path, className, children }: { path: string; className?: string; children: ReactNode }) {
  const { env } = usePanel();
  if (env.surface === "console") {
    return (
      <Link href={path} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={consoleUrl(window.location.origin, path)} target="_blank" rel="noopener" className={className}>
      {children}
    </a>
  );
}
