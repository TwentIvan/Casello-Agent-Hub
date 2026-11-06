import type { TaskPackage } from "./client";

export const TASK_FILE = "casello-compito.md";
export const OUTCOME_FILE = "casello-esito.json";
export const ATTACHMENTS_DIR = "casello-allegati";

const STATUS_LABEL: Record<string, string> = {
  planned: "pianificato",
  running: "in corso",
  waiting_node: "in attesa del nodo",
  done: "fatto",
  blocked: "bloccato",
  failed: "fallito",
};

function list(items: string[], empty: string): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`;
}

/** Contenuto di `casello-compito.md`: le istruzioni per l'operaio (Claude Code) che esegue il compito. */
export function renderTaskFile(pkg: TaskPackage): string {
  const p = pkg.plan;
  const tasks = p.tasks.map((t) => {
    const mark = t.id === pkg.task.planTaskId ? " ← questo compito" : "";
    const outcome = t.outcome ? ` — esito: ${t.outcome}` : "";
    return `${t.id} [${STATUS_LABEL[t.status] ?? t.status}] (${t.roleKey}) ${t.title}${outcome}${mark}`;
  });
  const manual = p.manualActions.map((m) => `${m.id} [${m.done ? "fatto" : "da fare"}] ${m.text}`);
  const caselloSkills = pkg.caselloSkills.map((s) => {
    const version = s.version === null ? "specializzata" : `v${s.version}`;
    return `### ${s.code} (${version})\n\n${s.content}`;
  });
  const attachments = pkg.attachments.map((a) => `${ATTACHMENTS_DIR}/${a.name} (${a.sizeBytes} byte)`);

  return `# Compito di Botcave: ${pkg.task.title}

Sei il ruolo **${pkg.role.name}** della squadra **${pkg.team.name}**, che lavora su ${pkg.team.refTitle}.
Lavori in questa cartella. Leggi tutto il file prima di iniziare.

## Come procedere

1. Leggi il PLAN della squadra e le istruzioni del compito qui sotto.
2. Prima di proseguire verifica che le azioni manuali segnate come «fatto» lo siano davvero (es. il branch esiste, il
   file c'è). Se una non lo è, fermati e riferisci \`blocked\` spiegando cosa manca.
3. Usa le skill elencate sotto: quelle di Botcave sono riportate per intero, quelle del nodo sono già installate.
4. Alla fine scrivi in questa cartella il file \`${OUTCOME_FILE}\` con questo formato:

\`\`\`json
{ "status": "done", "outcome": "esito in una riga (max 300 caratteri)", "detail": "dettaglio (max 20 000 caratteri)" }
\`\`\`

\`status\` è \`done\` (compito eseguito), \`blocked\` (serve qualcosa che non dipende da te) o \`failed\` (errore).

## Il tuo ruolo

${pkg.role.task}

## Istruzioni del compito (${pkg.task.planTaskId})

${pkg.task.instructions}

## PLAN della squadra

**Obiettivo:** ${p.objective}

**Vincoli:**
${list(p.constraints, "nessuno")}

**Compiti:**
${list(tasks, "nessuno")}

**Azioni manuali:**
${list(manual, "nessuna")}

**Punti aperti:**
${list(p.openPoints, "nessuno")}

## Skill del nodo da usare

${list(pkg.nodeSkills, "nessuna")}

## Skill di Botcave

${caselloSkills.length ? caselloSkills.join("\n\n") : "Nessuna."}

## Allegati

${list(attachments, "nessuno")}
`;
}
