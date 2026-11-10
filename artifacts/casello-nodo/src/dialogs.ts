import { execFile } from "node:child_process";

/** Dialoghi e notifiche nativi dell'app (macOS, `osascript`); iniettabili nei test. */
export interface Dialogs {
  alert(text: string): Promise<void>;
  notify(title: string, text: string): Promise<void>;
  /** Percorso POSIX della cartella scelta, senza `/` finale; null se annullato. */
  chooseFolder(prompt: string, defaultDir: string): Promise<string | null>;
  /** Voce scelta; null se annullato. */
  chooseFromList(prompt: string, items: string[]): Promise<string | null>;
  /** true se l'utente preme `okLabel`; false se annulla. */
  confirm(text: string, okLabel: string): Promise<boolean>;
}

/** Come `child_process.execFile` con callback (senza opzioni): iniettabile nei test, mai il vero `osascript`. */
export type ExecFileLike = (
  file: string,
  args: string[],
  callback: (err: (Error & { code?: number | string | null }) | null, stdout: string, stderr: string) => void,
) => unknown;

const OSASCRIPT = "/usr/bin/osascript";
const TITLE = "Botcave Nodo";

const realExecFile: ExecFileLike = (file, args, cb) =>
  execFile(file, args, { encoding: "utf8" }, (err, stdout, stderr) => cb(err, String(stdout), String(stderr)));

/** Testo dentro una stringa AppleScript fra virgolette: si escapano barra rovesciata e virgolette. */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const q = (text: string) => `"${escapeAppleScript(text)}"`;

/** L'utente ha annullato (`osascript` esce 1 con «User canceled.» / -128). */
class CanceledError extends Error {}

function isCanceled(err: { code?: number | string | null }, stderr: string): boolean {
  return err.code === 1 && /User canceled|\(-128\)/.test(stderr);
}

/**
 * Dialoghi con `osascript`: ogni riga dello script è un argomento `-e` (mai una shell), i testi sono stringhe
 * AppleScript escapate. `activate` porta il dialogo davanti alle altre finestre.
 */
export function osascriptDialogs(run: ExecFileLike = realExecFile): Dialogs {
  const exec = (lines: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      run(
        OSASCRIPT,
        lines.flatMap((l) => ["-e", l]),
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout.replace(/\n$/, ""));
          if (isCanceled(err, stderr)) return reject(new CanceledError());
          // Il testo di osascript non si inoltra: può contenere i testi dei dialoghi
          reject(new Error("dialogo non riuscito"));
        },
      );
    });
  const orCanceled = async <T>(p: Promise<T>, canceled: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof CanceledError) return canceled;
      throw e;
    }
  };

  return {
    async alert(text) {
      await orCanceled(
        exec(["activate", `display dialog ${q(text)} buttons {"OK"} default button "OK" with title ${q(TITLE)}`]),
        "",
      );
    },
    async notify(title, text) {
      await exec([`display notification ${q(text)} with title ${q(title)}`]);
    },
    async chooseFolder(prompt, defaultDir) {
      const out = await orCanceled<string | null>(
        exec([
          "activate",
          `POSIX path of (choose folder with prompt ${q(prompt)} default location (POSIX file ${q(defaultDir)}))`,
        ]),
        null,
      );
      if (!out) return null;
      return out.length > 1 ? out.replace(/\/+$/, "") : out;
    },
    async chooseFromList(prompt, items) {
      const out = await orCanceled<string | null>(
        exec([
          "activate",
          `choose from list {${items.map(q).join(", ")}} with prompt ${q(prompt)} with title ${q(TITLE)} OK button name "Scegli" cancel button name "Chiudi"`,
        ]),
        null,
      );
      // Annullato: `choose from list` restituisce false
      return out !== null && items.includes(out) ? out : null;
    },
    async confirm(text, okLabel) {
      const out = await orCanceled<string | null>(
        exec([
          "activate",
          `display dialog ${q(text)} buttons {"Annulla", ${q(okLabel)}} default button ${q(okLabel)} cancel button "Annulla" with title ${q(TITLE)} with icon caution`,
        ]),
        null,
      );
      return out === `button returned:${okLabel}`;
    },
  };
}
