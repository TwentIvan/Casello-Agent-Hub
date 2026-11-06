import { Router, type IRouter } from "express";
import {
  ListMemoryNotesQueryParams,
  ListMemoryNotesResponse,
  CreateMemoryNoteBody,
  UpdateMemoryNoteParams,
  UpdateMemoryNoteQueryParams,
  UpdateMemoryNoteBody,
  UpdateMemoryNoteResponse,
  DeleteMemoryNoteParams,
  DeleteMemoryNoteQueryParams,
  ListMemoryHistoryQueryParams,
  ListMemoryHistoryResponse,
  DeleteMemoryHistoryEntryParams,
  DeleteMemoryHistoryEntryQueryParams,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { deleteHistory, listHistory } from "../lib/memory/history";
import { addNote, deleteNote, listNotes, updateNote } from "../lib/memory/notes";
import { MemoryError } from "../lib/memory/types";
import { parseRequest } from "../middlewares/error-handler";

// Memoria dei personaggi (Alfred, Lucius): appunti e storico dell'utente, separati per personaggio.
// Il personaggio sta nella query (o nel corpo del POST): un valore non valido è 400. Con un token personale
// valgono le sole letture (GET): le scritture (appunti e storico) sono solo con il login.

export function createMemoriesRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/memories/notes", async (req, res) => {
    const { character } = parseRequest(ListMemoryNotesQueryParams, req.query);
    res.json(ListMemoryNotesResponse.parse(await listNotes(currentUserId(req), character)));
  });

  router.post("/memories/notes", sessionOnly, async (req, res) => {
    const { character, content } = parseRequest(CreateMemoryNoteBody, req.body);
    try {
      res.status(201).json(await addNote(currentUserId(req), character, content));
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  });

  router.patch("/memories/notes/:id", sessionOnly, async (req, res) => {
    const { id } = parseRequest(UpdateMemoryNoteParams, req.params);
    const { character } = parseRequest(UpdateMemoryNoteQueryParams, req.query);
    const { content } = parseRequest(UpdateMemoryNoteBody, req.body);
    try {
      res.json(UpdateMemoryNoteResponse.parse(await updateNote(currentUserId(req), character, id, content)));
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  });

  router.delete("/memories/notes/:id", sessionOnly, async (req, res) => {
    const { id } = parseRequest(DeleteMemoryNoteParams, req.params);
    const { character } = parseRequest(DeleteMemoryNoteQueryParams, req.query);
    try {
      await deleteNote(currentUserId(req), character, id);
      res.status(204).end();
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  });

  router.get("/memories/history", async (req, res) => {
    const { character, q } = parseRequest(ListMemoryHistoryQueryParams, req.query);
    res.json(ListMemoryHistoryResponse.parse(await listHistory(currentUserId(req), character, q)));
  });

  router.delete("/memories/history/:id", sessionOnly, async (req, res) => {
    const { id } = parseRequest(DeleteMemoryHistoryEntryParams, req.params);
    const { character } = parseRequest(DeleteMemoryHistoryEntryQueryParams, req.query);
    try {
      await deleteHistory(currentUserId(req), character, id);
      res.status(204).end();
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  });

  return router;
}
