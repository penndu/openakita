import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatTodo } from "../chatTypes";
import { hasRenderableBody, resolveMessageParts } from "../messageParts";

const todo: ChatTodo = {
  id: "plan-1",
  taskSummary: "Ship the feature",
  status: "in_progress",
  steps: [
    { id: "s1", description: "Inspect", status: "completed" },
    { id: "s2", description: "Patch", status: "in_progress" },
  ],
};

describe("message parts projection", () => {
  it("heals explicit todo-only parts with normal text and tool blocks", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      content: "Done",
      timestamp: 1,
      todo,
      toolCalls: [
        {
          id: "tool-1",
          tool: "read_file",
          args: { path: "src/app.ts" },
          result: "ok",
          status: "done",
        },
      ],
      parts: [{ kind: "plan", id: "plan:plan-1", todo }],
    };

    expect(resolveMessageParts(msg).map((part) => part.kind)).toEqual(["plan", "text", "tools"]);
  });

  it("heals explicit todo-only parts with a hidden reasoning chain marker", () => {
    const msg: ChatMessage = {
      id: "m2",
      role: "assistant",
      content: "",
      timestamp: 1,
      todo,
      thinkingChain: [
        {
          iteration: 1,
          collapsed: false,
          hasThinking: false,
          toolCalls: [],
          entries: [{ kind: "text", content: "About to inspect files" }],
        },
      ],
      parts: [{ kind: "plan", id: "plan:plan-1", todo }],
    };

    expect(resolveMessageParts(msg).map((part) => part.kind)).toEqual(["reasoning", "plan"]);
  });

  it("does not treat plan cards as assistant message body", () => {
    const msg: ChatMessage = {
      id: "m3",
      role: "assistant",
      content: "",
      timestamp: 1,
      todo,
      parts: [{ kind: "plan", id: "plan:plan-1", todo }],
    };
    const parts = resolveMessageParts(msg);

    expect(hasRenderableBody(msg, parts, true, "")).toBe(false);
  });
});
