import { useMemo, useState } from "react";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { ArrowLeftRight, ArrowRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MODE_LABELS,
  addLink,
  hasReverse,
  linkProblem,
  makeDouble,
  removeLink,
  reverseLink,
  type LinkDraft,
  type LinkMode,
  type LinkRole,
} from "@/lib/role-links";

// Relazioni tra i ruoli (spec 2026-11-28-botcave-relazioni-ruoli §8): canvas con i ruoli come nodi (capo in alto, gli altri sotto),
// frecce trascinate dal bordo inferiore di un ruolo al bordo superiore di un altro, clic su una freccia per le azioni. Sotto la
// stessa informazione come elenco, usabile da tastiera e unica vista sotto i 640 px. Colori solo dai token.

type RoleNodeData = { name: string; isLead: boolean; onNode: boolean };

function RoleNode({ data }: NodeProps<Node<RoleNodeData>>) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm bg-surface-2 text-ink ${data.isLead ? "border-border-strong" : "border-border"}`}
      style={{ minWidth: 120 }}
    >
      {!data.isLead && <Handle type="target" position={Position.Top} className="!bg-ink-muted !border-0" />}
      <div className="font-medium truncate max-w-[180px]">{data.name || "(senza nome)"}</div>
      <div className="text-label text-ink-muted">{data.isLead ? "capo" : data.onNode ? "sul Mac" : "cloud"}</div>
      {!data.isLead && !data.onNode && <Handle type="source" position={Position.Bottom} className="!bg-brand !border-0" />}
    </div>
  );
}

const nodeTypes = { role: RoleNode };

const COLUMN = 200;
const ROW = 110;

/** Posizioni: il capo in alto al centro, gli altri ruoli sotto su righe da 4. */
function layout(roles: LinkRole[]): Node<RoleNodeData>[] {
  const lead = roles.filter((r) => r.isLead);
  const others = roles.filter((r) => !r.isLead);
  const perRow = Math.min(4, Math.max(1, others.length));
  const width = perRow * COLUMN;
  const nodes: Node<RoleNodeData>[] = lead.map((r) => ({
    id: r.uid,
    type: "role",
    position: { x: width / 2 - COLUMN / 2, y: 0 },
    data: { name: r.name, isLead: true, onNode: r.runsOn === "node" },
    draggable: false,
    connectable: false,
  }));
  others.forEach((r, i) => {
    nodes.push({
      id: r.uid,
      type: "role",
      position: { x: (i % perRow) * COLUMN, y: ROW * (1 + Math.floor(i / perRow)) },
      data: { name: r.name, isLead: false, onNode: r.runsOn === "node" },
    });
  });
  return nodes;
}

const edgeId = (l: Pick<LinkDraft, "from" | "to">) => `${l.from}->${l.to}`;

export function RoleLinksEditor({
  roles,
  links,
  onChange,
  readOnly = false,
}: {
  roles: LinkRole[];
  links: LinkDraft[];
  onChange: (links: LinkDraft[]) => void;
  readOnly?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const nameOf = useMemo(() => new Map(roles.map((r) => [r.uid, r.name || "(senza nome)"])), [roles]);
  const leadUid = roles.find((r) => r.isLead)?.uid;

  const nodes = useMemo(() => layout(roles), [roles]);
  const edges = useMemo<Edge[]>(() => {
    // Stella del capo sullo sfondo, non modificabile
    const star: Edge[] = leadUid
      ? roles
          .filter((r) => !r.isLead)
          .map((r) => ({
            id: `lead-${r.uid}`,
            source: leadUid,
            target: r.uid,
            selectable: false,
            focusable: false,
            style: { stroke: "var(--border)", strokeWidth: 1 },
          }))
      : [];
    const own: Edge[] = links.map((l) => ({
      id: edgeId(l),
      source: l.from,
      target: l.to,
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeId(l) === selected ? "var(--accent)" : "var(--ink-muted)" },
      style: {
        stroke: edgeId(l) === selected ? "var(--accent)" : "var(--ink-muted)",
        strokeWidth: 2,
        strokeDasharray: l.mode === "notes" ? "6 4" : undefined,
      },
    }));
    return [...star, ...own];
  }, [roles, links, leadUid, selected]);

  const current = links.find((l) => edgeId(l) === selected) ?? null;

  const connect = (c: Connection) => {
    if (readOnly || !c.source || !c.target) return;
    const why = linkProblem(roles, c.source, c.target);
    if (why) {
      setProblem(why);
      return;
    }
    const next = addLink(roles, links, { from: c.source, to: c.target, mode: "full" });
    if (!next) {
      setProblem("troppe relazioni");
      return;
    }
    setProblem(null);
    onChange(next);
    setSelected(edgeId({ from: c.source, to: c.target }));
  };

  const others = roles.filter((r) => !r.isLead);
  if (others.length < 2) {
    return <p className="text-sm text-ink-muted">Servono almeno due ruoli oltre al capo per disegnare una relazione.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Una freccia da un ruolo a un altro gli permette di contattarlo durante un compito: consultazione (domanda con risposta subito) e
        messaggio (letto al prossimo compito del collega). Il capo raggiunge già tutti. Tratteggiata = solo messaggi.
      </p>
      <div className="hidden sm:block h-80 w-full rounded-md border border-border bg-surface-1" aria-hidden="true">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onConnect={connect}
          isValidConnection={(c) => !readOnly && !!c.source && !!c.target && linkProblem(roles, c.source, c.target) === null}
          onEdgeClick={(_, edge) => setSelected(edge.id.startsWith("lead-") ? null : edge.id)}
          onPaneClick={() => setSelected(null)}
          nodesConnectable={!readOnly}
          nodesDraggable={!readOnly}
          elementsSelectable={!readOnly}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={16} />
        </ReactFlow>
      </div>
      {problem && <p className="text-sm text-danger">{problem}</p>}
      {current && !readOnly && (
        <LinkActions
          link={current}
          label={`${nameOf.get(current.from)} → ${nameOf.get(current.to)}`}
          roles={roles}
          links={links}
          onChange={(next) => {
            onChange(next);
            setSelected(null);
          }}
        />
      )}
      <LinkList roles={roles} links={links} onChange={onChange} readOnly={readOnly} nameOf={nameOf} />
    </div>
  );
}

function LinkActions({
  link,
  label,
  roles,
  links,
  onChange,
}: {
  link: LinkDraft;
  label: string;
  roles: LinkRole[];
  links: LinkDraft[];
  onChange: (links: LinkDraft[]) => void;
}) {
  const toNode = roles.find((r) => r.uid === link.to)?.runsOn === "node";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
      <span className="text-sm font-medium mr-2">{label}</span>
      <Button size="sm" variant="outline" disabled={linkProblem(roles, link.to, link.from) !== null} onClick={() => onChange(reverseLink(roles, links, link))}>
        <ArrowLeftRight className="h-4 w-4" /> Inverti
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={hasReverse(links, link) || linkProblem(roles, link.to, link.from) !== null}
        onClick={() => onChange(makeDouble(roles, links, link))}
      >
        Rendi doppia
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={toNode}
        title={toNode ? "Verso un ruolo sul Mac si mandano solo messaggi" : undefined}
        onClick={() => onChange(links.map((l) => (l.from === link.from && l.to === link.to ? { ...l, mode: l.mode === "full" ? "notes" : "full" } : l)))}
      >
        {link.mode === "full" ? "Solo messaggi" : "Consultazioni e messaggi"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onChange(removeLink(links, link))}>
        <Trash2 className="h-4 w-4" /> Elimina
      </Button>
    </div>
  );
}

function LinkList({
  roles,
  links,
  onChange,
  readOnly,
  nameOf,
}: {
  roles: LinkRole[];
  links: LinkDraft[];
  onChange: (links: LinkDraft[]) => void;
  readOnly: boolean;
  nameOf: Map<string, string>;
}) {
  const others = roles.filter((r) => !r.isLead);
  const senders = others.filter((r) => r.runsOn !== "node");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<LinkMode>("full");
  const targetOnNode = others.find((r) => r.uid === to)?.runsOn === "node";
  const why = from && to ? linkProblem(roles, from, to) : null;

  const add = () => {
    const next = addLink(roles, links, { from, to, mode });
    if (next) {
      onChange(next);
      setTo("");
    }
  };

  return (
    <div className="space-y-2">
      {links.length === 0 ? (
        <p className="text-sm text-ink-muted">Nessuna relazione: ogni ruolo parla solo con il capo.</p>
      ) : (
        <ul className="space-y-1" aria-label="Relazioni tra i ruoli">
          {links.map((l) => (
            <li key={edgeId(l)} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 break-words">
                {nameOf.get(l.from)} <ArrowRight className="inline h-3.5 w-3.5" aria-label="può contattare" /> {nameOf.get(l.to)}
              </span>
              <span className="text-label text-ink-muted">{MODE_LABELS[l.mode]}</span>
              {!readOnly && (
                <Button size="sm" variant="ghost" onClick={() => onChange(removeLink(links, l))} aria-label={`Togli la relazione ${nameOf.get(l.from)} verso ${nameOf.get(l.to)}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && senders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={from} onValueChange={setFrom}>
            <SelectTrigger className="w-44" aria-label="Ruolo che contatta">
              <SelectValue placeholder="Da" />
            </SelectTrigger>
            <SelectContent>
              {senders.map((r) => (
                <SelectItem key={r.uid} value={r.uid}>
                  {nameOf.get(r.uid)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ArrowRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          <Select value={to} onValueChange={setTo}>
            <SelectTrigger className="w-44" aria-label="Ruolo contattato">
              <SelectValue placeholder="A" />
            </SelectTrigger>
            <SelectContent>
              {others
                .filter((r) => r.uid !== from)
                .map((r) => (
                  <SelectItem key={r.uid} value={r.uid}>
                    {nameOf.get(r.uid)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select value={targetOnNode ? "notes" : mode} onValueChange={(v) => setMode(v as LinkMode)} disabled={targetOnNode}>
            <SelectTrigger className="w-56" aria-label="Modalità">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">{MODE_LABELS.full}</SelectItem>
              <SelectItem value="notes">{MODE_LABELS.notes}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="secondary" onClick={add} disabled={!from || !to || why !== null}>
            Aggiungi relazione
          </Button>
          {why && <span className="text-sm text-danger">{why}</span>}
        </div>
      )}
    </div>
  );
}
