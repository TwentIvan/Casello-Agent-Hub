import { describe, expect, it } from "vitest";
import { AUDIT_ROUTES, auditEventFor, matchAuditRoute } from "./actions";

describe("route del registro delle azioni", () => {
  it("riconosce metodo e percorso e prende l'id dal percorso", () => {
    const m = matchAuditRoute("delete", "/account/tokens/12");
    expect(m?.route.action).toBe("api_token.revoke");
    expect(auditEventFor(m!, undefined, undefined)).toEqual({
      action: "api_token.revoke",
      objectType: "api_token",
      objectId: "12",
      detail: null,
    });
    expect(matchAuditRoute("GET", "/account/tokens/12")).toBeNull();
    expect(matchAuditRoute("DELETE", "/account/tokens/12/altro")).toBeNull();
    expect(matchAuditRoute("POST", "/apps/3/evolution/stop")?.route.action).toBe("evolution.stop");
    // `/apps/:id` non cattura le sotto-route
    expect(matchAuditRoute("PATCH", "/apps/3/bug-settings")?.route.action).toBe("app.bug_settings.update");
  });

  it("creazione di un token: id dalla risposta, ambiti dal corpo, mai il valore del token", () => {
    const m = matchAuditRoute("POST", "/account/tokens")!;
    const event = auditEventFor(
      m,
      { name: "cas_segreto", scopes: ["api:read", "inventato"] },
      { token: "cas_abcdefghijklmnopqrstuvwxyz0123456789", info: { id: 7 } },
    );
    expect(event).toEqual({ action: "api_token.create", objectType: "api_token", objectId: "7", detail: { scopes: ["api:read"] } });
    expect(JSON.stringify(event)).not.toContain("cas_");
  });

  it("decisioni: l'azione dipende dalla scelta, valori fuori elenco ignorati", () => {
    const plan = matchAuditRoute("POST", "/plan-proposals/4/decision")!;
    expect(auditEventFor(plan, { action: "accept" }, {}).action).toBe("plan_proposal.accept");
    expect(auditEventFor(plan, { action: "altro" }, {}).action).toBe("plan_proposal.decide");
    const item = matchAuditRoute("PATCH", "/analysis-items/9")!;
    expect(auditEventFor(item, { status: "approved" }, {}).action).toBe("analysis_item.approve");
    expect(auditEventFor(item, { reviewNote: "x" }, {}).action).toBe("analysis_item.update");
  });

  it("voce della coda: tipo ed esito dalla risposta, solo il numero dei passi esclusi", () => {
    const m = matchAuditRoute("POST", "/pending-actions/5/approve")!;
    const event = auditEventFor(m, { userToken: "segreto", escludi: ["p2"] }, { kind: "proposal", status: "done", result: "dati" });
    expect(event).toEqual({
      action: "pending_action.approve",
      objectType: "pending_action",
      objectId: "5",
      detail: { kind: "proposal", status: "done", excludedSteps: 1 },
    });
    expect(JSON.stringify(event)).not.toContain("segreto");
  });

  it("segreti: solo se sono cambiati, mai il valore; abbinamento senza codice", () => {
    const app = matchAuditRoute("PATCH", "/apps/2")!;
    expect(auditEventFor(app, { serviceSecret: "thu_xyz", name: "A" }, {}).detail).toEqual({
      serviceSecretChanged: true,
      sourceTokenChanged: false,
    });
    const pair = matchAuditRoute("POST", "/account/node-pairings/ABCD-EFGH/approve")!;
    const event = auditEventFor(pair, { name: "Mac", replaceNodeId: 3 }, { status: "approved" });
    expect(event).toMatchObject({ action: "node_pairing.approve", objectId: "3", detail: { replace: true } });
    expect(JSON.stringify(event)).not.toContain("ABCD");
    const deny = auditEventFor(matchAuditRoute("POST", "/account/node-pairings/ABCD-EFGH/deny")!, {}, {});
    expect(deny.objectId).toBeNull();
  });

  it("ogni route ha un'azione e un metodo di scrittura", () => {
    for (const r of AUDIT_ROUTES) {
      expect(r.action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(["POST", "PUT", "PATCH", "DELETE"]).toContain(r.method);
    }
  });
});
