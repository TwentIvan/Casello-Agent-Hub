import type { TriggerTestResult } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Esito di «Prova»: elementi riconosciuti con chiave, «Nuovo» / «Già visto» e anteprima, più gli errori di configurazione. */
export function TriggerTestTable({ result }: { result: TriggerTestResult }) {
  return (
    <div className="space-y-2" aria-live="polite">
      {result.errors.length > 0 && (
        <ul className="space-y-1 text-sm text-danger">
          {result.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-muted">
        <span className="font-mono tabular-nums">{result.total}</span> elementi letti,{" "}
        <span className="font-mono tabular-nums">{result.newCount}</span> nuovi.
        {result.total > result.items.length && ` Qui i primi ${result.items.length}.`}
      </p>
      {result.items.length > 0 && (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Chiave</TableHead>
              <TableHead className="w-24">Stato</TableHead>
              <TableHead>Anteprima</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.map((item, index) => (
              <TableRow key={`${item.key}-${index}`}>
                <TableCell className="break-all align-top font-mono text-xs">{item.key}</TableCell>
                <TableCell className="align-top text-sm">{item.isNew ? "Nuovo" : "Già visto"}</TableCell>
                <TableCell className="whitespace-normal break-all align-top font-mono text-xs text-ink-muted">
                  {item.preview}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
