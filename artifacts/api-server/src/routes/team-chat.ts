import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamChatProposalsTable,
  teamInstanceSkillsTable,
  type TeamChatConversation,
  type TeamChatMessage,
} from "@workspace/db";
import {
  ListTeamChatConversationsParams,
  ListTeamChatConversationsResponse,
  CreateTeamChatConversationParams,
  CreateTeamChatConversationBody,
  GetTeamChatConversationParams,
  GetTeamChatConversationResponse,
  DeleteTeamChatConversationParams,
  SendTeamChatMessageParams,
  SendTeamChatMessageBody,
  SendTeamChatMessageResponse,
  DecideTeamChatProposalParams,
  DecideTeamChatProposalBody,
  DecideTeamChatProposalResponse,
  DownloadRoleInstructionsParams,
  DownloadRolesExportParams,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { ModelChoiceError, chooseOwnModel } from "../lib/ai/choice";
import { getDefaultModel, ownModel } from "../lib/ai/default-model";
import { userBudgetBlock } from "../lib/budget";
import { buildZip } from "../lib/zip-writer";
import { TeamChatError, decideTeamChatProposal, toProposalView, type ProposalView } from "../lib/team-chat/decide";
import { instructionsSkillCode } from "../lib/team-chat/instructions-file";
import { TEAM_CHAT_MESSAGE_MAX_CHARS, TurnBusyError, startTeamChatTurn } from "../lib/team-chat/run-turn";
import { loadTeamSnapshot } from "../lib/team-chat/snapshot";
import { INSTANCE_MESSAGES, InstanceError, getInstance } from "../lib/teams/instances";
import { TeamRuleError } from "../lib/teams/rules";
import { consumeTeamChatMessage } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";
import { toNumberOrNull } from "./serializers";

// Route della chat di Lucius sulla squadra: conversazioni private dell'utente (per gli altri 404), messaggi (il
// turno gira in background e la UI fa polling su GET /team-chat-conversations/:id), decisione sulle schede e
// scarico delle istruzioni dei ruoli. Con un token personale valgono gli ambiti per metodo.

const CONVERSATION_NOT_FOUND = "conversazione non trovata";
const TURN_RUNNING = "Lucius sta già rispondendo";
const EMPTY_MESSAGE = "messaggio vuoto";
const TOO_MANY = "Troppe richieste: riprova tra poco";
const NO_INSTRUCTIONS = "il ruolo non ha istruzioni";

const toPublicConversation = (c: TeamChatConversation) => {
  const { userId: _userId, summarizedAt: _summarizedAt, costUsd, ...rest } = c;
  return { ...rest, costUsd: toNumberOrNull(costUsd) };
};

const toPublicMessage = (m: TeamChatMessage) => {
  const { conversationId: _conversationId, tokens: _tokens, ...rest } = m;
  return rest;
};

const toPublicProposal = (p: ProposalView, currentValue: string) => {
  const { conversationId: _conversationId, ...rest } = p;
  return { ...rest, payload: typeof p.payload === "object" && p.payload !== null && !Array.isArray(p.payload) ? p.payload : null, currentValue };
};

/** Identità o istruzioni attuali del ruolo ("" se non ci sono), da uno snapshot della squadra. */
function currentValueOf(team: { roles: ReadonlyArray<{ key: string; task: string }>; localSkills: ReadonlyArray<{ code: string; content: string }> }, p: ProposalView): string {
  if (p.kind === "role_identity") return team.roles.find((r) => r.key === p.roleKey)?.task ?? "";
  return team.localSkills.find((s) => s.code === instructionsSkillCode(p.roleKey))?.content ?? "";
}

async function findConversation(id: number, userId: number): Promise<TeamChatConversation | undefined> {
  const [row] = await db
    .select()
    .from(teamChatConversationsTable)
    .where(and(eq(teamChatConversationsTable.id, id), eq(teamChatConversationsTable.userId, userId)))
    .limit(1);
  return row;
}

/** Esegue la richiesta e traduce gli errori di istanza, regole e schede nel loro stato HTTP. */
async function guarded(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof TeamRuleError) && !(err instanceof InstanceError) && !(err instanceof TeamChatError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

/** Nome del file zip: minuscole ASCII, tutto ciò che non è alfanumerico diventa «-», niente «-» ai bordi. */
export function zipSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "squadra" : slug;
}

export function createTeamChatRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/team-instances/:id/team-chat-conversations", async (req, res) => {
    const { id } = parseRequest(ListTeamChatConversationsParams, req.params);
    await guarded(res, async () => {
      await getInstance(id);
      const rows = await db
        .select()
        .from(teamChatConversationsTable)
        .where(and(eq(teamChatConversationsTable.teamInstanceId, id), eq(teamChatConversationsTable.userId, currentUserId(req))))
        .orderBy(desc(teamChatConversationsTable.updatedAt), desc(teamChatConversationsTable.id));
      res.json(ListTeamChatConversationsResponse.parse(rows.map(toPublicConversation)));
    });
  });

  router.post("/team-instances/:id/team-chat-conversations", async (req, res) => {
    const { id } = parseRequest(CreateTeamChatConversationParams, req.params);
    const body = parseRequest(CreateTeamChatConversationBody, req.body ?? {});
    const userId = currentUserId(req);
    await guarded(res, async () => {
      await getInstance(id);
      let aiModelId: number | null;
      if (body.aiModelId !== undefined && body.aiModelId !== null) {
        try {
          await chooseOwnModel(body.aiModelId, userId);
        } catch (err) {
          if (!(err instanceof ModelChoiceError)) throw err;
          res.status(400).json({ error: err.message });
          return;
        }
        aiModelId = body.aiModelId;
      } else {
        // Il predefinito vale solo se è ancora di un account dell'utente
        const def = await getDefaultModel(userId);
        aiModelId = def !== null && (await ownModel(userId, def, db)) ? def : null;
      }
      const [conv] = await db.insert(teamChatConversationsTable).values({ teamInstanceId: id, userId, aiModelId, title: "" }).returning();
      res.status(201).json(toPublicConversation(conv!));
    });
  });

  router.get("/team-chat-conversations/:id", async (req, res) => {
    const { id } = parseRequest(GetTeamChatConversationParams, req.params);
    const conv = await findConversation(id, currentUserId(req));
    if (!conv) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    const messages = await db.select().from(teamChatMessagesTable).where(eq(teamChatMessagesTable.conversationId, id)).orderBy(asc(teamChatMessagesTable.id));
    const proposals = await db.select().from(teamChatProposalsTable).where(eq(teamChatProposalsTable.conversationId, id)).orderBy(asc(teamChatProposalsTable.id));
    await guarded(res, async () => {
      const team = proposals.length > 0 ? await loadTeamSnapshot(conv.teamInstanceId) : { roles: [], localSkills: [] };
      res.json(
        GetTeamChatConversationResponse.parse({
          ...toPublicConversation(conv),
          messages: messages.map(toPublicMessage),
          proposals: proposals.map((p) => {
            const view = toProposalView(p);
            return toPublicProposal(view, currentValueOf(team, view));
          }),
        }),
      );
    });
  });

  router.delete("/team-chat-conversations/:id", async (req, res) => {
    const { id } = parseRequest(DeleteTeamChatConversationParams, req.params);
    // Messaggi e schede vanno a cascata
    const deleted = await db
      .delete(teamChatConversationsTable)
      .where(and(eq(teamChatConversationsTable.id, id), eq(teamChatConversationsTable.userId, currentUserId(req))))
      .returning({ id: teamChatConversationsTable.id });
    if (!deleted.length) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    res.status(204).end();
  });

  router.post("/team-chat-conversations/:id/messages", async (req, res) => {
    const { id } = parseRequest(SendTeamChatMessageParams, req.params);
    const body = parseRequest(SendTeamChatMessageBody, req.body);
    const userId = currentUserId(req);
    // Un messaggio di soli spazi non è un messaggio; titolo e cronologia usano il testo senza spazi ai bordi
    const content = body.content.trim();
    if (content === "" || content.length > TEAM_CHAT_MESSAGE_MAX_CHARS) {
      res.status(400).json({ error: EMPTY_MESSAGE });
      return;
    }
    if (!consumeTeamChatMessage(userId)) {
      res.status(429).json({ error: TOO_MANY });
      return;
    }
    const conv = await findConversation(id, userId);
    if (!conv) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    const blocked = conv.aiModelId === null ? null : await userBudgetBlock(conv.aiModelId);
    if (blocked) {
      res.status(409).json({ error: blocked });
      return;
    }
    await guarded(res, async () => {
      try {
        const message = await startTeamChatTurn(id, content);
        res.status(202).json(SendTeamChatMessageResponse.parse(toPublicMessage(message)));
      } catch (err) {
        if (!(err instanceof TurnBusyError)) throw err;
        res.status(409).json({ error: TURN_RUNNING });
      }
    });
  });

  router.post("/team-chat-proposals/:id/decision", async (req, res) => {
    const { id } = parseRequest(DecideTeamChatProposalParams, req.params);
    const { action } = parseRequest(DecideTeamChatProposalBody, req.body);
    await guarded(res, async () => {
      const view = await decideTeamChatProposal(currentUserId(req), id, action);
      const conv = await db
        .select({ teamInstanceId: teamChatConversationsTable.teamInstanceId })
        .from(teamChatConversationsTable)
        .where(eq(teamChatConversationsTable.id, view.conversationId))
        .limit(1);
      const team = await loadTeamSnapshot(conv[0]!.teamInstanceId);
      res.json(DecideTeamChatProposalResponse.parse(toPublicProposal(view, currentValueOf(team, view))));
    });
  });

  router.get("/team-instances/:id/roles/:key/instructions.md", async (req, res) => {
    const { id, key } = parseRequest(DownloadRoleInstructionsParams, req.params);
    await guarded(res, async () => {
      await getInstance(id);
      const [skill] = await db
        .select({ content: teamInstanceSkillsTable.content })
        .from(teamInstanceSkillsTable)
        .where(and(eq(teamInstanceSkillsTable.instanceId, id), eq(teamInstanceSkillsTable.code, instructionsSkillCode(key))))
        .limit(1);
      if (!skill) {
        res.status(404).json({ error: NO_INSTRUCTIONS });
        return;
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${key.replace(/[^A-Za-z0-9._-]/g, "_")}.md"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(skill.content);
    });
  });

  router.get("/team-instances/:id/roles-export.zip", async (req, res) => {
    const { id } = parseRequest(DownloadRolesExportParams, req.params);
    await guarded(res, async () => {
      const instance = await getInstance(id);
      const skills = await db.select().from(teamInstanceSkillsTable).where(eq(teamInstanceSkillsTable.instanceId, id));
      const files = instance.roles.flatMap((role) => {
        const skill = skills.find((s) => s.code === instructionsSkillCode(role.key));
        return skill ? [{ name: `${role.key}.md`, content: Buffer.from(skill.content, "utf8") }] : [];
      });
      if (files.length === 0) {
        res.status(404).json({ error: INSTANCE_MESSAGES.noRoleInstructions });
        return;
      }
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipSlug(instance.name)}-ruoli.zip"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(buildZip(files));
    });
  });

  return router;
}
