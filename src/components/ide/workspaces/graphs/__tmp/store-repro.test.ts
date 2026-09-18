import { expect, test, vi } from "vitest";

test("inputs survive the autosave round trip", async () => {
  let stored: Record<string, unknown> = {
    id: "g1",
    projectId: "p1",
    name: "g",
    description: "",
    entryNodeId: null,
    inputs: [],
    nodes: [],
    edges: [],
    createdAt: "",
    updatedAt: "",
  };
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/save")) {
      stored = { ...stored, ...body, id: "g1" };
    }
    const payload = url.endsWith("/list")
      ? { graphs: [stored] }
      : { graph: stored, validation: { errors: [], warnings: [] } };
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
  });
  const { useGraphStore } = await import("../graph-store");
  await useGraphStore.getState().loadGraphs("p1");
  useGraphStore.getState().updateGraphDefinition("g1", (graph) => ({
    ...graph,
    inputs: [
      {
        description: "",
        key: "input1",
        label: "",
        options: [],
        required: true,
        type: "text",
      },
    ],
  }));
  await useGraphStore.getState().saveGraph("g1");
  expect(useGraphStore.getState().graphsById.g1.inputs).toHaveLength(1);
});
