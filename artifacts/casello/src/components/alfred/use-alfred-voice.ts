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
export type AlfredErrorKind = "mic" | "model" | "elsewhere" | "other";
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
const MAX_RECONNECTS = 3;
const ELSEWHERE = "Alfred è stato aperto su un altro dispositivo.";

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
    playHead: 0,
    sources: [] as AudioBufferSourceNode[],
    sessionId: 0,
    model: "",
    handle: null as string | null,
    reconnects: 0,
    inText: "",
    outText: "",
    lineId: 0,
    prompt: 0,
    completion: 0,
    sentPrompt: 0,
    sentCompletion: 0,
    lastUsageAt: 0,
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

  const elsewhere = useCallback(() => fail("elsewhere", ELSEWHERE), [fail]);

  const sendUsage = useCallback(async (): Promise<void> => {
    const s = r.current;
    if (s.usageTimer) clearTimeout(s.usageTimer);
    s.usageTimer = null;
    if (!s.sessionId || (s.prompt === s.sentPrompt && s.completion === s.sentCompletion)) return;
    const body = { promptTokens: s.prompt, completionTokens: s.completion };
    s.lastUsageAt = Date.now();
    s.sentPrompt = body.promptTokens;
    s.sentCompletion = body.completionTokens;
    try {
      await api.current.recordUsage.mutateAsync({ id: s.sessionId, data: body });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && s.active) elsewhere();
    }
  }, [elsewhere]);

  const scheduleUsage = useCallback(() => {
    const s = r.current;
    if (s.usageTimer) return;
    const wait = Math.max(0, USAGE_EVERY_MS - (Date.now() - s.lastUsageAt));
    s.usageTimer = setTimeout(() => void sendUsage(), wait);
  }, [sendUsage]);

  const handleFrame = useCallback(
    async (gen: number, ws: WebSocket, msg: Frame) => {
      const s = r.current;
      if (msg.setupComplete) {
        s.ready = true;
        s.reconnects = 0;
        setStatus("listening");
        // Solo alla prima apertura: dopo una ripresa la conversazione continua da sola
        if (!s.handle) ws.send(JSON.stringify({ realtimeInput: { text: "[apertura]" } }));
        return;
      }
      if (msg.sessionResumptionUpdate?.newHandle) s.handle = msg.sessionResumptionUpdate.newHandle;
      if (msg.usageMetadata) {
        const u = msg.usageMetadata;
        s.prompt = Math.max(s.prompt, u.promptTokenCount ?? 0);
        s.completion = Math.max(s.completion, u.responseTokenCount ?? u.candidatesTokenCount ?? 0);
        scheduleUsage();
      }
      if (msg.goAway) {
        void reconnect(gen);
        return;
      }
      if (msg.toolCall?.functionCalls) {
        const responses: { id: string; name: string; response: unknown }[] = [];
        for (const fc of msg.toolCall.functionCalls) {
          try {
            const result = await api.current.runTool.mutateAsync({ id: s.sessionId, name: fc.name, data: { args: fc.args ?? {} } });
            responses.push({ id: fc.id, name: fc.name, response: result });
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) {
              if (s.gen === gen) elsewhere();
              return;
            }
            responses.push({ id: fc.id, name: fc.name, response: { ok: false, error: apiErrorMessage(e) } });
          }
          if (s.gen !== gen) return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.interrupted) {
        stopPlayback();
        flushTurn();
        setStatus("listening");
      }
      if (sc.inputTranscription?.text) s.inText += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) s.outText += sc.outputTranscription.text;
      for (const part of sc.modelTurn?.parts ?? []) if (part.inlineData?.data) playPcm(part.inlineData.data);
      if (sc.turnComplete) flushTurn();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elsewhere, flushTurn, playPcm, scheduleUsage, stopPlayback],
  );

  const connect = useCallback(
    (token: string) => {
      const s = r.current;
      const gen = ++s.gen;
      s.ready = false;
      const ws = new WebSocket(`${GEMINI_WS}?access_token=${encodeURIComponent(token)}`);
      s.ws = ws;
      ws.onopen = () => {
        // Tutta la configurazione sta nel token: il setup porta solo il modello (e l'handle della ripresa)
        const setup: Record<string, unknown> = { model: `models/${s.model}` };
        if (s.handle) setup.sessionResumption = { handle: s.handle };
        ws.send(JSON.stringify({ setup }));
      };
      ws.onmessage = (ev) => {
        void (async () => {
          try {
            const text = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
            if (s.gen === gen) await handleFrame(gen, ws, JSON.parse(text) as Frame);
          } catch {
            /* messaggio non leggibile: si ignora */
          }
        })();
      };
      ws.onerror = () => undefined;
      ws.onclose = () => {
        if (s.gen !== gen || !s.active) return;
        // Chiusura inattesa: se la ripresa non è partita si riparte da capo, altrimenti si riprende
        if (!s.ready) s.handle = null;
        void reconnect(gen);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleFrame],
  );

  const reconnect = useCallback(
    async (fromGen: number): Promise<void> => {
      const s = r.current;
      if (!s.active || s.gen !== fromGen) return;
      if (s.reconnects >= MAX_RECONNECTS) {
        fail("other", "Connessione con Gemini persa. Riprova.");
        return;
      }
      s.reconnects++;
      s.gen++; // il vecchio socket non conta più
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
      setStatus("connecting");
      stopPlayback();
      const gen = s.gen;
      try {
        // Il token è a uso singolo: per ricollegarsi ne serve uno nuovo
        const session = await api.current.renewSession.mutateAsync({ id: s.sessionId });
        if (!s.active || s.gen !== gen) return;
        s.model = session.model;
        connect(session.token);
      } catch (e) {
        if (!s.active || s.gen !== gen) return;
        if (e instanceof ApiError && e.status === 404) elsewhere();
        else fail("other", apiErrorMessage(e));
      }
    },
    [connect, elsewhere, fail, stopPlayback],
  );

  const start = useCallback(async () => {
    const s = r.current;
    if (s.active) return;
    setError(null);
    setLines([]);
    setStatus("connecting");
    s.active = true;
    s.handle = null;
    s.reconnects = 0;
    s.prompt = s.completion = s.sentPrompt = s.sentCompletion = 0;
    s.lastUsageAt = 0;
    s.inText = s.outText = "";
    const gen = s.gen;
    try {
      const ctx = new AudioContext();
      s.ctx = ctx;
      await ctx.resume();
      try {
        s.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (e) {
        fail("mic", micErrorMessage(e));
        return;
      }
      const url = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const session = await api.current.startSession.mutateAsync();
      if (!s.active || s.gen !== gen) {
        // Fermato mentre si collegava: la sessione appena creata va chiusa
        void api.current.closeSession.mutateAsync({ id: session.sessionId }).catch(() => undefined);
        return;
      }
      s.sessionId = session.sessionId;
      s.model = session.model;
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
      ctx.createMediaStreamSource(s.mic).connect(node);
      connect(session.token);
    } catch (e) {
      if (!s.active) return;
      const message = apiErrorMessage(e);
      const isModel = e instanceof ApiError && e.status === 409 && /modello di Alfred/i.test(message);
      fail(isModel ? "model" : "other", message);
    }
  }, [connect, fail]);

  const stop = useCallback(async () => {
    const s = r.current;
    if (!s.active) return;
    const id = s.sessionId;
    await sendUsage();
    teardown();
    flushTurn();
    setStatus("stopped");
    if (id) await api.current.closeSession.mutateAsync({ id }).catch(() => undefined);
  }, [flushTurn, sendUsage, teardown]);

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
