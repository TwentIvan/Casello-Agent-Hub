import { useState } from "react";
import { type CatalogSkillVersion, getListSkillVersionsQueryKey, useListSkillVersions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { SkillDiff } from "./skill-diff";

function VersionSelect({
  label,
  value,
  versions,
  onChange,
}: {
  label: string;
  value: number;
  versions: CatalogSkillVersion[];
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="w-32" aria-label={`Versione ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.version} value={String(v.version)}>
              Versione {v.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Elenco delle versioni e confronto tra due di esse. */
export function SkillVersionsCard({ code }: { code: string }) {
  const list = useListSkillVersions(code, { query: { queryKey: getListSkillVersionsQueryKey(code) } });
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);

  const versions = [...(list.data ?? [])].sort((x, y) => y.version - x.version);
  const latest = versions[0];
  const verB = b ?? latest?.version ?? 0;
  const verA = a ?? (versions[1] ?? latest)?.version ?? 0;
  const vA = versions.find((v) => v.version === verA);
  const vB = versions.find((v) => v.version === verB);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Versioni</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare le versioni: {apiErrorMessage(list.error)}</p>
        ) : list.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <ul className="divide-y rounded-md border text-sm">
              {versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="font-medium">Versione {v.version}</span>
                  <span className="text-muted-foreground">{formatRelative(v.createdAt)}</span>
                </li>
              ))}
            </ul>
            {versions.length > 1 && vA && vB && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Confronto</h3>
                <div className="flex flex-wrap gap-4">
                  <VersionSelect label="A" value={verA} versions={versions} onChange={setA} />
                  <VersionSelect label="B" value={verB} versions={versions} onChange={setB} />
                </div>
                <SkillDiff
                  labelA={`Versione ${vA.version}`}
                  labelB={`Versione ${vB.version}`}
                  contentA={vA.content}
                  contentB={vB.content}
                />
                {(vA.toolHints.length > 0 || vB.toolHints.length > 0) && (
                  <div className="grid grid-cols-2 gap-4 text-xs text-muted-foreground">
                    <p className="break-words">Strumenti: {vA.toolHints.join(", ") || "nessuno"}</p>
                    <p className="break-words">Strumenti: {vB.toolHints.join(", ") || "nessuno"}</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
