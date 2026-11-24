// Espressioni cron a 5 campi per le run programmate (issue #107), valutate nell'ora italiana (puro, senza DB).
// Campi: minuto (0-59), ora (0-23), giorno del mese (1-31), mese (1-12), giorno della settimana (0-7, 0 e 7 = domenica).
// Ogni campo: `*`, numeri, intervalli `a-b`, elenchi con la virgola, passi `*/n` e `a-b/n`. Come in cron, se giorno del
// mese e giorno della settimana sono entrambi ristretti basta che uno dei due corrisponda.
// Cambio dell'ora: un orario che non esiste (salto di primavera) scatta all'ora spostata, uno ripetuto (autunno) una volta.

export const CRON_TIME_ZONE = "Europe/Rome";
/** Distanza minima tra due run programmate: una run costa, niente cron ogni minuto. */
export const MIN_CRON_GAP_MINUTES = 5;
const MAX_CRON_LENGTH = 100;
/** Giorni esaminati per la prossima occorrenza: 8 anni coprono anche il 29 febbraio. */
const MAX_SEARCH_DAYS = 8 * 366;
/** Occorrenze controllate per la distanza minima. */
const GAP_SAMPLES = 50;

export type CronSpec = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

function parseField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    let from = min;
    let to = max;
    if (m[1] !== "*") {
      from = Number(m[2]);
      to = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Espressione valida → specifica; altrimenti null. */
export function parseCron(expr: string): CronSpec | null {
  if (typeof expr !== "string" || expr.length > MAX_CRON_LENGTH) return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(mi, 0, 59);
  const hours = parseField(h, 0, 23);
  const days = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  const weekdays = parseField(dow, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => (d === 7 ? 0 : d))),
    daysRestricted: dom !== "*",
    weekdaysRestricted: dow !== "*",
  };
}

/** Espressione normalizzata: spazi singoli. */
export function normalizeCron(expr: string): string {
  return expr.trim().split(/\s+/).join(" ");
}

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CRON_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(ms: number): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute! };
}

/** Scarto in millisecondi tra ora italiana e UTC in quell'istante (a minuti interi). */
function offsetAt(ms: number): number {
  const p = localParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/** Istante di un orario italiano (mese 1-12). */
function localToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetAt(guess);
  let t = guess - first;
  const second = offsetAt(t);
  if (second !== first) t = guess - second;
  return t;
}

function dayMatches(spec: CronSpec, month: number, day: number, weekday: number): boolean {
  if (!spec.months.has(month)) return false;
  const byDay = spec.days.has(day);
  const byWeekday = spec.weekdays.has(weekday);
  if (spec.daysRestricted && spec.weekdaysRestricted) return byDay || byWeekday;
  return byDay && byWeekday;
}

/** Prima occorrenza strettamente dopo `after`, o null se non scatta mai. */
export function nextCronTime(spec: CronSpec, after: Date): Date | null {
  const afterMs = after.getTime();
  const start = localParts(afterMs);
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dayMatches(spec, month, day, date.getUTCDay())) continue;
    for (const hour of spec.hours) {
      // Nel primo giorno le ore già passate si saltano (con un'ora di margine per il cambio dell'ora).
      if (i === 0 && hour < start.hour - 1) continue;
      for (const minute of spec.minutes) {
        const t = localToUtc(year, month, day, hour, minute);
        if (t > afterMs) return new Date(t);
      }
    }
  }
  return null;
}

export type CronCheck = { ok: true; cron: string; spec: CronSpec } | { ok: false; reason: "invalid" | "never" | "tooFrequent" };

/** Validazione completa: forma, almeno un'occorrenza, distanza minima tra le prossime occorrenze. */
export function checkCron(expr: string, now: Date = new Date()): CronCheck {
  const spec = parseCron(expr);
  if (!spec) return { ok: false, reason: "invalid" };
  let previous = nextCronTime(spec, now);
  if (!previous) return { ok: false, reason: "never" };
  for (let i = 0; i < GAP_SAMPLES; i++) {
    const next = nextCronTime(spec, previous);
    if (!next) break;
    if (next.getTime() - previous.getTime() < MIN_CRON_GAP_MINUTES * 60_000) return { ok: false, reason: "tooFrequent" };
    previous = next;
  }
  return { ok: true, cron: normalizeCron(expr), spec };
}

/** Data e ora italiane per l'input della run, es. «24/11/2026 08:00». */
export function formatLocal(date: Date): string {
  const p = localParts(date.getTime());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}
