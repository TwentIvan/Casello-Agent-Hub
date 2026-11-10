import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, teamAttachmentsTable, teamInstancesTable, teamTasksTable } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { ATTACHMENT_UPLOAD_PATH, AttachmentError, MAX_ATTACHMENT_BYTES, MAX_TEAM_ATTACHMENT_BYTES, deleteAttachment, getAttachment, listAttachments, purgeDeletedAttachments, rfc5987, saveAttachment, validateNodeWorkspace } from "./attachments";
import { saveInstance } from "./instances";
import { startTask } from "./task-runner";
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

  it("nome già usato da un allegato non eliminato della squadra (maiuscole comprese) → 409 «nome già usato»", async () => {
    const first = await saveAttachment(userId, instanceId, file("Note.txt", "a"));
    for (const name of ["Note.txt", "note.TXT"]) {
      const err = await saveAttachment(userId, instanceId, file(name, "b")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AttachmentError);
      expect(err).toMatchObject({ status: 409, message: "nome già usato" });
    }
    // Un'altra squadra può usarlo; dopo l'eliminazione il nome torna libero
    const other = await seedNodeTeam({ userId, roles: [nodeRole()] });
    await expect(saveAttachment(userId, other, file("note.txt", "c"))).resolves.toMatchObject({ name: "note.txt" });
    await deleteAttachment(instanceId, first.id);
    await expect(saveAttachment(userId, instanceId, file("note.txt", "d"))).resolves.toMatchObject({ name: "note.txt" });
  });

  it("squadra chiusa → 409, inesistente → 404", async () => {
    await pool.query("UPDATE team_instances SET status = 'closed' WHERE id = $1", [instanceId]);
    await expect(saveAttachment(userId, instanceId, file("a.txt", "a"))).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(saveAttachment(userId, 9999, file("a.txt", "a"))).rejects.toBeInstanceOf(Error);
  });
});

const rowOf = async (id: number) => (await db.select().from(teamAttachmentsTable).where(eq(teamAttachmentsTable.id, id)))[0];

describe("deleteAttachment", () => {
  it("allegato non citato da compiti attivi: la riga sparisce", async () => {
    const view = await saveAttachment(userId, instanceId, file("a.txt", "a"));
    await deleteAttachment(instanceId, view.id);
    expect(await listAttachments(instanceId)).toEqual([]);
    await expect(getAttachment(instanceId, view.id)).rejects.toBeInstanceOf(AttachmentError);
    await expect(deleteAttachment(instanceId, view.id)).rejects.toMatchObject({ status: 404 });
    expect(await rowOf(view.id)).toBeUndefined();
  });

  it("allegato citato da un compito queued/waiting_node/running: eliminazione logica; finito il compito lo ripulisce purgeDeletedAttachments", async () => {
    const cited = await saveAttachment(userId, instanceId, file("a.txt", "a"));
    const other = await saveAttachment(userId, instanceId, file("b.txt", "b"));
    const started = await startTask(instanceId, "t1", [cited.id]);
    await deleteAttachment(instanceId, cited.id);
    await deleteAttachment(instanceId, other.id);
    expect(await listAttachments(instanceId)).toEqual([]);
    expect((await rowOf(cited.id))!.deletedAt).not.toBeNull();
    expect(await rowOf(other.id)).toBeUndefined();

    // Compito ancora attivo: la pulizia lascia la riga
    expect(await purgeDeletedAttachments()).toBe(0);
    expect(await rowOf(cited.id)).toBeDefined();
    await db.update(teamTasksTable).set({ status: "done" }).where(eq(teamTasksTable.id, started.id));
    expect(await purgeDeletedAttachments()).toBe(1);
    expect(await rowOf(cited.id)).toBeUndefined();
  });

  it("la pulizia non tocca gli allegati non eliminati", async () => {
    const view = await saveAttachment(userId, instanceId, file("a.txt", "a"));
    expect(await purgeDeletedAttachments()).toBe(0);
    expect(await rowOf(view.id)).toBeDefined();
  });
});

describe("startTask e allegati", () => {
  it("un allegato eliminato o inesistente al momento dell'assegnazione: errore «allegato <id> inesistente», nessun compito", async () => {
    const view = await saveAttachment(userId, instanceId, file("a.txt", "a"));
    await deleteAttachment(instanceId, view.id);
    await expect(startTask(instanceId, "t1", [view.id])).rejects.toThrow(`allegato ${view.id} inesistente`);
    await expect(startTask(instanceId, "t1", [9999])).rejects.toThrow("allegato 9999 inesistente");
    expect(await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, instanceId))).toHaveLength(0);
  });
});

describe("helper", () => {
  it("rfc5987 codifica anche ' ( ) *", () => {
    expect(rfc5987("a b'(c)*è.txt")).toBe("a%20b%27%28c%29%2A%C3%A8.txt");
  });
  it("il percorso del caricamento ignora le maiuscole come il routing di Express", () => {
    expect(ATTACHMENT_UPLOAD_PATH.test("/api/team-instances/3/attachments")).toBe(true);
    expect(ATTACHMENT_UPLOAD_PATH.test("/api/Team-Instances/3/attachments")).toBe(true);
    expect(ATTACHMENT_UPLOAD_PATH.test("/api/team-instances/3/attachments/4")).toBe(false);
  });
});

describe("validateNodeWorkspace", () => {
  it("accetta null e percorsi relativi; rifiuta assoluti, '..', caratteri strani e oltre 300", () => {
    expect(validateNodeWorkspace(null)).toBeNull();
    expect(validateNodeWorkspace("SAP/AIMAG/CR/DS5100/WI_1174")).toBeNull();
    expect(validateNodeWorkspace("Mio lavoro/v1.2-x")).toBeNull();
    for (const bad of ["../x", "/abs", "a/../b", "a/..", "..", "a\\b", "a;b", "a$b", "", "x".repeat(301), "a//b", "./x", "a/./b", "a/b/", ".", "/"]) {
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
  return { name: row!.name, roles: [{ ...nodeRole({ key: "capo", name: "Capo", isLead: true }), code: "none" as const }], localSkills: [] };
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
