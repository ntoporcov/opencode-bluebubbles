import { describe, expect, test } from "bun:test";
import {
  KeyedConcurrencyQueue,
  OpenCodeAdapter,
  type ApiResult,
  type MessageEnvelope,
  type OpenCodeClient,
  extractAssistantText,
  isMissingSessionError,
} from "../src/sessions";

type Call = { method: string; options: unknown };

function fakeClient(overrides: {
  prompt?: (options: Parameters<OpenCodeClient["session"]["prompt"]>[0]) => Promise<ApiResult<MessageEnvelope>>;
  messages?: MessageEnvelope[];
  createResult?: ApiResult<{ id: string }>;
} = {}): { client: OpenCodeClient; calls: Call[] } {
  const calls: Call[] = [];
  const record = <T>(method: string, options: unknown, result: ApiResult<T>): Promise<ApiResult<T>> => {
    calls.push({ method, options });
    return Promise.resolve(result);
  };
  const assistant: MessageEnvelope = {
    info: { role: "assistant" },
    parts: [{ type: "text", text: "answer" }],
  };
  return {
    calls,
    client: {
      session: {
        create: (options) => record("create", options, overrides.createResult ?? { data: { id: "session-1" } }),
        prompt: overrides.prompt ?? ((options) => record("prompt", options, { data: assistant })),
        messages: (options) => record("messages", options, { data: overrides.messages ?? [] }),
      },
      tui: {
        showToast: (options) => record("toast", options, { data: true }),
      },
      app: {
        log: (options) => record("log", options, { data: true }),
      },
      postSessionIdPermissionsPermissionId: (options) => record("permission", options, { data: true }),
    },
  };
}

describe("OpenCodeAdapter", () => {
  test("uses the legacy client shapes for sessions, toast, logs, and permissions", async () => {
    const { client, calls } = fakeClient();
    const adapter = new OpenCodeAdapter(client, { service: "bridge" });

    expect(await adapter.createTitledSession("Remote chat")).toBe("session-1");
    await adapter.insertNoReplyText("admin", "quoted review data");
    await adapter.showToast({ title: "Review", message: "Open the review", variant: "warning", duration: 5000 });
    await adapter.log({ level: "info", message: "review created", extra: { reviewID: "review-1" } });
    await adapter.replyPermission("remote", "permission-1", "once");

    expect(calls).toEqual([
      { method: "create", options: { body: { title: "Remote chat" } } },
      { method: "prompt", options: { path: { id: "admin" }, body: { noReply: true, parts: [{ type: "text", text: "quoted review data" }] } } },
      { method: "toast", options: { body: { title: "Review", message: "Open the review", variant: "warning", duration: 5000 } } },
      { method: "log", options: { body: { service: "bridge", level: "info", message: "review created", extra: { reviewID: "review-1" } } } },
      { method: "permission", options: { path: { id: "remote", permissionID: "permission-1" }, body: { response: "once" } } },
    ]);
  });

  test("extracts only non-ignored assistant text in part order", () => {
    expect(extractAssistantText({
      info: { role: "assistant" },
      parts: [
        { type: "reasoning", text: "secret reasoning" },
        { type: "text", text: "first" },
        { type: "text", text: "ignored", ignored: true },
        { type: "tool", text: "tool output" },
        { type: "text", text: " second" },
      ],
    })).toBe("first second");
    expect(extractAssistantText({ info: { role: "user" }, parts: [{ type: "text", text: "untrusted" }] })).toBe("");
  });

  test("prompts the selected agent and returns safe assistant text", async () => {
    const { client, calls } = fakeClient({
      prompt: async (options) => {
        calls.push({ method: "prompt", options });
        return {
          data: {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "ok" }, { type: "text", text: "hidden", ignored: true }],
          },
        };
      },
    });
    const adapter = new OpenCodeAdapter(client);

    expect(await adapter.promptRemoteAgent({
      relationshipKey: "relationship",
      sessionID: "remote",
      text: "request",
      agent: "bluebubbles-remote",
    })).toBe("ok");
    expect(calls[0]).toEqual({
      method: "prompt",
      options: {
        path: { id: "remote" },
        body: { agent: "bluebubbles-remote", parts: [{ type: "text", text: "request" }] },
      },
    });
  });

  test("finds the latest user-authored non-ignored text", async () => {
    const { client } = fakeClient({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "older" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "APPROVE " }, { type: "text", text: "ignored", ignored: true }, { type: "text", text: "K7M4" }] },
      ],
    });
    expect(await new OpenCodeAdapter(client).latestUserText("review")).toBe("APPROVE K7M4");
  });

  test("checks generated error fields without exposing their contents", async () => {
    const secret = "token=very-secret request text";
    const { client } = fakeClient({ createResult: { error: { message: secret } } });

    await expect(new OpenCodeAdapter(client).createTitledSession(secret)).rejects.toThrow("OpenCode create session failed");
    try {
      await new OpenCodeAdapter(client).createTitledSession(secret);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("very-secret");
    }
  });

  test("preserves missing-session classification for typed SDK errors", async () => {
    const secret = "Session not found: private-session-id";
    const { client } = fakeClient({
      prompt: async () => ({ error: { name: "NotFoundError", data: { message: secret } } }),
    });

    try {
      await new OpenCodeAdapter(client).promptRemoteAgent({
        relationshipKey: "relationship",
        sessionID: "missing",
        text: "request",
      });
      throw new Error("Expected prompt to fail");
    } catch (error) {
      expect(isMissingSessionError(error)).toBe(true);
      expect(String(error)).toContain("OpenCode prompt remote agent failed: 404");
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("private-session-id");
    }
  });

  test("allows permission replies only once or reject at the type boundary", async () => {
    const { client, calls } = fakeClient();
    const adapter = new OpenCodeAdapter(client);
    await adapter.replyPermission("session", "p1", "reject");
    expect(calls[0]).toEqual({
      method: "permission",
      options: { path: { id: "session", permissionID: "p1" }, body: { response: "reject" } },
    });
    await expect(adapter.replyPermission("session", "p2", "always" as never)).rejects.toThrow("permission response must be once or reject");
    expect(calls).toHaveLength(1);
  });
});

describe("KeyedConcurrencyQueue", () => {
  test("is FIFO per key, bounded globally, and cleans up completed keys", async () => {
    const queue = new KeyedConcurrencyQueue(2);
    const order: string[] = [];
    let running = 0;
    let maximumRunning = 0;
    const releases: Array<() => void> = [];
    const task = (name: string) => async () => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      order.push(`start:${name}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`end:${name}`);
      running -= 1;
      return name;
    };

    const a1 = queue.run("a", task("a1"));
    const a2 = queue.run("a", task("a2"));
    const b1 = queue.run("b", task("b1"));
    const c1 = queue.run("c", task("c1"));
    await Promise.resolve();
    expect(order).toEqual(["start:a1", "start:b1"]);
    expect(queue.activeCount).toBe(2);

    releases.shift()?.();
    await a1;
    await Promise.resolve();
    expect(order).toContain("start:c1");
    expect(order).not.toContain("start:a2");

    releases.shift()?.();
    await b1;
    await Promise.resolve();
    expect(order).toContain("start:a2");

    while (releases.length > 0) releases.shift()?.();
    expect(await Promise.all([a2, c1])).toEqual(["a2", "c1"]);
    expect(maximumRunning).toBe(2);
    expect(queue.activeCount).toBe(0);
    expect(queue.keyCount).toBe(0);
  });

  test("continues and cleans up after a rejected task", async () => {
    const queue = new KeyedConcurrencyQueue(1);
    const first = queue.run("same", () => { throw new Error("failure"); });
    const second = queue.run("same", () => "next");
    await expect(first).rejects.toThrow("failure");
    expect(await second).toBe("next");
    expect(queue.keyCount).toBe(0);
  });
});
