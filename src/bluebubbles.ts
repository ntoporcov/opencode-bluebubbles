import { io, type ManagerOptions, type SocketOptions } from "socket.io-client";
import { z } from "zod";
import type { BlueBubblesConfig } from "./config";
import { blueBubblesMessageSchema, type BlueBubblesMessage } from "./messages";
import { safeError } from "./security";

const envelopeFields = {
  status: z.number().int(),
  message: z.string(),
};

const pingEnvelopeSchema = z.object({
  ...envelopeFields,
  data: z.unknown().optional(),
}).passthrough().refine(({ status }) => status === 200, "BlueBubbles ping failed");

const serverInfoSchema = z.object({
  private_api: z.boolean(),
  helper_connected: z.boolean(),
}).passthrough();

const serverInfoEnvelopeSchema = z.object({
  ...envelopeFields,
  data: serverInfoSchema,
}).passthrough().refine(({ status }) => status === 200, "BlueBubbles server info failed");

// REST serialization contains more fields than the realtime bridge needs.
const restMessageSchema = blueBubblesMessageSchema.passthrough();
const queryEnvelopeSchema = z.object({
  ...envelopeFields,
  data: z.array(restMessageSchema),
  metadata: z.object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough().refine(({ status }) => status === 200, "BlueBubbles message query failed");

const sendEnvelopeSchema = z.object({
  ...envelopeFields,
  data: z.object({}).passthrough(),
}).passthrough().refine(({ status }) => status === 200, "BlueBubbles send failed");

export type BlueBubblesServerInfo = z.infer<typeof serverInfoSchema>;

export type BlueBubblesClientConfig = Pick<
  BlueBubblesConfig,
  "serverUrl" | "password" | "sendMethod" | "catchupPageSize"
>;

export type CatchUpResult = {
  /** Inclusive upper bound used for every page in this catch-up run. */
  before: number;
  messages: BlueBubblesMessage[];
};

export type SendOutcome =
  | { status: "sent"; tempGuid: string; data: Record<string, unknown> }
  | { status: "rejected"; tempGuid: string; httpStatus: number; retryable: false }
  | { status: "indeterminate"; tempGuid: string; reason: string; retryable: false };

export type Tapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export type ReactionOutcome =
  | { status: "sent"; data: Record<string, unknown> }
  | { status: "rejected"; httpStatus: number; retryable: false }
  | { status: "indeterminate"; reason: string; retryable: false };

export type EditOutcome =
  | { status: "sent"; data: Record<string, unknown> }
  | { status: "rejected"; httpStatus: number; retryable: false }
  | { status: "indeterminate"; reason: string; retryable: false };

export interface BlueBubblesSocket {
  on(event: "connect" | "disconnect", listener: (...args: unknown[]) => void): this;
  on(event: "new-message", listener: (message: unknown) => void): this;
  off(event: string, listener?: (...args: never[]) => void): this;
  emit(
    event: "started-typing" | "stopped-typing",
    params: { chatGuid: string },
    callback: (response: unknown) => void,
  ): this;
  connect(): this;
  disconnect(): this;
}

export type SocketFactory = (
  url: string,
  options: Partial<ManagerOptions & SocketOptions>,
) => BlueBubblesSocket;

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BlueBubblesClientDependencies = {
  fetch?: Fetch;
  socketFactory?: SocketFactory;
  now?: () => number;
  randomUUID?: () => string;
  requestTimeoutMs?: number;
};

export class BlueBubblesHttpError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(endpoint: string, status: number) {
    super(`BlueBubbles request to ${endpoint} failed with HTTP ${status}`);
    this.name = "BlueBubblesHttpError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

export class BlueBubblesNetworkError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause: unknown, password: string) {
    super(`BlueBubbles request to ${endpoint} failed: ${safeError(cause, [password])}`);
    this.name = "BlueBubblesNetworkError";
    this.endpoint = endpoint;
  }
}

export class BlueBubblesClient {
  readonly #config: BlueBubblesClientConfig;
  readonly #fetch: Fetch;
  readonly #socketFactory: SocketFactory;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #requestTimeoutMs: number;
  #socket?: BlueBubblesSocket;
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #connectListeners = new Set<() => void>();
  readonly #disconnectListeners = new Set<(reason: unknown) => void>();

  constructor(config: BlueBubblesClientConfig, dependencies: BlueBubblesClientDependencies = {}) {
    this.#config = config;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#socketFactory = dependencies.socketFactory ?? ((url, options) => io(url, options));
    this.#now = dependencies.now ?? Date.now;
    this.#randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
    this.#requestTimeoutMs = dependencies.requestTimeoutMs ?? 30_000;
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onConnect(listener: () => void): () => void {
    this.#connectListeners.add(listener);
    return () => this.#connectListeners.delete(listener);
  }

  onDisconnect(listener: (reason: unknown) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  connect(): void {
    if (!this.#socket) {
      // The URL remains credential-free; Socket.IO serializes the auth query itself.
      const socket = this.#socketFactory(this.#baseUrl(), {
        autoConnect: false,
        transports: ["websocket", "polling"],
        query: { password: this.#config.password },
      });
      socket.on("connect", () => {
        for (const listener of this.#connectListeners) listener();
      });
      socket.on("disconnect", (reason) => {
        for (const listener of this.#disconnectListeners) listener(reason);
      });
      socket.on("new-message", (message) => {
        for (const listener of this.#messageListeners) listener(message);
      });
      this.#socket = socket;
    }
    this.#socket.connect();
  }

  disconnect(): void {
    this.#socket?.disconnect();
  }

  async ping(): Promise<z.infer<typeof pingEnvelopeSchema>> {
    return pingEnvelopeSchema.parse(await this.#requestJson("/api/v1/ping", { method: "GET" }));
  }

  async getServerInfo(): Promise<BlueBubblesServerInfo> {
    const envelope = serverInfoEnvelopeSchema.parse(
      await this.#requestJson("/api/v1/server/info", { method: "GET" }),
    );
    return envelope.data;
  }

  async probePrivateApiAvailability(): Promise<boolean> {
    const info = await this.getServerInfo();
    return info.private_api && info.helper_connected;
  }

  async catchUp(after: number, before = this.#now()): Promise<CatchUpResult> {
    this.#assertTimestamp(after, "after", true);
    this.#assertTimestamp(before, "before", false);
    const messages: BlueBubblesMessage[] = [];
    let offset = 0;

    for (;;) {
      const body = {
        after,
        before,
        offset,
        limit: this.#config.catchupPageSize,
        sort: "ASC",
        with: ["chats"],
      };
      const envelope = queryEnvelopeSchema.parse(await this.#requestJson("/api/v1/message/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      messages.push(...envelope.data);

      const count = envelope.data.length;
      if (count === 0 || count < this.#config.catchupPageSize || offset + count >= envelope.metadata.total) break;
      offset += count;
    }

    return { before, messages };
  }

  async sendText(chatGuid: string, message: string, suppliedTempGuid?: string): Promise<SendOutcome> {
    if (!chatGuid) throw new TypeError("chatGuid must not be empty");
    if (!message) throw new TypeError("message must not be empty");
    const tempGuid = suppliedTempGuid ?? this.#randomUUID();
    if (!tempGuid) throw new TypeError("tempGuid must not be empty");
    const endpoint = "/api/v1/message/text";
    let response: Response;

    try {
      response = await this.#fetchAuthenticated(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatGuid, tempGuid, message, method: this.#config.sendMethod }),
      });
    } catch (error) {
      return {
        status: "indeterminate",
        tempGuid,
        reason: safeError(error, [this.#config.password]),
        retryable: false,
      };
    }

    if (!response.ok) {
      if (response.status === 408 || response.status >= 500) {
        return { status: "indeterminate", tempGuid, reason: `HTTP ${response.status}`, retryable: false };
      }
      return { status: "rejected", tempGuid, httpStatus: response.status, retryable: false };
    }

    try {
      const envelope = sendEnvelopeSchema.parse(await response.json());
      return { status: "sent", tempGuid, data: envelope.data };
    } catch (error) {
      return {
        status: "indeterminate",
        tempGuid,
        reason: `Invalid response: ${safeError(error, [this.#config.password])}`,
        retryable: false,
      };
    }
  }

  async reactToMessage(chatGuid: string, selectedMessageGuid: string, reaction: Tapback): Promise<ReactionOutcome> {
    if (!chatGuid) throw new TypeError("chatGuid must not be empty");
    if (!selectedMessageGuid) throw new TypeError("selectedMessageGuid must not be empty");
    const endpoint = "/api/v1/message/react";
    let response: Response;
    try {
      response = await this.#fetchAuthenticated(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatGuid, selectedMessageGuid, reaction, partIndex: 0 }),
      });
    } catch (error) {
      return { status: "indeterminate", reason: safeError(error, [this.#config.password]), retryable: false };
    }
    if (!response.ok) {
      if (response.status === 408 || response.status >= 500) {
        return { status: "indeterminate", reason: `HTTP ${response.status}`, retryable: false };
      }
      return { status: "rejected", httpStatus: response.status, retryable: false };
    }
    try {
      const envelope = sendEnvelopeSchema.parse(await response.json());
      return { status: "sent", data: envelope.data };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: `Invalid response: ${safeError(error, [this.#config.password])}`,
        retryable: false,
      };
    }
  }

  async editMessage(messageGuid: string, message: string): Promise<EditOutcome> {
    if (!messageGuid) throw new TypeError("messageGuid must not be empty");
    if (!message) throw new TypeError("message must not be empty");
    const endpoint = `/api/v1/message/${encodeURIComponent(messageGuid)}/edit`;
    let response: Response;
    try {
      response = await this.#fetchAuthenticated(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          editedMessage: message,
          backwardsCompatibilityMessage: message,
          partIndex: 0,
        }),
      });
    } catch (error) {
      return { status: "indeterminate", reason: safeError(error, [this.#config.password]), retryable: false };
    }
    if (!response.ok) {
      if (response.status === 408 || response.status >= 500) {
        return { status: "indeterminate", reason: `HTTP ${response.status}`, retryable: false };
      }
      return { status: "rejected", httpStatus: response.status, retryable: false };
    }
    try {
      const envelope = sendEnvelopeSchema.parse(await response.json());
      return { status: "sent", data: envelope.data };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: `Invalid response: ${safeError(error, [this.#config.password])}`,
        retryable: false,
      };
    }
  }

  async setTyping(chatGuid: string, isTyping: boolean): Promise<boolean> {
    if (!chatGuid) throw new TypeError("chatGuid must not be empty");
    const socket = this.#socket;
    if (!socket) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), Math.min(this.#requestTimeoutMs, 5_000));
      socket.emit(isTyping ? "started-typing" : "stopped-typing", { chatGuid }, (response) => {
        if (typeof response !== "object" || response === null) return finish(false);
        const record = response as Record<string, unknown>;
        finish(record.status === 200 && record.error === undefined);
      });
    });
  }

  async #requestJson(endpoint: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetchAuthenticated(endpoint, init);
    if (!response.ok) throw new BlueBubblesHttpError(endpoint, response.status);
    return response.json();
  }

  async #fetchAuthenticated(endpoint: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      // Construct the credential-bearing URL only at the fetch boundary.
      const url = new URL(this.#baseUrl());
      url.pathname = `${url.pathname.replace(/\/$/u, "")}${endpoint}`;
      url.searchParams.set("password", this.#config.password);
      try {
        return await this.#fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        throw new BlueBubblesNetworkError(endpoint, error, this.#config.password);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #baseUrl(): string {
    const url = new URL(this.#config.serverUrl);
    url.hash = "";
    return url.toString();
  }

  #assertTimestamp(value: number, name: string, allowZero: boolean): void {
    if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
      throw new RangeError(`${name} must be ${allowZero ? "a nonnegative" : "a positive"} integer`);
    }
  }
}
