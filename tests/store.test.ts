import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/store"

const stores: Store[] = []
const directories: string[] = []

function memoryStore(): Store {
  const store = new Store(":memory:")
  stores.push(store)
  return store
}

function relationship(store: Store, id = "relationship-1") {
  const value = store.createPendingRelationship({
    id,
    instanceId: "bb-1",
    chatGuid: "iMessage;+;chat-1",
    senderHandle: "sender@example.com",
    chatKind: "direct",
    createdAt: 10,
  })
  store.setRelationshipSessions(id, `remote-${id}`, `approval-${id}`)
  return value
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe("schema and transactions", () => {
  test("applies migrations once and creates a private database", () => {
    const directory = mkdtempSync(join(tmpdir(), "bluebubbles-store-"))
    directories.push(directory)
    const path = join(directory, "state", "bridge.sqlite")
    const first = new Store(path)
    expect(first.getSchemaVersion()).toBe(6)
    expect(first.databaseMode()).toBe(0o600)
    first.close()

    const second = new Store(path)
    stores.push(second)
    expect(second.getSchemaVersion()).toBe(6)
    const versions = second.db.query("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }
    expect(versions.count).toBe(6)
  })

  test("rolls back every write when a transaction fails", () => {
    const store = memoryStore()
    expect(() => store.transaction(() => {
      relationship(store)
      throw new Error("abort")
    })).toThrow("abort")
    expect(store.listRelationships()).toEqual([])
  })
})

describe("enrollment", () => {
  test("maintains one active challenge and consumes it once", () => {
    const store = memoryStore()
    relationship(store)
    store.createChallenge({
      id: "old", relationshipId: "relationship-1", pinSalt: "salt-a", pinHash: "hash-a",
      attempts: 5, expiresAt: 1_000, createdAt: 20,
    })
    store.createChallenge({
      id: "new", relationshipId: "relationship-1", pinSalt: "salt-b", pinHash: "hash-b",
      attempts: 2, expiresAt: 1_000, createdAt: 30,
    })
    store.markChallengeDisplayed("new", 31)

    const active = store.db.query(`
      SELECT COUNT(*) AS count FROM challenges WHERE consumed_at IS NULL AND expired_at IS NULL AND attempts_remaining > 0
    `).get() as { count: number }
    expect(active.count).toBe(1)
    expect(store.attemptChallenge("relationship-1", (_salt, hash) => hash === "hash-b", 40)).toBe("authorized")
    expect(store.attemptChallenge("relationship-1", () => true, 41)).toBe("unavailable")
    expect(store.getRelationshipById("relationship-1")?.status).toBe("authorized")
  })

  test("serial attempts lock a challenge without allowing another winner", () => {
    const store = memoryStore()
    relationship(store)
    store.createChallenge({
      id: "challenge", relationshipId: "relationship-1", pinSalt: "salt", pinHash: "hash",
      attempts: 1, expiresAt: 1_000, createdAt: 20,
    })
    store.markChallengeDisplayed("challenge", 21)
    expect(store.attemptChallenge("relationship-1", () => false, 30)).toBe("locked")
    expect(store.attemptChallenge("relationship-1", () => true, 31)).toBe("unavailable")
  })
})

describe("message and leadership state", () => {
  test("deduplicates by BlueBubbles instance and GUID", () => {
    const store = memoryStore()
    expect(store.claimMessage("one", "guid", 10, 20)).toBe(true)
    expect(store.claimMessage("one", "guid", 10, 21)).toBe(false)
    expect(store.claimMessage("two", "guid", 10, 22)).toBe(true)
    expect(store.finishMessageAndSetCursor("one", "guid", "processed", 10, 30)).toBe(true)
    expect(store.finishMessage("one", "guid", "failed", 31)).toBe(false)
    expect(store.getCursor("one")?.last_message_guid).toBe("guid")
  })

  test("fences stale lease owners with a monotonically increasing generation", () => {
    const store = memoryStore()
    const first = store.acquireLeaderLease("bb", "owner-a", 100, 50)
    expect(first?.generation).toBe(1)
    expect(store.acquireLeaderLease("bb", "owner-b", 120, 50)).toBeNull()
    const second = store.acquireLeaderLease("bb", "owner-b", 151, 50)
    expect(second?.generation).toBe(2)
    expect(store.renewLeaderLease("bb", "owner-a", 1, 160, 50)).toBe(false)
    expect(store.releaseLeaderLease("bb", "owner-a", 1)).toBe(false)
    expect(store.renewLeaderLease("bb", "owner-b", 2, 160, 50)).toBe(true)

    const sameOwnerAfterExpiry = store.acquireLeaderLease("bb", "owner-b", 211, 50)
    expect(sameOwnerAfterExpiry?.generation).toBe(3)
  })

  test("binds an instance to exactly one OpenCode project", () => {
    const store = memoryStore()
    expect(store.bindProject("bb", "project-a", 10)).toBe("bound")
    expect(store.bindProject("bb", "project-a", 20)).toBe("existing")
    expect(store.bindProject("bb", "project-b", 30)).toBe("conflict")
  })

  test("fails interrupted claims and never moves a cursor backward", () => {
    const store = memoryStore()
    expect(store.claimMessage("bb", "interrupted", 20, 30)).toBe(true)
    expect(store.failUnfinishedMessages(40)).toBe(1)
    expect(store.getMessageOutcome("bb", "interrupted")).toBe("failed")
    store.setCursor("bb", 100, "newer", 50)
    store.setCursor("bb", 90, "older", 60)
    expect(store.getCursor("bb")).toMatchObject({ last_date_created: 100, last_message_guid: "newer" })
  })
})

describe("outbound delivery", () => {
  test("aggregates chunk outcomes and preserves indeterminate sends", () => {
    const store = memoryStore()
    relationship(store)
    store.createOutboundDelivery({
      id: "delivery", instanceId: "bb-1", relationshipId: "relationship-1",
      sourceMessageGuid: "source-guid", chunks: [{ tempGuid: "temp-1" }, { tempGuid: "temp-2" }], now: 50,
    })
    expect(store.markOutboundChunk("delivery", 0, "delivered", null, 60, "permanent-guid")).toBe(true)
    expect(store.getOutboundDelivery("delivery")?.status).toBe("sending")
    expect(store.markOutboundChunk("delivery", 1, "indeterminate", "transport", 61)).toBe(true)
    expect(store.getOutboundDelivery("delivery")?.status).toBe("indeterminate")
    expect(store.listOutboundChunks("delivery")[1]?.attempts).toBe(1)
    expect(store.listOutboundChunks("delivery")[0]?.bluebubbles_message_guid).toBe("permanent-guid")

    const schema = store.db.query("SELECT group_concat(sql) AS sql FROM sqlite_schema").get() as { sql: string }
    expect(schema.sql).not.toContain("message_body")
  })
})
