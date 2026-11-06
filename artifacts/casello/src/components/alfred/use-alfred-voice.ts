import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  useCloseAlfredSession,
  useRecordAlfredUsage,
  useRenewAlfredSession,
  useRunAlfredTool,
  useStartAlfredSession,
} from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { MIC_WORKLET_SOURCE } from "./mic-worklet";

export type AlfredStatus = "stopped" | "connecting" | "listening" | "speaking";
export type AlfredErrorKind = "mic" | "model" | "closed" | "other";
export interface AlfredError {
  kind: AlfredErrorKind;
  message: string;
}
export interface AlfredLine {
  id: number;
  role: "user" | "alfred";
  text: string;
}

const GEMINI_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const MAX_LINES = 50;
const USAGE_EVERY_MS = 10_000;
const MAX_RECONNECTS = 4;
const AUDIO_ERROR =
  "Impossibile avviare l'audio: controlla microfono e permessi del browser e riprova.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const CLOSED = "Sessione chiusa. Premi «Parla con Alfred» per ricominciare.";
const CONFIRM_NOT_HEARD = "conferma non ricevuta: chiedi all'utente";

function b64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microfono negato: riattivalo nelle impostazioni del browser (Impostazioni → Safari o Chrome → Microfono) e riprova.";
  if (name === "NotFoundError") return "Nessun microfono trovato su questo dispositivo.";
  return "Impossibile usare il microfono.";
}

interface Frame {
  setupComplete?: unknown;
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  goAway?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number; candidatesTokenCount?: number };
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
}

/** Conversazione vocale con Alfred: microfono, Gemini Live (WebSocket diretto), strumenti, consumi e ripresa. */
export function useAlfredVoice() {
  const [status, setStatus] = useState<AlfredStatus>("stopped");
  const [error, setError] = useState<AlfredError | null>(null);
  const [lines, setLines] = useState<AlfredLine[]>([]);

  const startSession = useStartAlfredSession();
  const renewSession = useRenewAlfredSession();
  const recordUsage = useRecordAlfredUsage();
  const closeSession = useCloseAlfredSession();
  const runTool = useRunAlfredTool();
  // Le funzioni delle mutazioni cambiano a ogni render: il ciclo di vita le legge da qui
  const api = useRef({ startSession, renewSession, recordUsage, closeSession, runTool });
  api.current = { startSession, renewSession, recordUsage, closeSession, runTool };

  const r = useRef({
    active: false,
    gen: 0,
    ws: null as WebSocket | null,
    ctx: null as AudioContext | null,
    mic: null as MediaStream | null,
    node: null as AudioWorkletNode | null,
    ready: false,
    resumed: false,
    deferred: false,
    playHead: 0,
    sources: [] as AudioBufferSourceNode[],
    sessionId: 0,
    model: "",
    handle: null as string | null,
    reconnects: 0,
    inText: "",
    outText: "",
    lineId: 0,
    // Totali della sessione: somma dei frame `usageMetadata` (ognuno è per turno), anche tra ricollegamenti
    prompt: 0,
    completion: 0,
    sentPrompt: 0,
    sentCompletion: 0,
    lastUsageAt: 0,
    // Invio in corso, legato alla sessione che lo ha avviato
    usageInFlight: null as { id: number; p: Promise<void> } | null,
    // Conferma a voce: dopo la risposta di prepara_decisione serve almeno un pezzo di trascrizione dell'utente
    awaitingHeard: false,
    heard: false,
    usageTimer: null as ReturnType<typeof setTimeout> | null,
  });

  const pushLines = useCallback((entries: Omit<AlfredLine, "id">[]) => {
    if (entries.length === 0) return;
    setLines((prev) => [...prev, ...entries.map((e) => ({ ...e, id: ++r.current.lineId }))].slice(-MAX_LINES));
  }, []);

  const flushTurn = useCallback(() => {
    const s = r.current;
    const entries: Omit<AlfredLine, "id">[] = [];
    if (s.inText.trim()) entries.push({ role: "user", text: s.inText.trim() });
    if (s.outText.trim()) entries.push({ role: "alfred", text: s.outText.trim() });
    s.inText = "";
    s.outText = "";
    pushLines(entries);
  }, [pushLines]);

  const stopPlayback = useCallback(() => {
    const s = r.current;
    for (const src of s.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* già fermata */
      }
    }
    s.sources = [];
    s.playHead = 0;
  }, []);

  const playPcm = useCallback((b64: string) => {
    const s = r.current;
    const ctx = s.ctx;
    if (!ctx) return;
    const bytes = bytesFromB64(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    s.playHead = Math.max(s.playHead, ctx.currentTime + 0.03);
    src.start(s.playHead);
    s.playHead += buf.duration;
    s.sources.push(src);
    src.onended = () => {
      s.sources = s.sources.filter((x) => x !== src);
      if (s.sources.length === 0 && s.active) setStatus("listening");
    };
    setStatus("speaking");
  }, []);

  /** Chiude audio e connessione senza toccare la sessione sul server. */
  const teardown = useCallback(() => {
    const s = r.current;
    s.active = false;
    s.gen++;
    s.ready = false;
    s.deferred = false;
    if (s.usageTimer) clearTimeout(s.usageTimer);
    s.usageTimer = null;
    const ws = s.ws;
    s.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* già chiuso */
      }
    }
    stopPlayback();
    s.mic?.getTracks().forEach((t) => t.stop());
    s.mic = null;
    s.node?.disconnect();
    s.node = null;
    if (s.ctx) s.ctx.onstatechange = null;
    void s.ctx?.close().catch(() => undefined);
    s.ctx = null;
  }, [stopPlayback]);

  const fail = useCallback(
    (kind: AlfredErrorKind, message: string) => {
      setError({ kind, message });
      teardown();
      setStatus("stopped");
    },
    [teardown],
  );

  const sessionClosed = useCallback(() => fail("closed", CLOSED), [fail]);

  /** Manda i totali cumulativi; segna come inviato solo a risposta ricevuta, altrimenti ritenta al prossimo giro o alla chiusura. */
  const sendUsage = useCallback((): Promise<void> => {
    const s = r.current;
    if (s.usageInFlight && s.usageInFlight.id === s.sessionId) return s.usageInFlight.p;
    if (s.usageTimer) clearTimeout(s.usageTimer);
    s.usageTimer = null;
    if (!s.sessionId || (s.prompt === s.sentPrompt && s.completion === s.sentCompletion)) return Promise.resolve();
    const body = { promptTokens: s.prompt, completionTokens: s.completion };
    const id = s.sessionId;
    s.lastUsageAt = Date.now();
    const entry = { id, p: Promise.resolve() };
    entry.p = (async () => {
      try {
        await api.current.recordUsage.mutateAsync({ id, data: body });
        // Una risposta di una sessione precedente non tocca i contatori di quella nuova
        if (s.sessionId === id) {
          s.sentPrompt = Math.max(s.sentPrompt, body.promptTokens);
          s.sentCompletion = Math.max(s.sentCompletion, body.completionTokens);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          if (s.active && s.sessionId === id) sessionClosed();
        } else if (s.active && s.sessionId === id) {
          scheduleUsageRef.current();
        }
      } finally {
        if (s.usageInFlight === entry) s.usageInFlight = null;
      }
    })();
    s.usageInFlight = entry;
    return entry.p;
  }, [sessionClosed]);

  const scheduleUsage = useCallback(() => {
    const s = r.current;
    if (s.usageTimer) return;
    const wait = Math.max(0, USAGE_EVERY_MS - (Date.now() - s.lastUsageAt));
    s.usageTimer = setTimeout(() => {
      s.usageTimer = null;
      void sendUsage();
    }, wait);
  }, [sendUsage]);
  const scheduleUsageRef = useRef(scheduleUsage);
  scheduleUsageRef.current = scheduleUsage;

  /** Chiamate degli strumenti: fuori dal ciclo dei frame, così l'audio non si riordina. */
  const runToolCalls = useCallback(
    async (gen: number, ws: WebSocket, calls: { id: string; name: string; args?: Record<string, unknown> }[]) => {
      const s = r.current;
      const responses: { id: string; name: string; response: unknown }[] = [];
      for (const fc of calls) {
        // Conferma a voce: si inoltra solo se dopo la preparazione l'utente ha detto qualcosa
        if (fc.name === "conferma_decisione" && !s.heard) {
          responses.push({ id: fc.id, name: fc.name, response: { ok: false, error: CONFIRM_NOT_HEARD } });
          continue;
        }
        try {
          const result = await api.current.runTool.mutateAsync({ id: s.sessionId, name: fc.name, data: { args: fc.args ?? {} } });
          responses.push({ id: fc.id, name: fc.name, response: result });
          if (fc.name === "prepara_decisione") {
            s.heard = false;
            s.awaitingHeard = true;
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            if (s.gen === gen) sessionClosed();
            return;
          }
          responses.push({ id: fc.id, name: fc.name, response: { ok: false, error: apiErrorMessage(e) } });
        }
        if (s.gen !== gen) return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    },
    [sessionClosed],
  );

  const reconnectRef = useRef<(fromGen: number) => Promise<void>>(async () => undefined);

  const handleFrame = useCallback(
    (gen: number, ws: WebSocket, msg: Frame) => {
      const s = r.current;
      if (msg.setupComplete) {
        s.ready = true;
        s.reconnects = 0;
        setStatus("listening");
        // Solo alla prima apertura: dopo una ripresa la conversazione continua da sola
        if (!s.resumed) ws.send(JSON.stringify({ realtimeInput: { text: "[apertura]" } }));
        return;
      }
      if (msg.sessionResumptionUpdate?.newHandle) s.handle = msg.sessionResumptionUpdate.newHandle;
      if (msg.usageMetadata) {
        const u = msg.usageMetadata;
        s.prompt += u.promptTokenCount ?? 0;
        s.completion += u.responseTokenCount ?? u.candidatesTokenCount ?? 0;
        scheduleUsage();
      }
      if (msg.goAway) {
        void reconnectRef.current(gen);
        return;
      }
      if (msg.toolCall?.functionCalls) {
        void runToolCalls(gen, ws, msg.toolCall.functionCalls);
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.interrupted) {
        stopPlayback();
        flushTurn();
        setStatus("listening");
      }
      if (sc.inputTranscription?.text) {
        s.inText += sc.inputTranscription.text;
        if (s.awaitingHeard) s.heard = true;
      }
      if (sc.outputTranscription?.text) s.outText += sc.outputTranscription.text;
      for (const part of sc.modelTurn?.parts ?? []) if (part.inlineData?.data) playPcm(part.inlineData.data);
      if (sc.turnComplete) flushTurn();
    },
    [flushTurn, playPcm, runToolCalls, scheduleUsage, stopPlayback],
  );

  const connect = useCallback(
    (token: string, resumed: boolean) => {
      const s = r.current;
      const gen = ++s.gen;
      s.ready = false;
      s.resumed = resumed;
      const ws = new WebSocket(`${GEMINI_WS}?access_token=${encodeURIComponent(token)}`);
      // Binario come ArrayBuffer e decodifica sincrona: i frame si elaborano nell'ordine di arrivo
      ws.binaryType = "arraybuffer";
      s.ws = ws;
      const decoder = new TextDecoder();
      ws.onopen = () => {
        // Tutta la configurazione, ripresa compresa, sta nel token: il setup porta solo il modello
        ws.send(JSON.stringify({ setup: { model: `models/${s.model}` } }));
      };
      ws.onmessage = (ev) => {
        if (s.gen !== gen) return;
        try {
          const text = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
          handleFrame(gen, ws, JSON.parse(text) as Frame);
        } catch {
          /* messaggio non leggibile: si ignora */
        }
      };
      ws.onerror = () => undefined;
      ws.onclose = () => {
        if (s.gen !== gen || !s.active) return;
        // Chiusura inattesa: se la ripresa non è partita si riparte da capo, altrimenti si riprende
        if (!s.ready) s.handle = null;
        void reconnectRef.current(gen);
      };
    },
    [handleFrame],
  );

  const reconnect = useCallback(
    async (fromGen: number): Promise<void> => {
      const s = r.current;
      if (!s.active || s.gen !== fromGen) return;
      setStatus("connecting");
      // In background (iOS, schermo bloccato) non si prova: si riprende al ritorno in primo piano
      if (document.hidden) {
        s.deferred = true;
        return;
      }
      s.deferred = false;
      if (s.reconnects >= MAX_RECONNECTS) {
        fail("other", "Connessione con Gemini persa. Riprova.");
        return;
      }
      const attempt = s.reconnects++;
      s.gen++; // il vecchio socket non conta più
      const gen = s.gen;
      const old = s.ws;
      s.ws = null;
      s.ready = false;
      if (old) {
        old.onclose = null;
        old.onmessage = null;
        try {
          old.close();
        } catch {
          /* già chiuso */
        }
      }
      stopPlayback();
      // Attesa crescente tra un tentativo e l'altro: 0, 1 s, 2 s, 4 s
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      if (!s.active || s.gen !== gen) return;
      if (document.hidden) {
        s.deferred = true;
        s.reconnects--;
        return;
      }
      try {
        // Il token è a uso singolo: ne serve uno nuovo, con dentro l'handle per continuare la conversazione
        const handle = s.handle;
        const session = await api.current.renewSession.mutateAsync({
          id: s.sessionId,
          data: handle ? { resumptionHandle: handle } : undefined,
        });
        if (!s.active || s.gen !== gen) return;
        s.model = session.model;
        connect(session.token, handle !== null);
      } catch (e) {
        if (!s.active || s.gen !== gen) return;
        if (e instanceof ApiError && e.status === 404) sessionClosed();
        else if (e instanceof ApiError && (e.status === 400 || e.status === 409)) fail("other", apiErrorMessage(e));
        else void reconnectRef.current(gen); // rete o Gemini non raggiungibili: nuovo tentativo con attesa
      }
    },
    [connect, sessionClosed, fail, stopPlayback],
  );
  reconnectRef.current = reconnect;

  const start = useCallback(async () => {
    const s = r.current;
    if (s.active) return;
    setError(null);
    setLines([]);
    setStatus("connecting");
    s.active = true;
    const gen = ++s.gen;
    s.sessionId = 0;
    s.handle = null;
    s.resumed = false;
    s.deferred = false;
    s.reconnects = 0;
    s.prompt = s.completion = s.sentPrompt = s.sentCompletion = 0;
    s.lastUsageAt = 0;
    s.awaitingHeard = s.heard = false;
    s.inText = s.outText = "";
    const cancelled = () => !s.active || s.gen !== gen;

    // L'audio si sblocca dentro il gesto dell'utente (iOS): contesto creato e ripreso prima di ogni attesa
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
      s.ctx = ctx;
      void ctx.resume().catch(() => undefined);
      ctx.onstatechange = () => {
        if (s.active && !document.hidden && (ctx.state === "suspended" || (ctx.state as string) === "interrupted"))
          void ctx.resume().catch(() => undefined);
      };
    } catch {
      fail("other", AUDIO_ERROR);
      return;
    }

    let stream: MediaStream | null = null;
    let sessionId = 0;
    // Fermato o sostituito durante un'attesa: si libera quel che si è già preso
    const abort = () => {
      stream?.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
      if (sessionId) void api.current.closeSession.mutateAsync({ id: sessionId }).catch(() => undefined);
    };

    // La sessione prima del microfono: modello mancante o tetto raggiunto si vedono senza chiedere il permesso
    let session;
    try {
      session = await api.current.startSession.mutateAsync();
    } catch (e) {
      if (cancelled()) return abort();
      const message = apiErrorMessage(e);
      const isModel = e instanceof ApiError && e.status === 409 && /modello di Alfred/i.test(message);
      fail(isModel ? "model" : "other", message);
      return;
    }
    sessionId = session.sessionId;
    if (cancelled()) return abort();
    s.sessionId = sessionId;
    s.model = session.model;

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (e) {
        if (cancelled()) return abort();
        void api.current.closeSession.mutateAsync({ id: sessionId }).catch(() => undefined);
        fail("mic", micErrorMessage(e));
        return;
      }
      if (cancelled()) return abort();
      s.mic = stream;
      const url = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (cancelled()) return abort();
      await ctx.resume();
      if (cancelled()) return abort();
      const node = new AudioWorkletNode(ctx, "mic");
      s.node = node;
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const ws = s.ws;
        if (s.ready && ws && ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              realtimeInput: { audio: { data: b64FromBytes(new Uint8Array(e.data)), mimeType: "audio/pcm;rate=16000" } },
            }),
          );
      };
      ctx.createMediaStreamSource(stream).connect(node);
      connect(session.token, false);
    } catch {
      if (cancelled()) return abort();
      void api.current.closeSession.mutateAsync({ id: sessionId }).catch(() => undefined);
      fail("other", AUDIO_ERROR);
    }
  }, [connect, fail]);

  /** «Basta così»: vale anche mentre si collega o si ricollega (annulla, chiude la sessione e libera l'audio). */
  const stop = useCallback(async () => {
    const s = r.current;
    if (!s.active) return;
    const id = s.sessionId;
    const totals = { promptTokens: s.prompt, completionTokens: s.completion };
    // Prima si spengono microfono e connessione: gli invii al server non devono tenerli accesi
    teardown();
    flushTurn();
    setStatus("stopped");
    if (!id) return;
    // Poi l'invio eventualmente in corso, l'ultimo con i totali finali e la chiusura (anche se il POST fallisce)
    const pending = s.usageInFlight;
    if (pending && pending.id === id) await pending.p;
    if (totals.promptTokens > 0 || totals.completionTokens > 0)
      await api.current.recordUsage.mutateAsync({ id, data: totals }).catch(() => undefined);
    await api.current.closeSession.mutateAsync({ id }).catch(() => undefined);
  }, [flushTurn, teardown]);

  // iOS: in background l'audio si sospende e le connessioni cadono; al ritorno in primo piano si riparte
  useEffect(() => {
    const onVisible = () => {
      const s = r.current;
      if (document.hidden || !s.active) return;
      if (s.ctx && (s.ctx.state === "suspended" || (s.ctx.state as string) === "interrupted"))
        void s.ctx.resume().catch(() => undefined);
      if (s.deferred) void reconnectRef.current(s.gen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Uscendo dalla pagina la conversazione finisce
  useEffect(
    () => () => {
      const s = r.current;
      if (!s.active) return;
      const id = s.sessionId;
      void sendUsage().finally(() => {
        if (id) void api.current.closeSession.mutateAsync({ id }).catch(() => undefined);
      });
      teardown();
    },
    [sendUsage, teardown],
  );

  return { status, error, lines, start, stop };
}
