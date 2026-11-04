import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, teamAttachmentsTable, teamInstancesTable, teamTasksTable } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { AttachmentError, MAX_ATTACHMENT_BYTES, MAX_TEAM_ATTACHMENT_BYTES, deleteAttachment, getAttachment, listAttachments, saveAttachment, validateNodeWorkspace } from "./attachments";
import { saveInstance } from "./instances";
import { LEAD_TOOLS, leadToolHandler } from "./lead-tools";

// Allegati delle squadre e spazio di lavoro sul nodo (Postgres di prova)

let userId: number;
let instanceId: number;

const assign = (args: Record<string, unknown>) =>
  leadToolHandler({ instanceId, userId, teamName: "Squadra WI", roleKeys: ["capo", "operaio"] })(LEAD_TOOLS.find((t) => t.name === "assegna_compito")!, args);

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  userId = await ensureUser("dev@localhost");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
  instanceId = await seedNodeTeam({ userId, roles: [nodeRole()] });
});

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
});

const file = (name: string, text: string) => ({ name, contentType: "text/plain", bytes: Buffer.from(text) });

describe("saveAttachment", () => {
  it("salva il contenuto e calcola dimensione e sha256", async () => {
    const view = await saveAttachment(userId, instanceId, file("note.txt", "ciao"));
    expect(view).toMatchObject({ name: "note.txt", contentType: "text/plain", sizeBytes: 4, sha256: createHash("sha256").update("ciao").digest("hex") });
    const got = await getAttachment(instanceId, view.id);
    expect(got.content.toString()).toBe("ciao");
    expect((await listAttachments(instanceId)).map((a) => a.name)).toEqual(["note.txt"]);
  });

  it("oltre 10 MB → 413; oltre 50 MB per squadra → 413; gli eliminati non contano", async () => {
    await expect(saveAttachment(userId, instanceId, { ...file("g.bin", ""), bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) })).rejects.toMatchObject({ status: 413, message: "allegato troppo grande" });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await saveAttachment(userId, instanceId, { ...file(`f${i}.bin`, ""), bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES) })).id);
    await expect(saveAttachment(userId, instanceId, file("x.txt", "x"))).rejects.toMatchObject({ status: 413, message: "spazio allegati della squadra esaurito" });
    expect(MAX_TEAM_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
    await deleteAttachment(instanceId, ids[0]!);
    await expect(saveAttachment(userId, instanceId, file("x.txt", "x"))).resolves.toMatchObject({ name: "x.txt" });
  });

  it("nome non valido → 400; allegato vuoto → 400", async () => {
    for (const name of ["../x", "a/b.txt", "a\\b", "..", "", "a..b/c", "x".repeat(201)]) {
      await expect(saveAttachment(userId, instanceId, file(name, "x")), name).rejects.toMatchObject({ status: 400, message: "allegato non valido" });
    }
    await expect(saveAttachment(userId, instanceId, file("v.txt", ""))).rejects.toMatchObject({ status: 400 });
  });

  it("squadra chiusa → 409, inesistente → 404", async () => {
    await pool.query("UPDATE team_instances SET status = 'closed' WHERE id = $1", [instanceId]);
    await expect(saveAttachment(userId, instanceId, file("a.txt", "a"))).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(saveAttachment(userId, 9999, file("a.txt", "a"))).rejects.toBeInstanceOf(Error);
  });
});

describe("deleteAttachment", () => {
  it("imposta deleted_at: sparisce dall'elenco ma la riga resta", async () => {
    const view = await saveAttachment(userId, instanceId, file("a.txt", "a"));
    await deleteAttachment(instanceId, view.id);
    expect(await listAttachments(instanceId)).toEqual([]);
    await expect(getAttachment(instanceId, view.id)).rejects.toBeInstanceOf(AttachmentError);
    await expect(deleteAttachment(instanceId, view.id)).rejects.toMatchObject({ status: 404 });
    const rows = await db.select().from(teamAttachmentsTable).where(eq(teamAttachmentsTable.id, view.id));
    expect(rows[0]!.deletedAt).not.toBeNull();
  });
});

describe("validateNodeWorkspace", () => {
  it("accetta null e percorsi relativi; rifiuta assoluti, '..', caratteri strani e oltre 300", () => {
    expect(validateNodeWorkspace(null)).toBeNull();
    expect(validateNodeWorkspace("SAP/AIMAG/CR/DS5100/WI_1174")).toBeNull();
    expect(validateNodeWorkspace("Mio lavoro/v1.2-x")).toBeNull();
    for (const bad of ["../x", "/abs", "a/../b", "a/..", "..", "a\\b", "a;b", "a$b", "", "x".repeat(301)]) {
      expect(validateNodeWorkspace(bad), bad).toBe("spazio di lavoro non valido");
    }
    expect(validateNodeWorkspace("x".repeat(300))).toBeNull();
  });

  it("saveInstance salva nodeWorkspace e rifiuta i valori non validi (400)", async () => {
    await expect(saveInstance(userId, instanceId, { ...(await currentSave()), nodeWorkspace: "../x" })).rejects.toMatchObject({ status: 400, message: "spazio di lavoro non valido" });
    const saved = await saveInstance(userId, instanceId, { ...(await currentSave()), nodeWorkspace: "SAP/WI_1" });
    expect(saved.nodeWorkspace).toBe("SAP/WI_1");
    // Omesso: resta com'è; null: si toglie
    expect((await saveInstance(userId, instanceId, await currentSave())).nodeWorkspace).toBe("SAP/WI_1");
    expect((await saveInstance(userId, instanceId, { ...(await currentSave()), nodeWorkspace: null })).nodeWorkspace).toBeNull();
  });
});

async function currentSave() {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId));
  return { name: row!.name, roles: [nodeRole({ key: "capo", name: "Capo", isLead: true })], localSkills: [] };
}

describe("assegna_compito con allegati", () => {
  it("salva gli allegati validi nel compito; un id inesistente, eliminato o di un'altra squadra dà errore al modello", async () => {
    const a = await saveAttachment(userId, instanceId, file("a.txt", "a"));
    const b = await saveAttachment(userId, instanceId, file("b.txt", "b"));
    const gone = await saveAttachment(userId, instanceId, file("c.txt", "c"));
    await deleteAttachment(instanceId, gone.id);
    const other = await seedNodeTeam({ userId, roles: [nodeRole({ key: "x" })], tasks: { t1: "x" } });
    const foreign = await saveAttachment(userId, other, file("d.txt", "d"));

    for (const id of [9999, gone.id, foreign.id]) {
      const bad = await assign({ taskId: "t1", attachments: [a.id, id] });
      expect(bad.ok, String(id)).toBe(false);
      expect(JSON.stringify(bad)).toContain(`allegato ${id} inesistente`);
    }
    expect(await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, instanceId))).toHaveLength(0);

    const ok = await assign({ taskId: "t1", attachments: [b.id, a.id, a.id] });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, instanceId));
    expect(task!.attachmentIds).toEqual([a.id, b.id]);
  });
});
