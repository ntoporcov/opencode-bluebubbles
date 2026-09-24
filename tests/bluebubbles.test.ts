import { describe, expect, test } from "bun:test";
import {
  BlueBubblesClient,
  BlueBubblesHttpError,
  type BlueBubblesSocket,
  type Fetch,
  type SocketFactory,
} from "../src/bluebubbles";

const config = {
  serverUrl: "https://blue.example/base?client=test",
  password: "do-not-leak",
  sendMethod: "private-api" as const,
  catchupPageSize: 2,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const message = (guid: string, dateCreated: number) => ({
  guid,
  text: guid,
  dateCreated,
  isFromMe: false,
  handle: { address: "person@example.com" },
  chats: [{ guid: "chat", style: 45 }],
  serverExtra: true,
});

describe("BlueBubblesClient REST", () => {
  test("authenticates ping and server info only at the fetch boundary", async () => {
    const seen: URL[] = [];
    const fakeFetch: Fetch = async (input) => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname.endsWith("/ping")) return json({ status: 200, message: "pong", data: null, extra: true });
      return json({
        status: 200,
        message: "ok",
        data: { private_api: true, helper_connected: true, server_version: "1.9.9" },
        extra: true,
      });
    };
    const client = new BlueBubblesClient(config, { fetch: fakeFetch });

    expect(config.serverUrl).not.toContain(config.password);
    expect((await client.ping()).message).toBe("pong");
    expect(await client.getServerInfo()).toMatchObject({ server_version: "1.9.9" });
    expect(await client.probePrivateApiAvailability()).toBe(true);
    expect(seen).toHaveLength(3);
    for (const url of seen) {
      expect(url.searchParams.get("password")).toBe(config.password);
      expect(url.searchParams.get("client")).toBe("test");
    }
  });

  test("keeps HTTP failures and validation errors free of credentials and URLs", async () => {
    const client = new BlueBubblesClient(config, { fetch: async () => json({ error: config.password }, 401) });
    try {
      await client.ping();
      throw new Error("expected ping to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BlueBubblesHttpError);
      expect(String(error)).not.toContain(config.password);
      expect(String(error)).not.toContain(config.serverUrl);
    }

    const malformed = new BlueBubblesClient(config, {
      fetch: async () => json({ status: 200, message: "ok", data: { private_api: "yes", secret: config.password } }),
    });
    await expect(malformed.getServerInfo()).rejects.toThrow();
    try {
      await malformed.getServerInfo();
    } catch (error) {
      expect(String(error)).not.toContain(config.password);
    }

    const disconnected = new BlueBubblesClient(config, {
      fetch: async () => {
        throw new TypeError(`failed: https://blue.example/api/v1/ping?password=${config.password}`);
      },
    });
    try {
      await disconnected.ping();
    } catch (error) {
      expect(String(error)).not.toContain(config.password);
      expect(String(error)).not.toContain(`?password=`);
    }
  });

  test("rejects HTTP 200 application-level failures", async () => {
    const client = new BlueBubblesClient(config, {
      fetch: async () => json({ status: 500, message: "application failure", data: null }),
    });
    await expect(client.ping()).rejects.toThrow("BlueBubbles ping failed");

    const send = new BlueBubblesClient(config, {
      fetch: async () => json({ status: 500, message: "not sent", data: {} }),
      randomUUID: () => "application-failure",
    });
    expect(await send.sendText("chat", "message")).toMatchObject({
      status: "indeterminate",
      tempGuid: "application-failure",
      retryable: false,
    });
  });

  test("uses inclusive after, one fixed before watermark, and offset pages oldest first", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const pages = [[message("one", 10), message("two", 11)], [message("three", 12)]];
    const fakeFetch: Fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const page = pages[bodies.length - 1] ?? [];
      return json({
        status: 200,
        message: "ok",
        data: page,
        metadata: { offset: body.offset, limit: 2, total: 3, count: page.length, ignored: true },
        ignored: true,
      });
    };
    const client = new BlueBubblesClient(config, { fetch: fakeFetch, now: () => 500 });

    const result = await client.catchUp(10);
    expect(result.before).toBe(500);
    expect(result.messages.map(({ guid }) => guid)).toEqual(["one", "two", "three"]);
    expect(bodies).toEqual([
      { after: 10, before: 500, offset: 0, limit: 2, sort: "ASC", with: ["chats"] },
      { after: 10, before: 500, offset: 2, limit: 2, sort: "ASC", with: ["chats"] },
    ]);
  });

  test("sends the current text body exactly once and classifies failures", async () => {
    const calls: Array<{ url: URL; body: unknown }> = [];
    const successful = new BlueBubblesClient(config, {
      randomUUID: () => "temp-1",
      fetch: async (input, init) => {
        calls.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
        return json({ status: 200, message: "sent", data: { guid: "message-1", added: true }, extra: true });
      },
    });
    expect(await successful.sendText("iMessage;+;chat", "hello")).toEqual({
      status: "sent",
      tempGuid: "temp-1",
      data: { guid: "message-1", added: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      chatGuid: "iMessage;+;chat",
      tempGuid: "temp-1",
      message: "hello",
      method: "private-api",
    });
    expect(calls[0]?.url.pathname).toBe("/base/api/v1/message/text");

    let attempts = 0;
    const disconnected = new BlueBubblesClient(config, {
      randomUUID: () => "temp-2",
      fetch: async () => {
        attempts += 1;
        throw new TypeError(`fetch failed for https://blue.example/?password=${config.password}`);
      },
    });
    const uncertain = await disconnected.sendText("chat", "hello");
    expect(uncertain).toMatchObject({ status: "indeterminate", tempGuid: "temp-2", retryable: false });
    expect(uncertain).not.toHaveProperty("reason", expect.stringContaining(config.password));
    expect(attempts).toBe(1);

    const timedOut = new BlueBubblesClient(config, { fetch: async () => json({}, 504) });
    expect(await timedOut.sendText("chat", "hello")).toMatchObject({ status: "indeterminate", retryable: false });
    const serverFailed = new BlueBubblesClient(config, { fetch: async () => json({}, 500) });
    expect(await serverFailed.sendText("chat", "hello")).toMatchObject({ status: "indeterminate", retryable: false });
    const rejected = new BlueBubblesClient(config, { fetch: async () => json({ error: "bad request" }, 400) });
    expect(await rejected.sendText("chat", "hello")).toMatchObject({ status: "rejected", httpStatus: 400, retryable: false });
  });

  test("sends a private API tapback against the triggering message", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = new BlueBubblesClient(config, {
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
        return json({ status: 200, message: "Reaction sent!", data: { guid: "reaction-guid" } });
      },
    });
    expect(await client.reactToMessage("iMessage;+;chat", "incoming-guid", "emphasize")).toEqual({
      status: "sent",
      data: { guid: "reaction-guid" },
    });
    expect(calls).toEqual([{
      path: "/base/api/v1/message/react",
      body: {
        chatGuid: "iMessage;+;chat",
        selectedMessageGuid: "incoming-guid",
        reaction: "emphasize",
        partIndex: 0,
      },
    }]);
  });

  test("edits a sent private API message by GUID", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = new BlueBubblesClient(config, {
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
        return json({ status: 200, message: "Message edited!", data: { guid: "message-1" } });
      },
    });
    expect(await client.editMessage("message-1", "Finished webfetch ☑️")).toEqual({
      status: "sent",
      data: { guid: "message-1" },
    });
    expect(calls).toEqual([{
      path: "/base/api/v1/message/message-1/edit",
      body: {
        editedMessage: "Finished webfetch ☑️",
        backwardsCompatibilityMessage: "Finished webfetch ☑️",
        partIndex: 0,
      },
    }]);
  });
});

class FakeSocket implements BlueBubblesSocket {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  connects = 0;
  disconnects = 0;

  on(event: "connect" | "disconnect" | "new-message", listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: string): this {
    this.listeners.delete(event);
    return this;
  }

  connect(): this {
    this.connects += 1;
    return this;
  }

  disconnect(): this {
    this.disconnects += 1;
    return this;
  }

  emit(event: string, value?: unknown, callback?: (response: unknown) => void): this {
    if (event === "started-typing" || event === "stopped-typing") {
      callback?.({ status: 200, message: "ok" });
      return this;
    }
    for (const listener of this.listeners.get(event) ?? []) listener(value);
    return this;
  }
}

describe("BlueBubblesClient Socket.IO", () => {
  test("uses a credential-free URL, password auth query, and subscriptions", () => {
    const socket = new FakeSocket();
    let factoryUrl = "";
    let factoryOptions: Parameters<SocketFactory>[1] | undefined;
    const socketFactory: SocketFactory = (url, options) => {
      factoryUrl = url;
      factoryOptions = options;
      return socket;
    };
    const client = new BlueBubblesClient(config, { socketFactory, fetch: async () => json({}) });
    const events: unknown[] = [];
    client.onConnect(() => events.push("connected"));
    client.onDisconnect((reason) => events.push(reason));
    const unsubscribe = client.onMessage((payload) => events.push(payload));

    client.connect();
    expect(factoryUrl).toBe(config.serverUrl);
    expect(factoryUrl).not.toContain(config.password);
    expect(factoryOptions?.query).toEqual({ password: config.password });
    expect(factoryOptions?.transports).toEqual(["websocket", "polling"]);
    socket.emit("connect");
    socket.emit("new-message", { guid: "live" });
    socket.emit("disconnect", "transport close");
    expect(events).toEqual(["connected", { guid: "live" }, "transport close"]);

    unsubscribe();
    socket.emit("new-message", { guid: "ignored" });
    client.disconnect();
    expect(socket.connects).toBe(1);
    expect(socket.disconnects).toBe(1);
  });

  test("starts and stops typing over the authenticated socket", async () => {
    const socket = new FakeSocket();
    const emitted: string[] = [];
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event: string, value?: unknown, callback?: (response: unknown) => void) => {
      emitted.push(event);
      return originalEmit(event, value, callback);
    };
    const client = new BlueBubblesClient(config, {
      socketFactory: () => socket,
      fetch: async () => json({}),
    });
    expect(await client.setTyping("chat", true)).toBe(false);
    client.connect();
    expect(await client.setTyping("chat", true)).toBe(true);
    expect(await client.setTyping("chat", false)).toBe(true);
    expect(emitted).toEqual(["started-typing", "stopped-typing"]);
  });
});
