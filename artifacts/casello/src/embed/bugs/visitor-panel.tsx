// Pannello del visitatore non collegato a Botcave: «Segnala un problema», «Le mie segnalazioni» e, in fondo, il
// collegamento per l'amministratore. Niente link alla console né costi.
import { useCallback } from "react";
import { BotcaveMark } from "@/components/brand/marks";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import type { HostState } from "../use-host";
import { useVisitorBadge, usePanelOpen } from "../use-badge";
import { BugForm } from "./bug-form";
import { MyReports } from "./my-reports";

/** Pannello del visitatore senza collegamento a Botcave: modulo, «Le mie segnalazioni» e il collegamento dell'amministratore. */
export function VisitorPanel({
  host,
  connectError,
  onConnect,
}: {
  host: HostState;
  connectError: string | null;
  onConnect: () => void;
}) {
  const open = usePanelOpen(host.openRequest);
  useVisitorBadge(open, host.post);
  const { post } = host;
  const close = useCallback(() => post({ botcave: 1, type: "close" }), [post]);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-surface-1 text-ink">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <BotcaveMark className="h-5" />
        <h1 className="min-w-0 flex-1 truncate text-label">Segnala un problema</h1>
        <Button variant="ghost" size="sm" onClick={close}>
          Chiudi
        </Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        <div className="min-w-0 space-y-6 p-3">
          <BugForm />
          <MyReports />
        </div>
        <footer className="mt-auto min-w-0 space-y-1 border-t border-border px-3 py-2">
          <Button variant="link" size="sm" className="h-auto px-0 text-ink-muted" onClick={onConnect}>
            Sei l'amministratore? Collega con Botcave
          </Button>
          {connectError && <Led state="ko" label={connectError} />}
        </footer>
      </div>
    </div>
  );
}
