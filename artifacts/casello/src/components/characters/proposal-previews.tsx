import type { ReactNode } from "react";
import {
  getGetAgentQueryKey,
  getGetAppQueryKey,
  getListAppToolsQueryKey,
  useGetAgent,
  useGetApp,
  useListAppTools,
} from "@workspace/api-client-react";
import { Markdown } from "@/components/plan/markdown";
import { SKILL_KIND_LABELS } from "@/components/teams/skill-kind";

// Anteprime delle schede di Lucius: Markdown per prompt e skill, elenco dei ruoli o degli strumenti.

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function Box({ children }: { children: ReactNode }) {
  return <div className="max-h-96 min-w-0 overflow-y-auto rounded-md border p-3">{children}</div>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <p className="min-w-0 break-words text-sm">
      <span className="text-label text-ink-muted">{label}</span> {value}
    </p>
  );
}

function MarkdownBox({ text }: { text: string }) {
  return <Box>{text ? <Markdown>{text}</Markdown> : <p className="text-sm text-ink-muted">Nessun testo.</p>}</Box>;
}

function ToolNames({ appId, toolIds }: { appId: number | null; toolIds: number[] }) {
  const tools = useListAppTools(appId ?? 0, { query: { queryKey: getListAppToolsQueryKey(appId ?? 0), enabled: appId !== null } });
  const names = new Map((tools.data ?? []).map((t) => [t.id, t.name]));
  if (toolIds.length === 0) return <p className="text-sm text-ink-muted">Nessuno strumento.</p>;
  return (
    <ul className="min-w-0 space-y-0.5 font-mono text-xs">
      {toolIds.map((id) => (
        <li key={id} className="break-words">
          {names.get(id) ?? `strumento #${id}`}
        </li>
      ))}
    </ul>
  );
}

function AgentToolNames({ agentId, toolIds }: { agentId: number | null; toolIds: number[] }) {
  const agent = useGetAgent(agentId ?? 0, { query: { queryKey: getGetAgentQueryKey(agentId ?? 0), enabled: agentId !== null } });
  return <ToolNames appId={agent.data?.appId ?? null} toolIds={toolIds} />;
}

function TriggerToolName({ agentId, toolId }: { agentId: number | null; toolId: number | null }) {
  const agent = useGetAgent(agentId ?? 0, { query: { queryKey: getGetAgentQueryKey(agentId ?? 0), enabled: agentId !== null } });
  return (
    <p className="text-sm">
      <span className="text-label text-ink-muted">Tool</span>{" "}
      {toolId !== null ? <ToolNames appId={agent.data?.appId ?? null} toolIds={[toolId]} /> : "—"}
    </p>
  );
}

function ConfigLine({ name, value }: { name: string; value: string }) {
  return (
    <div className="break-all">
      <dt className="inline text-ink-muted">{name}: </dt>
      <dd className="inline">{value}</dd>
    </div>
  );
}

function AppName({ appId }: { appId: number | null }) {
  const app = useGetApp(appId ?? 0, { query: { queryKey: getGetAppQueryKey(appId ?? 0), enabled: appId !== null } });
  return <>{app.data?.name ?? (appId !== null ? `app #${appId}` : "—")}</>;
}

function RoleList({ roles }: { roles: unknown }) {
  const list = Array.isArray(roles) ? roles.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null) : [];
  if (list.length === 0) return <p className="text-sm text-ink-muted">Nessun ruolo.</p>;
  return (
    <ul className="min-w-0 divide-y rounded-md border">
      {list.map((r, i) => {
        const skills = strings(r.skills);
        return (
          <li key={str(r.key) || i} className="min-w-0 space-y-1 p-2 text-sm">
            <p className="break-words font-medium">
              {str(r.name) || str(r.key)}
              <span className="font-mono text-xs text-ink-muted">
                {" "}
                {str(r.key)}
                {r.isLead === true ? " · capo" : ""}
                {r.runsOn === "node" ? " · nodo" : " · cloud"}
              </span>
            </p>
            {str(r.task) && <p className="line-clamp-3 whitespace-pre-wrap break-words text-ink-muted">{str(r.task)}</p>}
            <p className="font-mono text-xs text-ink-muted">
              {ids(r.tools).length} strumenti{skills.length > 0 ? ` · skill: ${skills.join(", ")}` : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export const LUCIUS_KIND_LABELS: Record<string, string> = {
  agent_prompt: "Prompt dell'agente",
  agent_tools: "Strumenti dell'agente",
  skill_content: "Contenuto della skill",
  template_roles: "Ruoli del modello",
  agent_create: "Nuovo agente",
  agent_trigger_create: "Nuovo innesco di sorveglianza",
  skill_create: "Nuova skill",
  template_create: "Nuovo modello di squadra",
};

/** Anteprima del contenuto proposto da Lucius; `subjectId` è l'oggetto della conversazione (agente per gli strumenti). */
export function LuciusPreview({ kind, payload, subjectId }: { kind: string; payload: Record<string, unknown>; subjectId: string | null }) {
  switch (kind) {
    case "agent_prompt":
      return <MarkdownBox text={str(payload.systemPrompt)} />;
    case "agent_tools": {
      const agentId = subjectId !== null && /^[1-9][0-9]{0,9}$/.test(subjectId) ? Number(subjectId) : null;
      return (
        <Box>
          <AgentToolNames agentId={agentId} toolIds={ids(payload.toolIds)} />
        </Box>
      );
    }
    case "skill_content": {
      const hints = strings(payload.toolHints);
      return (
        <div className="space-y-2">
          <MarkdownBox text={str(payload.content)} />
          {hints.length > 0 && <Field label="Strumenti suggeriti" value={hints.join(", ")} />}
        </div>
      );
    }
    case "template_roles":
      return <RoleList roles={payload.roles} />;
    case "agent_create": {
      const appId = typeof payload.appId === "number" ? payload.appId : null;
      return (
        <div className="space-y-2">
          <Field label="Nome" value={str(payload.name)} />
          <Field label="App" value={<AppName appId={appId} />} />
          <MarkdownBox text={str(payload.systemPrompt)} />
          {ids(payload.toolIds).length > 0 && (
            <Box>
              <ToolNames appId={appId} toolIds={ids(payload.toolIds)} />
            </Box>
          )}
        </div>
      );
    }
    case "agent_trigger_create": {
      const agentId = typeof payload.agentId === "number" ? payload.agentId : null;
      const toolId = typeof payload.toolId === "number" ? payload.toolId : null;
      const minutes = typeof payload.intervalSeconds === "number" ? Math.round(payload.intervalSeconds / 60) : 5;
      const filter = typeof payload.filter === "object" && payload.filter !== null ? (payload.filter as Record<string, unknown>) : null;
      const args = typeof payload.args === "object" && payload.args !== null ? JSON.stringify(payload.args) : "";
      return (
        <div className="space-y-2">
          <Field label="Nome" value={str(payload.name)} />
          {str(payload.instructions) && <Field label="Istruzioni" value={str(payload.instructions)} />}
          <Box>
            <TriggerToolName agentId={agentId} toolId={toolId} />
            <dl className="mt-2 space-y-0.5 font-mono text-xs">
              {args && <ConfigLine name="argomenti" value={args} />}
              {str(payload.itemsPath) && <ConfigLine name="elenco" value={str(payload.itemsPath)} />}
              <ConfigLine name="campo id" value={str(payload.idField)} />
              {str(payload.versionField) && <ConfigLine name="campo versione" value={str(payload.versionField)} />}
              {str(payload.cursorParam) && <ConfigLine name="cursore" value={`${str(payload.cursorParam)} ← ${str(payload.cursorField)}`} />}
              {filter && <ConfigLine name="filtro" value={`${str(filter.field)} = ${JSON.stringify(filter.equals)}`} />}
              <ConfigLine name="intervallo" value={`ogni ${minutes} min`} />
            </dl>
          </Box>
          <p className="text-sm text-ink-muted">L'innesco nasce in pausa: provalo e attivalo dalla scheda agente.</p>
        </div>
      );
    }
    case "skill_create":
      return (
        <div className="space-y-2">
          <Field label="Codice" value={<span className="font-mono">{str(payload.code)}</span>} />
          <Field label="Nome" value={str(payload.name)} />
          <Field label="Tipo" value={SKILL_KIND_LABELS[str(payload.kind) as keyof typeof SKILL_KIND_LABELS] ?? str(payload.kind)} />
          {str(payload.description) && <Field label="Descrizione" value={str(payload.description)} />}
          <MarkdownBox text={str(payload.content)} />
        </div>
      );
    case "template_create":
      return (
        <div className="space-y-2">
          <Field label="Nome" value={str(payload.name)} />
          {str(payload.description) && <Field label="Descrizione" value={str(payload.description)} />}
          <RoleList roles={payload.roles} />
        </div>
      );
    default:
      return null;
  }
}
