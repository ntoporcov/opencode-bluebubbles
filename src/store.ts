import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"

export type RelationshipStatus = "pending" | "authorized" | "revoked"
export type ChatKind = "direct" | "group"
export type TerminalMessageOutcome = "ignored" | "processed" | "failed"
export type ChallengeAttempt = "authorized" | "invalid" | "locked" | "expired" | "unavailable"
export type ReviewDecision = "approved" | "rejected"
export type DeliveryStatus = "pending" | "sending" | "delivered" | "failed" | "indeterminate"

export interface Relationship {
  id: string
  bluebubbles_instance_id: string
  chat_guid: string
  sender_handle: string
  chat_kind: ChatKind
  status: RelationshipStatus
  remote_session_id: string | null
  approval_session_id: string | null
  created_at: number
  authorized_at: number | null
  revoked_at: number | null
}

export interface Challenge {
  id: string
  relationship_id: string
  pin_salt: string
  pin_hash: string
  attempts_remaining: number
  expires_at: number
  consumed_at: number | null
  expired_at: number | null
  displayed_at: number | null
  created_at: number
}

export interface PermissionReview {
  id: string
  relationship_id: string
  remote_session_id: string
  permission_id: string
  admin_session_id: string
  review_code_hash: string
  question_request_id: string | null
  status: "pending" | "resolving_once" | "resolving_reject" | ReviewDecision | "expired"
  expires_at: number
  decided_at: number | null
  created_at: number
}

export interface OutboundDelivery {
  id: string
  bluebubbles_instance_id: string
  relationship_id: string | null
  source_message_guid: string | null
  status: DeliveryStatus
  created_at: number
  updated_at: number
}

export interface OutboundChunk {
  delivery_id: string
  chunk_index: number
  temp_guid: string
  status: DeliveryStatus
  attempts: number
  error_category: string | null
  bluebubbles_message_guid: string | null
  updated_at: number
}

export interface LeaderLease {
  instance_id: string
  owner_id: string
  generation: number
  heartbeat_at: number
  expires_at: number
}

export interface PersonalityTokenState {
  token: string
  value: number
  description: string
}

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY,
      bluebubbles_instance_id TEXT NOT NULL,
      chat_guid TEXT NOT NULL,
      sender_handle TEXT NOT NULL,
      chat_kind TEXT NOT NULL CHECK (chat_kind IN ('direct', 'group')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'revoked')),
      remote_session_id TEXT,
      approval_session_id TEXT,
      created_at INTEGER NOT NULL,
      authorized_at INTEGER,
      revoked_at INTEGER,
      UNIQUE (bluebubbles_instance_id, chat_guid, sender_handle)
    ) STRICT;

    CREATE INDEX relationships_status_idx ON relationships(status, created_at);

    CREATE TABLE challenges (
      id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      pin_salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining >= 0),
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      expired_at INTEGER,
      displayed_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK (consumed_at IS NULL OR expired_at IS NULL)
    ) STRICT;

    CREATE UNIQUE INDEX challenges_one_active_idx
      ON challenges(relationship_id)
      WHERE consumed_at IS NULL AND expired_at IS NULL AND attempts_remaining > 0;

    CREATE TABLE permission_reviews (
      id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      remote_session_id TEXT NOT NULL,
      permission_id TEXT NOT NULL UNIQUE,
      admin_session_id TEXT NOT NULL UNIQUE,
      review_code_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'resolving_once', 'resolving_reject', 'approved', 'rejected', 'expired')),
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK (
        (status IN ('pending', 'resolving_once', 'resolving_reject') AND decided_at IS NULL)
        OR (status IN ('approved', 'rejected', 'expired') AND decided_at IS NOT NULL)
      )
    ) STRICT;

    CREATE INDEX permission_reviews_status_idx ON permission_reviews(status, expires_at);

    CREATE TABLE processed_messages (
      bluebubbles_instance_id TEXT NOT NULL,
      message_guid TEXT NOT NULL,
      date_created INTEGER,
      claimed_at INTEGER NOT NULL,
      processed_at INTEGER,
      outcome TEXT CHECK (outcome IN ('ignored', 'processed', 'failed')),
      PRIMARY KEY (bluebubbles_instance_id, message_guid),
      CHECK ((outcome IS NULL AND processed_at IS NULL) OR (outcome IS NOT NULL AND processed_at IS NOT NULL))
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE cursors (
      bluebubbles_instance_id TEXT PRIMARY KEY,
      last_date_created INTEGER NOT NULL,
      last_message_guid TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE leader_lease (
      instance_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at >= heartbeat_at)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE outbound_deliveries (
      id TEXT PRIMARY KEY,
      bluebubbles_instance_id TEXT NOT NULL,
      relationship_id TEXT REFERENCES relationships(id) ON DELETE SET NULL,
      source_message_guid TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'indeterminate')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (bluebubbles_instance_id, source_message_guid)
    ) STRICT;

    CREATE INDEX outbound_deliveries_status_idx ON outbound_deliveries(status, updated_at);

    CREATE TABLE outbound_chunks (
      delivery_id TEXT NOT NULL REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      temp_guid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'indeterminate')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      error_category TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (delivery_id, chunk_index)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE rate_limits (
      scope TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL CHECK (count >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, subject_key, window_start)
    ) STRICT, WITHOUT ROWID;
  `,
  `
    ALTER TABLE outbound_chunks ADD COLUMN bluebubbles_message_guid TEXT;
  `,
  `
    CREATE TABLE project_bindings (
      instance_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;
  `,
  `
    ALTER TABLE permission_reviews ADD COLUMN question_request_id TEXT;
    CREATE UNIQUE INDEX permission_reviews_question_idx
      ON permission_reviews(question_request_id)
      WHERE question_request_id IS NOT NULL;
  `,
  `
    CREATE UNIQUE INDEX relationships_one_group_idx
      ON relationships(bluebubbles_instance_id, chat_guid)
      WHERE chat_kind = 'group';
  `,
  `
    CREATE TABLE personality_token_state (
      relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value >= 0 AND value <= 100),
      description TEXT NOT NULL,
      PRIMARY KEY (relationship_id, token)
    ) STRICT, WITHOUT ROWID;
  `,
]

type RelationshipKey = {
  instanceId: string
  chatGuid: string
  senderHandle: string
}

export class Store {
  readonly db: Database

  constructor(path: string) {
    if (path !== ":memory:") {
      const absolute = resolve(path)
      const parent = dirname(absolute)
      const parentExisted = existsSync(parent)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      if (!parentExisted) chmodSync(parent, 0o700)
    }

    this.db = new Database(path, { create: true, strict: true })
    if (path !== ":memory:") chmodSync(resolve(path), 0o600)
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA journal_mode = WAL")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        applied_at INTEGER NOT NULL
      ) STRICT
    `)
    const current = this.db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }
    if (current.version > MIGRATIONS.length) throw new Error(`Database schema version ${current.version} is newer than supported version ${MIGRATIONS.length}`)
    for (let index = current.version; index < MIGRATIONS.length; index += 1) {
      const sql = MIGRATIONS[index]
      if (sql === undefined) throw new Error("Missing migration")
      this.transaction(() => {
        this.db.exec(sql)
        this.db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, Date.now())
      })
    }
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  getSchemaVersion(): number {
    return (this.db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version
  }

  getRelationship(key: RelationshipKey): Relationship | null {
    return this.db.query(`
      SELECT * FROM relationships
      WHERE bluebubbles_instance_id = ? AND chat_guid = ? AND sender_handle = ?
    `).get(key.instanceId, key.chatGuid, key.senderHandle) as Relationship | null
  }

  getRelationshipById(id: string): Relationship | null {
    return this.db.query("SELECT * FROM relationships WHERE id = ?").get(id) as Relationship | null
  }

  getRelationshipByRemoteSession(remoteSessionId: string): Relationship | null {
    return this.db.query("SELECT * FROM relationships WHERE remote_session_id = ?").get(remoteSessionId) as Relationship | null
  }

  getGroupRelationship(instanceId: string, chatGuid: string): Relationship | null {
    return this.db.query(`
      SELECT * FROM relationships
      WHERE bluebubbles_instance_id = ? AND chat_guid = ? AND chat_kind = 'group'
    `).get(instanceId, chatGuid) as Relationship | null
  }

  createPendingRelationship(input: RelationshipKey & { id: string; chatKind: ChatKind; createdAt?: number }): Relationship {
    const createdAt = input.createdAt ?? Date.now()
    this.db.query(`
      INSERT INTO relationships
        (id, bluebubbles_instance_id, chat_guid, sender_handle, chat_kind, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT (bluebubbles_instance_id, chat_guid, sender_handle) DO NOTHING
    `).run(input.id, input.instanceId, input.chatGuid, input.senderHandle, input.chatKind, createdAt)
    const relationship = this.getRelationship(input)
    if (relationship === null) throw new Error("Failed to create relationship")
    return relationship
  }

  setRelationshipSessions(id: string, remoteSessionId: string, approvalSessionId: string): boolean {
    return this.db.query(`
      UPDATE relationships SET remote_session_id = ?, approval_session_id = ?
      WHERE id = ? AND status = 'pending'
    `).run(remoteSessionId, approvalSessionId, id).changes === 1
  }

  authorizeRelationship(id: string, now = Date.now()): boolean {
    return this.db.query(`
      UPDATE relationships SET status = 'authorized', authorized_at = ?, revoked_at = NULL
      WHERE id = ? AND status = 'pending' AND remote_session_id IS NOT NULL
    `).run(now, id).changes === 1
  }

  replaceAuthorizedRemoteSession(id: string, remoteSessionId: string): boolean {
    return this.db.query(`
      UPDATE relationships SET remote_session_id = ?
      WHERE id = ? AND status = 'authorized'
    `).run(remoteSessionId, id).changes === 1
  }

  syncPersonalityTokens(relationshipId: string, tokens: Readonly<Record<string, { value: number; description: string }>>): PersonalityTokenState[] {
    return this.transaction(() => {
      for (const [token, definition] of Object.entries(tokens)) {
        this.db.query(`
          INSERT INTO personality_token_state (relationship_id, token, value, description)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (relationship_id, token) DO NOTHING
        `).run(relationshipId, token, definition.value, definition.description)
      }
      return this.db.query(`
        SELECT token, value, description FROM personality_token_state
        WHERE relationship_id = ? ORDER BY token
      `).all(relationshipId) as PersonalityTokenState[]
    })
  }

  adjustPersonalityToken(relationshipId: string, token: string, delta: number): number | null {
    return this.transaction(() => {
      const current = this.db.query(`
        SELECT value FROM personality_token_state WHERE relationship_id = ? AND token = ?
      `).get(relationshipId, token) as { value: number } | null
      if (current === null) return null
      const value = Math.max(0, Math.min(100, current.value + delta))
      this.db.query(`
        UPDATE personality_token_state SET value = ? WHERE relationship_id = ? AND token = ?
      `).run(value, relationshipId, token)
      return value
    })
  }

  createPersonalityToken(relationshipId: string, token: string, value: number, description: string): boolean {
    return this.db.query(`
      INSERT INTO personality_token_state (relationship_id, token, value, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (relationship_id, token) DO NOTHING
    `).run(relationshipId, token, value, description).changes === 1
  }

  revokeRelationship(id: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const changed = this.db.query(`
        UPDATE relationships SET status = 'revoked', revoked_at = ? WHERE id = ? AND status <> 'revoked'
      `).run(now, id).changes === 1
      if (changed) this.db.query(`
        UPDATE challenges SET expired_at = ?
        WHERE relationship_id = ? AND consumed_at IS NULL AND expired_at IS NULL
      `).run(now, id)
      return changed
    })
  }

  resetRevokedRelationship(id: string): boolean {
    return this.db.query(`
      UPDATE relationships
      SET status = 'pending', remote_session_id = NULL, approval_session_id = NULL,
          authorized_at = NULL, revoked_at = NULL
      WHERE id = ? AND status = 'revoked'
    `).run(id).changes === 1
  }

  listRelationships(status?: RelationshipStatus, limit = 100): Relationship[] {
    if (status === undefined) return this.db.query("SELECT * FROM relationships ORDER BY created_at DESC LIMIT ?").all(limit) as Relationship[]
    return this.db.query("SELECT * FROM relationships WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as Relationship[]
  }

  createChallenge(input: {
    id: string
    relationshipId: string
    pinSalt: string
    pinHash: string
    attempts: number
    expiresAt: number
    createdAt?: number
  }): Challenge {
    const now = input.createdAt ?? Date.now()
    return this.transaction(() => {
      this.db.query(`
        UPDATE challenges SET expired_at = ?
        WHERE relationship_id = ? AND consumed_at IS NULL AND expired_at IS NULL
      `).run(now, input.relationshipId)
      this.db.query(`
        INSERT INTO challenges
          (id, relationship_id, pin_salt, pin_hash, attempts_remaining, expires_at, created_at)
        SELECT ?, id, ?, ?, ?, ?, ? FROM relationships WHERE id = ? AND status = 'pending'
      `).run(input.id, input.pinSalt, input.pinHash, input.attempts, input.expiresAt, now, input.relationshipId)
      const challenge = this.db.query("SELECT * FROM challenges WHERE id = ?").get(input.id) as Challenge | null
      if (challenge === null) throw new Error("Pending relationship not found")
      return challenge
    })
  }

  attemptChallenge(
    relationshipId: string,
    verify: (pinSalt: string, pinHash: string) => boolean,
    now = Date.now(),
  ): ChallengeAttempt {
    return this.transaction(() => {
      const challenge = this.db.query(`
        SELECT * FROM challenges
        WHERE relationship_id = ? AND consumed_at IS NULL AND expired_at IS NULL
          AND displayed_at IS NOT NULL AND attempts_remaining > 0
      `).get(relationshipId) as Challenge | null
      if (challenge === null) return "unavailable"
      if (challenge.expires_at <= now) {
        this.db.query("UPDATE challenges SET expired_at = ? WHERE id = ? AND expired_at IS NULL").run(now, challenge.id)
        return "expired"
      }
      if (!verify(challenge.pin_salt, challenge.pin_hash)) {
        this.db.query("UPDATE challenges SET attempts_remaining = attempts_remaining - 1 WHERE id = ?").run(challenge.id)
        return challenge.attempts_remaining === 1 ? "locked" : "invalid"
      }
      const authorized = this.db.query(`
        UPDATE relationships SET status = 'authorized', authorized_at = ?, revoked_at = NULL
        WHERE id = ? AND status = 'pending' AND remote_session_id IS NOT NULL
      `).run(now, relationshipId).changes === 1
      if (!authorized) return "unavailable"
      this.db.query("UPDATE challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now, challenge.id)
      return "authorized"
    })
  }

  expireChallenges(now = Date.now()): number {
    return this.db.query(`
      UPDATE challenges SET expired_at = ?
      WHERE consumed_at IS NULL AND expired_at IS NULL AND (expires_at <= ? OR attempts_remaining = 0)
    `).run(now, now).changes
  }

  markChallengeDisplayed(id: string, now = Date.now()): boolean {
    return this.db.query(`
      UPDATE challenges SET displayed_at = ?
      WHERE id = ? AND displayed_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL
    `).run(now, id).changes === 1
  }

  hasDisplayedChallenge(relationshipId: string): boolean {
    return this.db.query(`
      SELECT 1 AS found FROM challenges
      WHERE relationship_id = ? AND displayed_at IS NOT NULL LIMIT 1
    `).get(relationshipId) !== null
  }

  claimMessage(instanceId: string, messageGuid: string, dateCreated: number | null, now = Date.now()): boolean {
    return this.db.query(`
      INSERT INTO processed_messages
        (bluebubbles_instance_id, message_guid, date_created, claimed_at)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(instanceId, messageGuid, dateCreated, now).changes === 1
  }

  finishMessage(
    instanceId: string,
    messageGuid: string,
    outcome: TerminalMessageOutcome,
    now = Date.now(),
  ): boolean {
    return this.db.query(`
      UPDATE processed_messages SET outcome = ?, processed_at = ?
      WHERE bluebubbles_instance_id = ? AND message_guid = ? AND outcome IS NULL
    `).run(outcome, now, instanceId, messageGuid).changes === 1
  }

  getMessageOutcome(instanceId: string, messageGuid: string): TerminalMessageOutcome | null | undefined {
    const row = this.db.query(`
      SELECT outcome FROM processed_messages
      WHERE bluebubbles_instance_id = ? AND message_guid = ?
    `).get(instanceId, messageGuid) as { outcome: TerminalMessageOutcome | null } | null
    return row?.outcome
  }

  failUnfinishedMessages(now = Date.now()): number {
    return this.db.query(`
      UPDATE processed_messages SET outcome = 'failed', processed_at = ? WHERE outcome IS NULL
    `).run(now).changes
  }

  finishMessageAndSetCursor(
    instanceId: string,
    messageGuid: string,
    outcome: TerminalMessageOutcome,
    dateCreated: number,
    now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      if (!this.finishMessage(instanceId, messageGuid, outcome, now)) return false
      this.setCursor(instanceId, dateCreated, messageGuid, now)
      return true
    })
  }

  setCursor(instanceId: string, dateCreated: number, messageGuid: string, now = Date.now()): void {
    this.db.query(`
      INSERT INTO cursors (bluebubbles_instance_id, last_date_created, last_message_guid, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (bluebubbles_instance_id) DO UPDATE SET
        last_date_created = excluded.last_date_created,
        last_message_guid = excluded.last_message_guid,
        updated_at = excluded.updated_at
      WHERE excluded.last_date_created >= cursors.last_date_created
    `).run(instanceId, dateCreated, messageGuid, now)
  }

  getCursor(instanceId: string): { last_date_created: number; last_message_guid: string; updated_at: number } | null {
    return this.db.query(`
      SELECT last_date_created, last_message_guid, updated_at FROM cursors WHERE bluebubbles_instance_id = ?
    `).get(instanceId) as { last_date_created: number; last_message_guid: string; updated_at: number } | null
  }

  acquireLeaderLease(instanceId: string, ownerId: string, now: number, ttlMs: number): LeaderLease | null {
    if (ttlMs <= 0) throw new Error("Lease TTL must be positive")
    return this.transaction(() => {
      const existing = this.getLeaderLease(instanceId)
      if (existing !== null && existing.expires_at > now && existing.owner_id !== ownerId) return null
      const generation = existing === null
        ? 1
        : existing.owner_id === ownerId && existing.expires_at > now
          ? existing.generation
          : existing.generation + 1
      this.db.query(`
        INSERT INTO leader_lease (instance_id, owner_id, generation, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (instance_id) DO UPDATE SET
          owner_id = excluded.owner_id, generation = excluded.generation,
          heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
      `).run(instanceId, ownerId, generation, now, now + ttlMs)
      return this.getLeaderLease(instanceId)
    })
  }

  renewLeaderLease(instanceId: string, ownerId: string, generation: number, now: number, ttlMs: number): boolean {
    if (ttlMs <= 0) throw new Error("Lease TTL must be positive")
    return this.db.query(`
      UPDATE leader_lease SET heartbeat_at = ?, expires_at = ?
      WHERE instance_id = ? AND owner_id = ? AND generation = ? AND expires_at > ?
    `).run(now, now + ttlMs, instanceId, ownerId, generation, now).changes === 1
  }

  releaseLeaderLease(instanceId: string, ownerId: string, generation: number): boolean {
    return this.db.query(`
      DELETE FROM leader_lease WHERE instance_id = ? AND owner_id = ? AND generation = ?
    `).run(instanceId, ownerId, generation).changes === 1
  }

  getLeaderLease(instanceId: string): LeaderLease | null {
    return this.db.query("SELECT * FROM leader_lease WHERE instance_id = ?").get(instanceId) as LeaderLease | null
  }

  bindProject(instanceId: string, projectKey: string, now = Date.now()): "bound" | "existing" | "conflict" {
    if (!instanceId || !projectKey) throw new Error("Project binding values must not be empty")
    return this.transaction(() => {
      const existing = this.db.query(
        "SELECT project_key FROM project_bindings WHERE instance_id = ?",
      ).get(instanceId) as { project_key: string } | null
      if (existing !== null) return existing.project_key === projectKey ? "existing" : "conflict"
      this.db.query(`
        INSERT INTO project_bindings (instance_id, project_key, bound_at) VALUES (?, ?, ?)
      `).run(instanceId, projectKey, now)
      return "bound"
    })
  }

  createOutboundDelivery(input: {
    id: string
    instanceId: string
    relationshipId: string | null
    sourceMessageGuid: string | null
    chunks: readonly { tempGuid: string }[]
    now?: number
  }): OutboundDelivery {
    const now = input.now ?? Date.now()
    return this.transaction(() => {
      this.db.query(`
        INSERT INTO outbound_deliveries
          (id, bluebubbles_instance_id, relationship_id, source_message_guid, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(input.id, input.instanceId, input.relationshipId, input.sourceMessageGuid, now, now)
      const insertChunk = this.db.query(`
        INSERT INTO outbound_chunks (delivery_id, chunk_index, temp_guid, status, updated_at)
        VALUES (?, ?, ?, 'pending', ?)
      `)
      input.chunks.forEach((chunk, index) => insertChunk.run(input.id, index, chunk.tempGuid, now))
      return this.getOutboundDelivery(input.id) as OutboundDelivery
    })
  }

  markOutboundChunk(
    deliveryId: string,
    chunkIndex: number,
    status: DeliveryStatus,
    errorCategory: string | null = null,
    now = Date.now(),
    blueBubblesMessageGuid: string | null = null,
  ): boolean {
    return this.transaction(() => {
      const changed = this.db.query(`
        UPDATE outbound_chunks
        SET status = ?, error_category = ?,
            bluebubbles_message_guid = COALESCE(?, bluebubbles_message_guid),
            attempts = attempts + CASE WHEN status = 'pending' THEN 1 ELSE 0 END,
            updated_at = ?
        WHERE delivery_id = ? AND chunk_index = ?
      `).run(status, errorCategory, blueBubblesMessageGuid, now, deliveryId, chunkIndex).changes === 1
      if (!changed) return false
      const aggregate = this.db.query(`
        SELECT
          COUNT(*) AS total,
          SUM(status = 'delivered') AS delivered,
          SUM(status = 'failed') AS failed,
          SUM(status = 'indeterminate') AS indeterminate,
          SUM(status = 'sending') AS sending
        FROM outbound_chunks WHERE delivery_id = ?
      `).get(deliveryId) as { total: number; delivered: number; failed: number; indeterminate: number; sending: number }
      const deliveryStatus: DeliveryStatus = aggregate.indeterminate > 0
        ? "indeterminate"
        : aggregate.failed > 0
          ? "failed"
          : aggregate.total > 0 && aggregate.delivered === aggregate.total
            ? "delivered"
            : aggregate.sending > 0 || aggregate.delivered > 0
              ? "sending"
              : "pending"
      this.db.query("UPDATE outbound_deliveries SET status = ?, updated_at = ? WHERE id = ?").run(deliveryStatus, now, deliveryId)
      return true
    })
  }

  getOutboundDelivery(id: string): OutboundDelivery | null {
    return this.db.query("SELECT * FROM outbound_deliveries WHERE id = ?").get(id) as OutboundDelivery | null
  }

  listOutboundChunks(deliveryId: string): OutboundChunk[] {
    return this.db.query("SELECT * FROM outbound_chunks WHERE delivery_id = ? ORDER BY chunk_index").all(deliveryId) as OutboundChunk[]
  }

  createPermissionReview(input: {
    id: string
    relationshipId: string
    remoteSessionId: string
    permissionId: string
    adminSessionId: string
    reviewCodeHash: string
    expiresAt: number
    createdAt?: number
  }): PermissionReview {
    const now = input.createdAt ?? Date.now()
    this.db.query(`
      INSERT INTO permission_reviews
        (id, relationship_id, remote_session_id, permission_id, admin_session_id,
         review_code_hash, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.id, input.relationshipId, input.remoteSessionId, input.permissionId,
      input.adminSessionId, input.reviewCodeHash, input.expiresAt, now,
    )
    return this.getPermissionReview(input.id) as PermissionReview
  }

  getPermissionReview(id: string): PermissionReview | null {
    return this.db.query("SELECT * FROM permission_reviews WHERE id = ?").get(id) as PermissionReview | null
  }

  getPermissionReviewByAdminSession(adminSessionId: string): PermissionReview | null {
    return this.db.query("SELECT * FROM permission_reviews WHERE admin_session_id = ?").get(adminSessionId) as PermissionReview | null
  }

  getPermissionReviewByPermission(permissionId: string): PermissionReview | null {
    return this.db.query("SELECT * FROM permission_reviews WHERE permission_id = ?").get(permissionId) as PermissionReview | null
  }

  attachPermissionReviewQuestion(id: string, adminSessionId: string, requestId: string): boolean {
    return this.db.query(`
      UPDATE permission_reviews SET question_request_id = ?
      WHERE id = ? AND admin_session_id = ? AND status = 'pending' AND question_request_id IS NULL
    `).run(requestId, id, adminSessionId).changes === 1
  }

  getPermissionReviewByQuestion(requestId: string): PermissionReview | null {
    return this.db.query(
      "SELECT * FROM permission_reviews WHERE question_request_id = ?",
    ).get(requestId) as PermissionReview | null
  }

  hasPendingPermissionReview(remoteSessionId: string): boolean {
    return this.db.query(`
      SELECT 1 AS found FROM permission_reviews
      WHERE remote_session_id = ? AND status = 'pending' LIMIT 1
    `).get(remoteSessionId) !== null
  }

  rejectPendingPermissionReviews(remoteSessionId: string, now = Date.now()): number {
    return this.db.query(`
      UPDATE permission_reviews SET status = 'rejected', decided_at = ?
      WHERE remote_session_id = ? AND status = 'pending'
    `).run(now, remoteSessionId).changes
  }

  isAdministratorSession(sessionId: string): boolean {
    const enrollment = this.db.query(
      "SELECT 1 AS found FROM relationships WHERE approval_session_id = ? LIMIT 1",
    ).get(sessionId)
    if (enrollment !== null) return true
    return this.db.query(
      "SELECT 1 AS found FROM permission_reviews WHERE admin_session_id = ? LIMIT 1",
    ).get(sessionId) !== null
  }

  resolvePermissionReview(id: string, adminSessionId: string, decision: ReviewDecision, now = Date.now()): boolean {
    return this.db.query(`
      UPDATE permission_reviews SET status = ?, decided_at = ?
      WHERE id = ? AND admin_session_id = ? AND status = 'pending' AND expires_at > ?
    `).run(decision, now, id, adminSessionId, now).changes === 1
  }

  decidePermissionReview(
    id: string,
    adminSessionId: string,
    decision: ReviewDecision,
    verify: (reviewCodeHash: string) => boolean,
    now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      const review = this.db.query(`
        SELECT * FROM permission_reviews
        WHERE id = ? AND admin_session_id = ? AND status = 'pending'
      `).get(id, adminSessionId) as PermissionReview | null
      if (review === null || review.expires_at <= now || !verify(review.review_code_hash)) return false
      return this.resolvePermissionReview(id, adminSessionId, decision, now)
    })
  }

  reservePermissionReviewDecision(
    id: string,
    adminSessionId: string,
    decision: "once" | "reject",
    verify: (reviewCodeHash: string) => boolean,
    now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      const review = this.db.query(`
        SELECT * FROM permission_reviews
        WHERE id = ? AND admin_session_id = ? AND status = 'pending'
      `).get(id, adminSessionId) as PermissionReview | null
      if (review === null || review.expires_at <= now || !verify(review.review_code_hash)) return false
      const status = decision === "once" ? "resolving_once" : "resolving_reject"
      return this.db.query(`
        UPDATE permission_reviews SET status = ?
        WHERE id = ? AND admin_session_id = ? AND status = 'pending'
      `).run(status, id, adminSessionId).changes === 1
    })
  }

  reservePermissionReviewQuestionDecision(
    id: string,
    adminSessionId: string,
    decision: "once" | "reject",
    now = Date.now(),
  ): boolean {
    const status = decision === "once" ? "resolving_once" : "resolving_reject"
    return this.db.query(`
      UPDATE permission_reviews SET status = ?
      WHERE id = ? AND admin_session_id = ? AND status = 'pending' AND expires_at > ?
        AND question_request_id IS NOT NULL
    `).run(status, id, adminSessionId, now).changes === 1
  }

  completePermissionReviewDecision(id: string, decision: ReviewDecision, now = Date.now()): boolean {
    const expected = decision === "approved" ? "resolving_once" : "resolving_reject"
    return this.db.query(`
      UPDATE permission_reviews SET status = ?, decided_at = ?
      WHERE id = ? AND status = ?
    `).run(decision, now, id, expected).changes === 1
  }

  failResolvingPermissionReview(id: string, now = Date.now()): boolean {
    return this.db.query(`
      UPDATE permission_reviews SET status = 'rejected', decided_at = ?
      WHERE id = ? AND status IN ('resolving_once', 'resolving_reject')
    `).run(now, id).changes === 1
  }

  expirePermissionReviews(now = Date.now()): string[] {
    return this.transaction(() => {
      const ids = this.db.query(`
        SELECT id FROM permission_reviews WHERE status = 'pending' AND expires_at <= ?
      `).all(now) as { id: string }[]
      this.db.query(`
        UPDATE permission_reviews SET status = 'expired', decided_at = ?
        WHERE status = 'pending' AND expires_at <= ?
      `).run(now, now)
      return ids.map(({ id }) => id)
    })
  }

  listPermissionReviews(status: PermissionReview["status"] = "pending", limit = 100): PermissionReview[] {
    return this.db.query(`
      SELECT * FROM permission_reviews WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `).all(status, limit) as PermissionReview[]
  }

  incrementRateLimit(scope: string, subjectKey: string, windowStart: number, now = Date.now()): number {
    this.db.query(`
      INSERT INTO rate_limits (scope, subject_key, window_start, count, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (scope, subject_key, window_start) DO UPDATE SET
        count = count + 1, updated_at = excluded.updated_at
    `).run(scope, subjectKey, windowStart, now)
    return (this.db.query(`
      SELECT count FROM rate_limits WHERE scope = ? AND subject_key = ? AND window_start = ?
    `).get(scope, subjectKey, windowStart) as { count: number }).count
  }

  pruneRateLimits(before: number): number {
    return this.db.query("DELETE FROM rate_limits WHERE window_start < ?").run(before).changes
  }

  databaseMode(): number | null {
    if (this.db.filename === ":memory:") return null
    return statSync(this.db.filename).mode & 0o777
  }
}

export { Store as StateStore }
