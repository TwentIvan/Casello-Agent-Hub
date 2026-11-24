import { describe, expect, it } from "vitest";
import { attachmentFileError, attachmentsBlockSend, formatBytes, messageBody } from "./chat-attachments";

describe("allegati delle chat (console)", () => {
  it("controlla tipo, dimensione e numero prima del caricamento", () => {
    expect(attachmentFileError({ name: "a.png", type: "image/png", size: 10 }, 0)).toBeNull();
    expect(attachmentFileError({ name: "b.pdf", type: "application/pdf", size: 10 }, 4)).toBeNull();
    expect(attachmentFileError({ name: "c.gif", type: "image/gif", size: 10 }, 0)).toBe("«c.gif»: allega immagini PNG, JPEG o WebP oppure PDF");
    expect(attachmentFileError({ name: "d.png", type: "image/png", size: 11 * 1024 * 1024 }, 0)).toBe("«d.png» pesa 11 MB: il massimo è 10 MB per file");
    expect(attachmentFileError({ name: "e.png", type: "image/png", size: 0 }, 0)).toBe("«e.png» è vuoto");
    expect(attachmentFileError({ name: "f.png", type: "image/png", size: 1 }, 5)).toBe("Al massimo 5 allegati per messaggio");
  });

  it("corpo del messaggio: gli allegati vanno sempre con il modo normale", () => {
    expect(messageBody("ciao")).toEqual({ content: "ciao" });
    expect(messageBody("ciao", "queue")).toEqual({ content: "ciao", mode: "queue" });
    expect(messageBody("ciao", "normal", [])).toEqual({ content: "ciao" });
    expect(messageBody("guarda", "now", [3, 4])).toEqual({ content: "guarda", attachmentIds: [3, 4] });
  });

  it("con allegati pronti non si manda durante il turno", () => {
    expect(attachmentsBlockSend(1, true)).toBe(true);
    expect(attachmentsBlockSend(1, false)).toBe(false);
    expect(attachmentsBlockSend(0, true)).toBe(false);
    expect(formatBytes(512)).toBe("512 B");
  });
});
