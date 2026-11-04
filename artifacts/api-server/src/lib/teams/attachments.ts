import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, teamAttachmentsTable, teamInstancesTable, teamTasksTable, type TeamAttachment } from "@workspace/db";
import { TEAM_MESSAGES } from "./rules";

// Allegati delle squadre (solo in ingresso, nel DB come bytea) e spazio di lavoro della squadra sul nodo.
// Un allegato eliminato (`deleted_at`) sparisce dall'elenco e non conta nel limite, ma resta scaricabile da un
// compito del nodo che lo cita già.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TEAM_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_NAME = 200;
const ACTIVE_TASK_STATUSES: ("queued" | "waiting_node" | "running")[] = ["queued", "waiting_node", "running"];
const MAX_WORKSPACE = 300;

export const ATTACHMENT_MESSAGES = {
  invalid: "allegato non valido",
  tooLarge: "allegato troppo grande",
  quota: "spazio allegati della squadra esaurito",
  notFound: "allegato non trovato",
  instanceNotFound: "squadra non trovata",
  workspaceInvalid: "spazio di lavoro non valido",
  missing: (id: number) => `allegato ${id} inesistente`,
} as const;

export class AttachmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export type AttachmentView = { id: number; name: string; contentType: string; sizeBytes: number; sha256: string; createdAt: Date };

const toView = (row: Omit<TeamAttachment, "content">): AttachmentView => ({
  id: row.id,
  name: row.name,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  createdAt: row.createdAt,
});

/** Nome del file: senza separatori di percorso, `..` né caratteri di controllo, 1..200 caratteri. */
function validName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= MAX_NAME && !/[/\\\u0000-\u001f]/.test(name) && !name.includes("..") && name.trim() !== "";
}

/** Tipo di contenuto della forma `tipo/sottotipo` (parametri tolti), altrimenti `application/octet-stream`. */
function normalizeContentType(value: string): string {
  const base = value.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,100}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/.test(base) ? base : "application/octet-stream";
}

/**
 * Salva un allegato (max 10 MB, 50 MB di allegati non eliminati per squadra). Controllo e inserimento stanno nella
 * stessa transazione con la riga della squadra bloccata: due caricamenti insieme non superano il limite.
 */
export async function saveAttachment(userId: number, instanceId: number, input: { name: string; contentType: string; bytes: Buffer }): Promise<AttachmentView> {
  if (!validName(input.name) || input.bytes.length === 0) throw new AttachmentError(400, ATTACHMENT_MESSAGES.invalid);
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, ATTACHMENT_MESSAGES.tooLarge);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return db.transaction(async (tx) => {
    const [instance] = await tx
      .select({ status: teamInstancesTable.status })
      .from(teamInstancesTable)
      .where(eq(teamInstancesTable.id, instanceId))
      .for("update")
      .limit(1);
    if (!instance) throw new AttachmentError(404, ATTACHMENT_MESSAGES.instanceNotFound);
    if (instance.status === "closed") throw new AttachmentError(409, TEAM_MESSAGES.teamClosed);
    const [used] = await tx
      .select({ total: sql<string>`coalesce(sum(${teamAttachmentsTable.sizeBytes}), 0)` })
      .from(teamAttachmentsTable)
      .where(and(eq(teamAttachmentsTable.instanceId, instanceId), isNull(teamAttachmentsTable.deletedAt)));
    if (Number(used?.total ?? 0) + input.bytes.length > MAX_TEAM_ATTACHMENT_BYTES) throw new AttachmentError(413, ATTACHMENT_MESSAGES.quota);
    const [row] = await tx
      .insert(teamAttachmentsTable)
      .values({
        instanceId,
        name: input.name,
        contentType: normalizeContentType(input.contentType),
        sizeBytes: input.bytes.length,
        sha256,
        content: input.bytes,
        uploadedBy: userId,
      })
      .returning();
    return toView(row!);
  });
}

const viewSelect = {
  id: teamAttachmentsTable.id,
  instanceId: teamAttachmentsTable.instanceId,
  name: teamAttachmentsTable.name,
  contentType: teamAttachmentsTable.contentType,
  sizeBytes: teamAttachmentsTable.sizeBytes,
  sha256: teamAttachmentsTable.sha256,
  uploadedBy: teamAttachmentsTable.uploadedBy,
  createdAt: teamAttachmentsTable.createdAt,
  deletedAt: teamAttachmentsTable.deletedAt,
};

/** Allegati non eliminati della squadra (senza contenuto), dal più vecchio. */
export async function listAttachments(instanceId: number): Promise<AttachmentView[]> {
  const rows = await db
    .select(viewSelect)
    .from(teamAttachmentsTable)
    .where(and(eq(teamAttachmentsTable.instanceId, instanceId), isNull(teamAttachmentsTable.deletedAt)))
    .orderBy(asc(teamAttachmentsTable.id));
  return rows.map(toView);
}

/** Un allegato non eliminato della squadra, con il contenuto; altrimenti 404. */
export async function getAttachment(instanceId: number, id: number): Promise<TeamAttachment> {
  const [row] = await db
    .select()
    .from(teamAttachmentsTable)
    .where(and(eq(teamAttachmentsTable.id, id), eq(teamAttachmentsTable.instanceId, instanceId), isNull(teamAttachmentsTable.deletedAt)))
    .limit(1);
  if (!row) throw new AttachmentError(404, ATTACHMENT_MESSAGES.notFound);
  return row;
}

/**
 * Elimina l'allegato: se nessun compito `queued`, `waiting_node` o `running` lo cita la riga sparisce, altrimenti si
 * toglie solo dall'elenco (`deleted_at`) e il nodo che lo ha in carico lo scarica comunque; lo spazio lo libera poi
 * `purgeDeletedAttachments`. La riga della squadra è bloccata come in `startTask`, che registra le citazioni.
 */
export async function deleteAttachment(instanceId: number, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: teamInstancesTable.id }).from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).for("update").limit(1);
    const [row] = await tx
      .select({ id: teamAttachmentsTable.id })
      .from(teamAttachmentsTable)
      .where(and(eq(teamAttachmentsTable.id, id), eq(teamAttachmentsTable.instanceId, instanceId), isNull(teamAttachmentsTable.deletedAt)))
      .limit(1);
    if (!row) throw new AttachmentError(404, ATTACHMENT_MESSAGES.notFound);
    const [cited] = await tx
      .select({ id: teamTasksTable.id })
      .from(teamTasksTable)
      .where(and(eq(teamTasksTable.instanceId, instanceId), inArray(teamTasksTable.status, ACTIVE_TASK_STATUSES), sql`${teamTasksTable.attachmentIds} @> jsonb_build_array(${id}::int)`))
      .limit(1);
    if (cited) await tx.update(teamAttachmentsTable).set({ deletedAt: new Date() }).where(eq(teamAttachmentsTable.id, id));
    else await tx.delete(teamAttachmentsTable).where(eq(teamAttachmentsTable.id, id));
  });
}

/** Cancella gli allegati eliminati che nessun compito `queued`, `waiting_node` o `running` cita più; restituisce quanti. */
export async function purgeDeletedAttachments(): Promise<number> {
  const result = await db.execute(sql`
    delete from team_attachments a
    where a.deleted_at is not null
      and not exists (
        select 1 from team_tasks t
        where t.instance_id = a.instance_id
          and t.status in ('queued', 'waiting_node', 'running')
          and t.attachment_ids @> jsonb_build_array(a.id)
      )
    returning a.id`);
  return result.rows.length;
}

/**
 * Percorso del caricamento di un allegato: il corpo è il file grezzo, quindi i parser globali (JSON, form) lo saltano.
 * Senza distinzione tra maiuscole e minuscole: il routing di Express (impostazione predefinita) non la fa, quindi
 * `/api/Team-Instances/…` raggiunge la stessa route e deve saltare gli stessi parser.
 */
export const ATTACHMENT_UPLOAD_PATH = /^\/api\/team-instances\/\d+\/attachments\/?$/i;

/** Valore di `filename*` (RFC 5987): encodeURIComponent più `'()*`. */
export function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Id tra quelli dati che sono allegati non eliminati della squadra. */
export async function existingAttachmentIds(instanceId: number, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: teamAttachmentsTable.id })
    .from(teamAttachmentsTable)
    .where(and(eq(teamAttachmentsTable.instanceId, instanceId), inArray(teamAttachmentsTable.id, ids), isNull(teamAttachmentsTable.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Metadati degli allegati citati da un compito (anche eliminati), dal più vecchio. */
export async function taskAttachmentViews(instanceId: number, ids: number[]): Promise<AttachmentView[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(viewSelect)
    .from(teamAttachmentsTable)
    .where(and(eq(teamAttachmentsTable.instanceId, instanceId), inArray(teamAttachmentsTable.id, ids)))
    .orderBy(asc(teamAttachmentsTable.id));
  return rows.map(toView);
}

/**
 * Spazio di lavoro della squadra sul nodo: percorso relativo alla radice del nodo, max 300 caratteri, solo
 * `[A-Za-z0-9._ -]` e `/`, senza `/` iniziale o finale, né segmenti vuoti, `.` o `..`. Restituisce il messaggio d'errore, o null se valido
 * (anche `null` = non impostato).
 */
export function validateNodeWorkspace(value: string | null): string | null {
  if (value === null) return null;
  const ok = value.length >= 1 && value.length <= MAX_WORKSPACE && /^[A-Za-z0-9._ /-]+$/.test(value) && value.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
  return ok ? null : ATTACHMENT_MESSAGES.workspaceInvalid;
}
