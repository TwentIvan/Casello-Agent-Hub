import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTunnel } from "./tunnel";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "collaudo-tunnel-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeBin(body: string): Promise<string> {
  const bin = path.join(dir, `cf-${Math.random().toString(36).slice(2)}`);
  await writeFile(bin, `#!/bin/bash\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe("startTunnel", () => {
  it("legge l'indirizzo trycloudflare dall'uscita", async () => {
    const bin = await fakeBin('echo "INF connesso" >&2; echo "INF |  https://alfa-beta-42.trycloudflare.com  |" >&2; echo "$4" > /dev/null; sleep 30');
    const t = await startTunnel(bin, 4321, 5_000);
    expect(t.url).toBe("https://alfa-beta-42.trycloudflare.com");
    t.close();
  });

  it("salta api.trycloudflare.com e prende l'indirizzo del tunnel", async () => {
    const bin = await fakeBin('echo "ERR richiesta a https://api.trycloudflare.com/tunnel" >&2; echo "INF |  https://gamma-7.trycloudflare.com  |" >&2; sleep 30');
    const t = await startTunnel(bin, 4321, 5_000);
    expect(t.url).toBe("https://gamma-7.trycloudflare.com");
    t.close();
  });

  it("processo che esce senza indirizzo → errore", async () => {
    const bin = await fakeBin("echo nulla; exit 1");
    await expect(startTunnel(bin, 4321, 5_000)).rejects.toThrow("il tunnel non ha dato un indirizzo");
  });
});
