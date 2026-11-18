import { describe, expect, it } from "vitest";
import { pillView } from "./pill";

const base = { pending: 0, bugs: 0, working: false, unread: false, actions: 0 };

describe("pillView", () => {
  it("a riposo: solo «Botcave», niente contatore né LED", () => {
    expect(pillView(base, false)).toEqual({ label: "Botcave", count: null, led: null });
  });

  it("con azioni sulla pagina: «Botcave · N azioni»", () => {
    expect(pillView({ ...base, actions: 2 }, false).label).toBe("Botcave · 2 azioni");
    expect(pillView({ ...base, actions: 1 }, false).label).toBe("Botcave · 1 azione");
  });

  it("stretto: solo il segno, il contatore resta", () => {
    expect(pillView({ ...base, actions: 2, pending: 1 }, true)).toEqual({ label: "", count: 1, led: null });
  });

  it("contatore = voci da confermare più segnalazioni", () => {
    expect(pillView({ ...base, pending: 2, bugs: 3 }, false).count).toBe(5);
    expect(pillView({ ...base, pending: 0, bugs: 0 }, false).count).toBeNull();
  });

  it("LED: work vince su ask", () => {
    expect(pillView({ ...base, working: true, unread: true }, false).led).toBe("work");
    expect(pillView({ ...base, unread: true }, false).led).toBe("ask");
    expect(pillView({ ...base, working: true }, false).led).toBe("work");
  });
});
