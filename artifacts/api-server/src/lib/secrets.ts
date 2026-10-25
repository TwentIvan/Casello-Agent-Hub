import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Cifratura dei segreti a riposo: AES-256-GCM, formato `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
// La chiave è CASELLO_SECRET_KEY: 64 caratteri esadecimali (openssl rand -hex 32).

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

function getKey(): Buffer {
  const raw = process.env["CASELLO_SECRET_KEY"];
  if (!raw) {
    throw new Error("CASELLO_SECRET_KEY è obbligatoria (64 caratteri esadecimali)");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("CASELLO_SECRET_KEY non valida: servono 64 caratteri esadecimali");
  }
  return Buffer.from(raw, "hex");
}

/** Lancia se CASELLO_SECRET_KEY manca o non è di 64 caratteri esadecimali. */
export function assertSecretKey(): void {
  getKey();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(enc: string): string {
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Formato del segreto cifrato non riconosciuto");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ciphertext = Buffer.from(parts[3]!, "base64");
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
