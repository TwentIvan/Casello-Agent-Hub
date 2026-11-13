import { Link } from "wouter";
import type { TeamReadiness } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { roleLed } from "@/lib/team-readiness";

/** Stato di preparazione dei ruoli `node`: per ognuno LED e problemi (errori e avvisi) con il link per sistemarli. */
export function TeamReadinessCard({ readiness }: { readiness: TeamReadiness }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pronta a lavorare</CardTitle>
        <CardDescription>Che cosa manca ai ruoli che lavorano sul tuo Mac prima che possano partire.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {readiness.roles.map((role) => (
          <div key={role.roleKey} className="min-w-0 space-y-1">
            <Led state={roleLed(role)} label={role.roleName} />
            {role.problems.length === 0 ? (
              <p className="pl-5 text-sm text-muted-foreground">Pronto.</p>
            ) : (
              <ul className="space-y-0.5 pl-5 text-sm">
                {role.problems.map((problem) => (
                  <li key={problem.code} className="min-w-0 break-words">
                    <span className={problem.level === "error" ? "text-danger" : "text-ink-muted"}>{problem.message}</span>
                    {problem.link && (
                      <>
                        {" "}
                        <Link href={problem.link} className="text-accent-text underline">
                          Sistema
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
