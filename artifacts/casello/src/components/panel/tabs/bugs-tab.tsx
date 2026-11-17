// Scheda «Segnalazioni» del pannello incorporato (amministratore collegato): il modulo «Segnala un problema» con l'API del
// visitatore e le segnalazioni dell'App della pagina ospite, ciascuna con il collegamento alla console (nuova scheda).
import { getListAppBugsQueryKey, getListAppsQueryKey, useListAppBugs, useListApps } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { BUG_STATUS_LABELS, bugStatusLed } from "@/lib/bug-status";
import { formatRelative } from "@/lib/format";
import { BugForm } from "@/embed/bugs/bug-form";
import { useVisitorBugs } from "@/embed/bugs/visitor-bugs";
import { findAppBySlug } from "@/embed/panel-helpers";
import { usePanel } from "../panel-context";
import { PanelLink } from "../panel-link";

const LINK = "text-caption text-accent-text underline underline-offset-2";

function AppBugList({ appId }: { appId: number }) {
  const bugs = useListAppBugs(appId, undefined, { query: { queryKey: getListAppBugsQueryKey(appId), refetchInterval: 30_000 } });
  if (bugs.isError && !bugs.data) {
    return <p className="text-body-sm text-danger">Impossibile caricare le segnalazioni: {apiErrorMessage(bugs.error)}</p>;
  }
  if (!bugs.data) return <Skeleton className="h-12 w-full" />;
  if (bugs.data.length === 0) return <Led state="idle" label="Nessuna segnalazione per questa app" />;
  return (
    <ul className="space-y-2">
      {bugs.data.map((b) => (
        <li key={b.id} className="min-w-0 rounded-sm border border-border p-2">
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-caption text-ink-muted">n. {b.number}</span>
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{b.title}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-3">
            <Led state={bugStatusLed(b.status)} label={BUG_STATUS_LABELS[b.status]} />
            <span className="min-w-0 truncate text-caption text-ink-muted">
              {b.reporterLabel} · {formatRelative(b.createdAt)}
            </span>
          </p>
          <PanelLink path={`/apps/${appId}/bugs/${b.number}`} className={`mt-1 inline-block ${LINK}`}>
            Apri in Botcave
          </PanelLink>
        </li>
      ))}
    </ul>
  );
}

function AppBugs() {
  const { env } = usePanel();
  const appSlug = env.surface === "embed" ? env.appSlug : "";
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey() } });
  if (apps.isError) {
    return <p className="text-body-sm text-danger">Impossibile caricare le app: {apiErrorMessage(apps.error)}</p>;
  }
  if (!apps.data) return <Skeleton className="h-12 w-full" />;
  const app = findAppBySlug(apps.data, appSlug);
  if (!app) return <Led state="idle" label="Questa app non è ancora registrata in Botcave" />;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-label text-ink-muted">Segnalazioni dell'app</h2>
        <PanelLink path={`/apps/${app.id}`} className={LINK}>
          Impostazioni in Botcave
        </PanelLink>
      </div>
      <AppBugList appId={app.id} />
    </div>
  );
}

export function BugsTab() {
  const { enabled } = useVisitorBugs();
  return (
    <div className="min-w-0 space-y-6 p-3">
      {enabled ? (
        <BugForm />
      ) : (
        <Led state="idle" label="Segnalazioni non attive per questa app" />
      )}
      <AppBugs />
    </div>
  );
}
