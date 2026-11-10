import { describe, expect, it } from "vitest";
import { NODE_PROVIDER, isNodeAccount, withoutNodeModels } from "./node-models";

// Modelli Claude Code (nodo) fuori dalle tendine dei consumatori che girano solo nel cloud.

const group = (id: number, provider: string, modelIds: number[]) => ({
  account: { id, provider },
  models: modelIds.map((m) => ({ id: m })),
});

describe("withoutNodeModels", () => {
  it("toglie i gruppi degli account Claude Code (nodo) e lascia gli altri nell'ordine", () => {
    const groups = [group(1, "deepseek", [10, 11]), group(2, NODE_PROVIDER, [20]), group(3, "custom", [30])];
    expect(withoutNodeModels(groups).map((g) => g.account.id)).toEqual([1, 3]);
    expect(withoutNodeModels(groups)[0]!.models).toEqual([{ id: 10 }, { id: 11 }]);
  });

  it("isNodeAccount riconosce solo il provider del nodo", () => {
    expect(isNodeAccount({ provider: "claude_code_node" })).toBe(true);
    expect(isNodeAccount({ provider: "anthropic" })).toBe(false);
  });
});
