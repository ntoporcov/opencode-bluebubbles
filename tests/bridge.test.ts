import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { BlueBubblesConfig } from "../src/config"
import type { ApiResult, MessageEnvelope, OpenCodeClient } from "../src/sessions"
import { Store } from "../src/store"

type SendResult =
  | { status: "sent"; tempGuid: string; data: Record<string, unknown> }
  | { status: "indeterminate"; tempGuid: string; reason: string; retryable: false }

class FakeBlueBubblesClient {
  static instances: FakeBlueBubblesClient[] = []
  static nextSendResult: SendResult | undefined

  readonly catchUps: number[] = []
  readonly sends: Array<{ chatGuid: string; text: string; tempGuid: string }> = []
  readonly reactions: Array<{ chatGuid: string; messageGuid: string; reaction: string }> = []
  readonly typing: Array<{ chatGuid: string; isTyping: boolean }> = []
  readonly edits: Array<{ messageGuid: string; text: string }> = []
  connects = 0
  disconnects = 0
  #messageListeners: Array<(message: unknown) => void> = []
  #connectListeners: Array<() => void> = []
  #disconnectListeners: Array<() => void> = []

  constructor(_config: BlueBubblesConfig) {
    FakeBlueBubblesClient.instances.push(this)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.push(listener)
    return () => { this.#messageListeners = this.#messageListeners.filter((candidate) => candidate !== listener) }
  }

  onConnect(listener: () => void): () => void {
    this.#connectListeners.push(listener)
    return () => { this.#connectListeners = this.#connectListeners.filter((candidate) => candidate !== listener) }
  }

  onDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.push(listener)
    return () => { this.#disconnectListeners = this.#disconnectListeners.filter((candidate) => candidate !== listener) }
  }

  async ping(): Promise<Record<string, unknown>> {
    return { status: 200, message: "pong" }
  }

  async getServerInfo(): Promise<Record<string, unknown>> {
    return { private_api: true, helper_connected: true, server_version: "fake" }
  }

  connect(): void {
    this.connects += 1
    for (const listener of this.#connectListeners) listener()
  }

  disconnect(): void {
    this.disconnects += 1
    for (const listener of this.#disconnectListeners) listener()
  }

  async catchUp(after: number): Promise<{ before: number; messages: [] }> {
    this.catchUps.push(after)
    return { before: Date.now(), messages: [] }
  }

  async sendText(chatGuid: string, text: string, tempGuid: string): Promise<SendResult> {
    this.sends.push({ chatGuid, text, tempGuid })
    return FakeBlueBubblesClient.nextSendResult
      ?? { status: "sent", tempGuid, data: { guid: `sent-${this.sends.length}` } }
  }

  async reactToMessage(chatGuid: string, messageGuid: string, reaction: string): Promise<{ status: "sent"; data: {} }> {
    this.reactions.push({ chatGuid, messageGuid, reaction })
    return { status: "sent", data: {} }
  }

  async editMessage(messageGuid: string, text: string): Promise<{ status: "sent"; data: {} }> {
    this.edits.push({ messageGuid, text })
    return { status: "sent", data: {} }
  }

  async setTyping(chatGuid: string, isTyping: boolean): Promise<boolean> {
    this.typing.push({ chatGuid, isTyping })
    return true
  }

  emitMessage(message: unknown): void {
    for (const listener of this.#messageListeners) listener(message)
  }
}

import { BridgeRuntime } from "../src/bridge"

type Runtime = InstanceType<typeof BridgeRuntime>
type SessionPrompt = Parameters<OpenCodeClient["session"]["prompt"]>[0]

const runtimes: Runtime[] = []
const directories: string[] = []

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.dispose()
  FakeBlueBubblesClient.instances.length = 0
  FakeBlueBubblesClient.nextSendResult = undefined
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function config(stateDirectory: string): BlueBubblesConfig {
  return {
    serverUrl: "https://bluebubbles.example",
    passwordEnv: "BLUEBUBBLES_PASSWORD",
    password: "secret",
    instanceId: "test-instance",
    stateDirectory,
    alias: "opencode",
    sendMethod: "private-api",
    remoteAgent: "configured-remote-agent",
    pinExpiryMinutes: 15,
    pinAttempts: 5,
    permissionExpiryMinutes: 15,
    responseChunkCharacters: 3_000,
    catchupPageSize: 100,
    maxConcurrentSessions: 4,
    allowedTools: [],
    thinkingReaction: "emphasize",
    typingIndicator: true,
    toolCallMessages: false,
    personalityTokens: {},
    permissionWaitMessage: "Hang on, you have to ask Nic for that",
  }
}

function databasePath(stateDirectory: string, directory: string): string {
  const namespace = createHash("sha256").update(`test-instance\0${realpathSync(directory)}`).digest("hex").slice(0, 24)
  return join(stateDirectory, `${namespace}.sqlite`)
}

function leaseDatabasePath(stateDirectory: string): string {
  const namespace = createHash("sha256").update("test-instance").digest("hex").slice(0, 24)
  return join(stateDirectory, `lease-${namespace}.sqlite`)
}

function harness(options: {
  onModelPrompt?: (prompt: SessionPrompt) => void
  prompt?: (prompt: SessionPrompt) => Promise<ApiResult<MessageEnvelope>>
  stateDirectory?: string
  directory?: string
  toolCallMessages?: boolean
  leaseHeartbeatMs?: number
} = {}) {
  const stateDirectory = options.stateDirectory ?? mkdtempSync(join(tmpdir(), "bridge-test-"))
  if (options.stateDirectory === undefined) directories.push(stateDirectory)
  const directory = options.directory ?? stateDirectory
  const prompts: SessionPrompt[] = []
  let sessionNumber = 0
  const client: OpenCodeClient = {
    session: {
      create: async () => ({ data: { id: `session-${++sessionNumber}` } }),
      prompt: async (prompt) => {
        prompts.push(prompt)
        if (prompt.body.agent !== undefined) options.onModelPrompt?.(prompt)
        if (options.prompt !== undefined) return options.prompt(prompt)
        return {
          data: {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "durable model response" }],
          },
        }
      },
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    app: { log: async () => ({ data: true }) },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
  }
  const runtimeConfig = config(stateDirectory)
  runtimeConfig.toolCallMessages = options.toolCallMessages ?? false
  const runtime = new BridgeRuntime(
    { client, directory } as unknown as PluginInput,
    runtimeConfig,
    {
      createBlueBubbles: () => new FakeBlueBubblesClient(runtimeConfig) as never,
      ...(options.leaseHeartbeatMs === undefined ? {} : { leaseHeartbeatMs: options.leaseHeartbeatMs }),
    },
  )
  runtimes.push(runtime)
  return {
    runtime,
    prompts,
    path: databasePath(stateDirectory, directory),
    blueBubbles: () => FakeBlueBubblesClient.instances.at(-1) as FakeBlueBubblesClient,
  }
}

function message(guid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid,
    text: "perform the request",
    dateCreated: Date.now(),
    isFromMe: false,
    handle: { address: "sender@example.com" },
    chats: [{ guid: "iMessage;+;chat", style: 45 }],
    ...overrides,
  }
}

function authorize(store: Store, options: { remoteSession?: string; approvalSession?: string } = {}): string {
  const relationship = store.createPendingRelationship({
    id: `relationship-${options.remoteSession ?? "remote"}`,
    instanceId: "test-instance",
    chatGuid: "iMessage;+;chat",
    senderHandle: "sender@example.com",
    chatKind: "direct",
  })
  store.setRelationshipSessions(
    relationship.id,
    options.remoteSession ?? "remote-session",
    options.approvalSession ?? "approval-session",
  )
  store.authorizeRelationship(relationship.id)
  return relationship.id
}

async function settle(runtime: Runtime): Promise<void> {
  await runtime.dispose()
  const index = runtimes.indexOf(runtime)
  if (index >= 0) runtimes.splice(index, 1)
}

describe("BridgeRuntime", () => {
  test("starts a first installation at now instead of historically catching up", async () => {
    const startedAt = Date.now()
    const { runtime, path, blueBubbles } = harness()
    await runtime.start()
    await settle(runtime)

    const store = new Store(path)
    const cursor = store.getCursor("test-instance")
    expect(cursor?.last_message_guid).toBe("catchup-watermark")
    expect(cursor?.last_date_created).toBeGreaterThanOrEqual(startedAt)
    expect(blueBubbles().catchUps).toHaveLength(1)
    expect(blueBubbles().catchUps[0]).toBeGreaterThanOrEqual(startedAt)
    store.close()
  })

  test("claims duplicate events once and sends one enrollment response without prompting a model", async () => {
    const { runtime, prompts, blueBubbles } = harness()
    await runtime.start()
    const event = message("duplicate-guid", { text: "unknown initial request" })
    blueBubbles().emitMessage(event)
    blueBubbles().emitMessage(event)
    await settle(runtime)

    expect(prompts.filter(({ body }) => body.agent !== undefined)).toHaveLength(0)
    expect(blueBubbles().sends).toHaveLength(1)
    expect(blueBubbles().reactions).toEqual([])
    expect(blueBubbles().sends[0]?.text).toContain("Administrator approval is required")
  })

  test("prompts the configured agent for an authorized message and durably sends once", async () => {
    const { runtime, path, prompts, blueBubbles } = harness()
    await runtime.start()
    const store = new Store(path)
    const relationshipId = authorize(store)

    blueBubbles().emitMessage(message("authorized-guid", { text: "authorized request" }))
    await settle(runtime)

    const modelPrompts = prompts.filter(({ body }) => body.agent !== undefined)
    expect(modelPrompts).toHaveLength(1)
    expect(modelPrompts[0]?.body).toMatchObject({
      agent: "configured-remote-agent",
      parts: [{ type: "text", text: expect.stringContaining("User message:\nauthorized request") }],
    })
    expect(blueBubbles().sends).toHaveLength(1)
    expect(blueBubbles().reactions).toEqual([{
      chatGuid: "iMessage;+;chat",
      messageGuid: "authorized-guid",
      reaction: "emphasize",
    }])
    expect(blueBubbles().typing).toEqual([
      { chatGuid: "iMessage;+;chat", isTyping: true },
      { chatGuid: "iMessage;+;chat", isTyping: false },
    ])
    const delivery = store.db.query("SELECT * FROM outbound_deliveries WHERE relationship_id = ?").get(relationshipId) as { id: string; status: string }
    expect(delivery.status).toBe("delivered")
    expect(store.listOutboundChunks(delivery.id)).toMatchObject([{ status: "delivered", attempts: 1 }])
    store.close()
  })

  test("replaces a missing managed session reported by the current SDK error shape", async () => {
    let attempts = 0
    const { runtime, path, prompts, blueBubbles } = harness({
      prompt: async () => {
        attempts += 1
        if (attempts === 1) {
          return { error: { name: "NotFoundError", data: { message: "Session not found" } } }
        }
        return {
          data: {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "replacement response" }],
          },
        }
      },
    })
    await runtime.start()
    const store = new Store(path)
    const relationshipId = authorize(store)

    blueBubbles().emitMessage(message("missing-session-guid"))
    await settle(runtime)

    expect(prompts.filter(({ body }) => body.agent !== undefined)).toHaveLength(2)
    expect(store.getRelationshipById(relationshipId)?.remote_session_id).toBe("session-1")
    expect(blueBubbles().sends).toContainEqual(expect.objectContaining({ text: "replacement response" }))
    store.close()
  })

  test("sends one emoji-free status message when a tool starts", async () => {
    let runtime: Runtime
    const test = harness({
      toolCallMessages: true,
      onModelPrompt: () => {
        runtime.handleToolExecuteBefore("webfetch", "remote-session")
      },
    })
    runtime = test.runtime
    const { path, blueBubbles } = test
    await runtime.start()
    const store = new Store(path)
    authorize(store)
    blueBubbles().emitMessage(message("tool-status-guid", { text: "authorized request" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(blueBubbles().sends).toContainEqual(expect.objectContaining({ text: "Running webfetch" }))
    expect(blueBubbles().sends.filter(({ text }) => text.startsWith("Running "))).toHaveLength(1)
    expect(blueBubbles().edits).toEqual([])
    store.close()
  })

  test("ignores group messages that do not address the configured alias", async () => {
    const { runtime, path, prompts, blueBubbles } = harness()
    await runtime.start()
    const store = new Store(path)
    blueBubbles().emitMessage(message("unaddressed-group", {
      text: "hello everyone",
      chats: [{ guid: "iMessage;+;group", style: 43, displayName: "Team" }],
    }))
    await settle(runtime)

    expect(prompts).toHaveLength(0)
    expect(blueBubbles().sends).toHaveLength(0)
    expect(store.db.query("SELECT outcome FROM processed_messages WHERE message_guid = ?").get("unaddressed-group")).toEqual({ outcome: "ignored" })
    store.close()
  })

  test("does not retry an ambiguous send failure and persists it as indeterminate", async () => {
    FakeBlueBubblesClient.nextSendResult = {
      status: "indeterminate",
      tempGuid: "ignored-by-fake",
      reason: "connection closed after write",
      retryable: false,
    }
    const { runtime, path, blueBubbles } = harness()
    await runtime.start()
    const store = new Store(path)
    const relationshipId = authorize(store)
    blueBubbles().emitMessage(message("ambiguous-guid"))
    await settle(runtime)

    expect(blueBubbles().sends).toHaveLength(1)
    const delivery = store.db.query("SELECT * FROM outbound_deliveries WHERE relationship_id = ?").get(relationshipId) as { id: string; status: string }
    expect(delivery.status).toBe("indeterminate")
    expect(store.listOutboundChunks(delivery.id)).toMatchObject([
      { status: "indeterminate", attempts: 1, error_category: "transport" },
    ])
    store.close()
  })

  test("fails closed when leadership is lost between prompting and sending", async () => {
    let store: Store
    const { runtime, path, blueBubbles } = harness({
      onModelPrompt: () => {
        const leaseStore = new Store(leaseDatabasePath(store.db.filename.replace(/\/[^/]+$/u, "")))
        leaseStore.db.query("DELETE FROM leader_lease WHERE instance_id = ?").run("test-instance")
        leaseStore.close()
      },
    })
    await runtime.start()
    store = new Store(path)
    authorize(store)
    blueBubbles().emitMessage(message("lease-loss-guid"))
    await settle(runtime)

    expect(blueBubbles().sends).toHaveLength(0)
    expect(store.db.query("SELECT status FROM outbound_deliveries").all()).toEqual([{ status: "pending" }])
    store.close()
  })

  test("blocks administrator tools from remote and unmanaged caller provenance", async () => {
    const { runtime, path } = harness()
    await runtime.start()
    const store = new Store(path)
    authorize(store, { remoteSession: "managed-remote", approvalSession: "administrator" })

    expect(() => runtime.guardToolExecution("bluebubbles_health", "managed-remote", {})).toThrow("cannot invoke administrator tools")
    expect(() => runtime.guardToolExecution("read", "managed-remote", {
      filePath: join(homedir(), ".local", "share", "opencode", "tool-output", "secret"),
    })).toThrow("permanently denied")
    const health = runtime.tools.bluebubbles_health
    expect(health).toBeDefined()
    await expect(health?.execute({}, { sessionID: "managed-remote" } as never)).rejects.toThrow("administrator authorization failed")
    await expect(health?.execute({}, { sessionID: "unmanaged" } as never)).rejects.toThrow("administrator authorization failed")
    await expect(health?.execute({}, { sessionID: "administrator" } as never)).resolves.toContain('"active": true')
    store.close()
  })

  test("dispose disconnects and releases the durable leader lease", async () => {
    const { runtime, path, blueBubbles } = harness()
    await runtime.start()
    const store = new Store(path)
    const leaseStore = new Store(leaseDatabasePath(store.db.filename.replace(/\/[^/]+$/u, "")))
    expect(leaseStore.getLeaderLease("test-instance")).not.toBeNull()

    await settle(runtime)

    expect(blueBubbles().disconnects).toBe(1)
    expect(leaseStore.getLeaderLease("test-instance")).toBeNull()
    leaseStore.close()
    store.close()
  })

  test("reacquires an expired lease after a delayed heartbeat", async () => {
    const { runtime, path, blueBubbles } = harness({ leaseHeartbeatMs: 10 })
    await runtime.start()
    const leaseStore = new Store(leaseDatabasePath(path.replace(/\/[^/]+$/u, "")))
    const initial = leaseStore.getLeaderLease("test-instance")
    expect(initial?.generation).toBe(1)
    leaseStore.db.query("UPDATE leader_lease SET heartbeat_at = 0, expires_at = 1 WHERE instance_id = ?").run("test-instance")

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(runtime.health().leader).toBe(true)
    expect(leaseStore.getLeaderLease("test-instance")?.generation).toBe(2)
    expect(blueBubbles().disconnects).toBe(0)
    leaseStore.close()
  })

  test("allows only one leader for an instance across project databases", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "bridge-shared-"))
    directories.push(stateDirectory)
    const firstDirectory = join(stateDirectory, "project-one")
    const secondDirectory = join(stateDirectory, "project-two")
    mkdirSync(firstDirectory)
    mkdirSync(secondDirectory)
    const first = harness({ stateDirectory, directory: firstDirectory })
    const second = harness({ stateDirectory, directory: secondDirectory })

    await first.runtime.start()
    await second.runtime.start()

    expect(FakeBlueBubblesClient.instances).toHaveLength(1)
    expect(first.runtime.health().leader).toBe(true)
    expect(second.runtime.health().leader).toBe(false)
  })

  test("uses one project database through canonical and symlink paths", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "bridge-symlink-"))
    directories.push(stateDirectory)
    const projectDirectory = join(stateDirectory, "project")
    const aliasDirectory = join(stateDirectory, "project-alias")
    mkdirSync(projectDirectory)
    symlinkSync(projectDirectory, aliasDirectory)

    const first = harness({ stateDirectory, directory: projectDirectory })
    await first.runtime.start()
    const firstStore = new Store(first.path)
    const relationshipId = authorize(firstStore)
    firstStore.close()
    await settle(first.runtime)

    const second = harness({ stateDirectory, directory: aliasDirectory })
    await second.runtime.start()
    expect(second.path).toBe(first.path)
    const secondStore = new Store(second.path)
    expect(secondStore.getRelationshipById(relationshipId)?.status).toBe("authorized")
    secondStore.close()
  })
})
