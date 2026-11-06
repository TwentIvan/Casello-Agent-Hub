// Impronte dello stato degli oggetti di Lucius (SHA-256 di un JSON canonico): una scheda di modifica porta quella dello
// stato su cui è nata, e all'accettazione (Task 7) si ricontrolla. null = oggetto sparito.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, agentToolsTable, agentsTable, skillsTable, teamTemplatesTable } from "@workspace/db";
import type { SubjectType } from "../types";
import { idFromSubject } from "./shared";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export async function subjectHash(type: SubjectType, subjectId: string): Promise<string | null> {
  switch (type) {
    case "agent": {
      const id = idFromSubject(subjectId);
      if (id === null) return null;
      const [agent] = await db.select({ systemPrompt: agentsTable.systemPrompt }).from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
      if (!agent) return null;
      const links = await db.select({ toolId: agentToolsTable.toolId }).from(agentToolsTable).where(eq(agentToolsTable.agentId, id));
      const toolIds = links.map((l) => l.toolId).sort((a, b) => a - b);
      return sha256(JSON.stringify({ systemPrompt: agent.systemPrompt, toolIds }));
    }
    case "skill": {
      const [skill] = await db.select({ currentVersion: skillsTable.currentVersion }).from(skillsTable).where(eq(skillsTable.code, subjectId)).limit(1);
      return skill ? sha256(JSON.stringify({ currentVersion: skill.currentVersion })) : null;
    }
    case "team_template": {
      const id = idFromSubject(subjectId);
      if (id === null) return null;
      const [tpl] = await db.select({ version: teamTemplatesTable.version }).from(teamTemplatesTable).where(eq(teamTemplatesTable.id, id)).limit(1);
      return tpl ? sha256(JSON.stringify({ version: tpl.version })) : null;
    }
    default:
      return null;
  }
}
