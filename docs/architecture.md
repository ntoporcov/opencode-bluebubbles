# OpenCode BlueBubbles Architecture

## Status

This document is the implementation plan for a project-scoped OpenCode plugin
that receives messages from BlueBubbles, enrolls senders using administrator-
mediated PINs, forwards authorized requests to OpenCode, and returns assistant
responses to iMessage.

Research was performed on August 4, 2026 against:

- BlueBubbles Server commit
  [`f2e2286`](https://github.com/BlueBubblesApp/bluebubbles-server/commit/f2e2286241a7c3b6617a82b37d4afaab4df3a6b9).
- The current OpenCode plugin, SDK, server, and permission documentation.
- The OpenCode `dev` source tree available during research.

Upstream contracts must be checked again before implementation because both
projects are actively developed.

## Decisions

| Area | Decision |
| --- | --- |
| Runtime | Project-scoped OpenCode plugin |
| Inbound BlueBubbles transport | Authenticated Socket.IO |
| Outbound BlueBubbles transport | REST API |
| Direct-message authorization | Sender handle plus chat GUID |
| Group authorization | Sender handle plus group chat GUID |
| Group activation | Message must begin with `@{configurableAlias}` |
| PIN approval | Sharing the PIN is the administrator's approval action |
| Remote agent | Restricted agent; plugin tools run directly |
| Sensitive OpenCode actions | Separate administrator permission review |
| Permission persistence | One-time approval only; no `always` option |

## Upstream Connection Details

### BlueBubbles Socket.IO

BlueBubbles runs Socket.IO on the same HTTP server as its REST API. It supports
the `websocket` and `polling` transports and accepts Engine.IO 3 clients for
compatibility.

Socket authentication uses a query parameter:

```text
?password=<server-password>
```

The alias `guid` is also accepted. Unlike REST authentication, the Socket.IO
connection does not accept the `token` alias in the researched server source.

The unsolicited message event is:

```text
new-message
```

Fields needed by the bridge are present in the serialized payload:

```ts
type BlueBubblesMessage = {
  guid: string
  text: string | null
  dateCreated: number | null
  isFromMe: boolean
  handle: {
    address: string
    service?: string
  } | null
  chats?: Array<{
    guid: string
    style: number
    displayName?: string
    participants?: Array<{ address: string }>
  }>
}
```

The bridge must validate this at runtime rather than trusting the remote
payload. Group participants are not consistently included in socket payloads,
so the sender must come from `handle.address`, not from the participant list.

Messages sent by the local account can have no sender handle. The bridge must
check `isFromMe` before requiring `handle.address`.

### BlueBubbles REST

Most REST calls authenticate through `guid`, `password`, or `token` in the
query string. Query strings containing credentials must never be logged.

The current text-send endpoint is:

```http
POST /api/v1/message/text?password=<server-password>
Content-Type: application/json
```

```json
{
  "chatGuid": "iMessage;+;chat-guid",
  "tempGuid": "bridge-generated-uuid",
  "message": "Response text",
  "method": "private-api"
}
```

The current server source expects `message`. An older BlueBubbles webhook
example uses `text`; implementation must follow the installed server's
validated contract.

`method` can be `private-api` or `apple-script`. AppleScript requires a
non-empty `tempGuid`, and the bridge should generate one for both methods to
support correlation and duplicate prevention.

Useful health and recovery endpoints include:

```text
GET  /api/v1/ping
GET  /api/v1/server/info
POST /api/v1/message/query
GET  /api/v1/chat/:guid
```

### Why Not BlueBubbles Webhooks

BlueBubbles supports `new-message` webhooks, but webhook delivery has no
signature, shared-secret header, bearer token, or retry queue. The webhook
record stores only a URL and event names. Delivery performs an unauthenticated
JSON POST.

Socket.IO is preferable because it creates an authenticated outbound
connection and does not require the plugin to expose an inbound HTTP server.

### OpenCode APIs

The plugin receives an OpenCode SDK client and can:

- Create and update sessions.
- Insert context with `noReply: true`.
- Prompt a session and wait for an assistant response.
- Register custom tools.
- Observe server events.
- Respond to pending permission requests.
- Display TUI notifications.

The researched public permission response endpoint accepts:

```ts
"once" | "always" | "reject"
```

The declared `permission.ask` plugin hook was not invoked in the researched
OpenCode source. The bridge should observe `permission.asked` through the
generic event hook and respond using the SDK permission endpoint. The exact
event name and SDK method must be confirmed against the target OpenCode
version before release.

## High-Level Architecture

```text
BlueBubbles Server
    |
    | Socket.IO: new-message
    v
OpenCode BlueBubbles Plugin
    |
    +-- runtime payload validation
    +-- sender/chat routing
    +-- enrollment state machine
    +-- OpenCode session manager
    +-- permission review broker
    +-- SQLite state and leader lease
    |
    | REST: POST /api/v1/message/text
    v
BlueBubbles Server -> Messages.app -> iMessage chat
```

The plugin starts with one designated OpenCode project and exits when that
OpenCode server exits. A persisted leader lease prevents two OpenCode
processes for the same configuration from both sending replies.

## Trust Boundaries

| Boundary | Trust Level |
| --- | --- |
| Incoming iMessage text | Untrusted |
| BlueBubbles event structure | Untrusted until validated |
| Authorized sender text | Authorized identity, untrusted instructions |
| Model output | Untrusted until constrained and encoded |
| OpenCode administrator session | Trusted local control plane |
| BlueBubbles password | Secret |
| OpenCode provider credentials | Secret and never remotely readable |
| Plugin state database | Sensitive local data |

Authorization means a sender may converse with a restricted OpenCode agent. It
does not make their prompts or requested tool arguments trustworthy.

## Identity and Relationship Model

A relationship key contains:

```text
BlueBubbles instance ID
+ chat GUID
+ normalized sender handle
```

The BlueBubbles instance ID prevents accidental state reuse after pointing the
plugin at a different server. It can be configured explicitly or derived from
stable server metadata.

The sender handle should preserve the BlueBubbles canonical address. Email
addresses may be trimmed and case-folded. Phone-number normalization must not
guess a country; E.164 normalization should happen only when a configured
region makes it unambiguous.

### Direct Chats

Each sender and direct-chat GUID maps to one OpenCode session. Every incoming
text message in an authorized direct relationship is treated as a request,
except reserved control messages such as PIN submission.

### Group Chats

Every sender in a group receives a separate relationship and OpenCode session.
Messages are processed only when they begin with the configured form:

```text
@<alias> <request>
```

For example:

```text
@opencode explain the failing integration test
```

The alias match should be case-insensitive, anchored at the start, and require
a boundary after the alias. The alias is stripped before the request reaches
OpenCode.

PIN control messages in a group must also use the alias:

```text
@opencode PIN 12345678
```

Replies are sent to the group chat and are visible to everyone. The bridge may
prefix replies with a short reference to the requesting sender when multiple
authorized participants use the same group.

## Enrollment State Machine

```text
unknown -> pending -> authorized
              |            |
              v            v
           expired       revoked
              |
              v
            locked
```

### Unknown Sender

When a qualifying message arrives from an unknown relationship:

1. Validate and deduplicate the event.
2. Atomically create a pending relationship.
3. Create its remote OpenCode session without prompting a model.
4. Generate a cryptographically random eight-digit PIN.
5. Store a salted cryptographic hash of the PIN.
6. Create a separate administrator approval session.
7. Insert approval information using `noReply: true`.
8. Display an OpenCode toast pointing to the approval session.
9. Tell the sender that administrator approval is required.

The administrator session should show:

- A masked sender identifier plus the full identifier where needed to verify
  identity.
- The direct or group chat GUID and display name.
- The relationship request ID.
- PIN expiration time.
- The clear PIN.
- A warning to inspect the original Messages conversation before sharing it.

It should not include the untrusted initial message as instructions to an
administrator-facing model. The administrator can inspect the original chat
directly.

The unknown sender's initial request never reaches a model. After authorization
the sender is told to resend it.

### PIN Verification

Recommended defaults:

| Control | Default |
| --- | --- |
| PIN length | 8 decimal digits |
| Lifetime | 15 minutes |
| Attempts | 5 |
| Active challenges | 1 per relationship |
| Comparison | Constant-time hash comparison |
| Reuse | Prohibited |

Only a fully anchored PIN command is accepted while pending. Invalid attempts
receive a generic response that does not reveal whether the format, challenge,
or individual digits were correct.

On success, one database transaction:

- Marks the challenge consumed.
- Marks the relationship authorized.
- Records the authorization timestamp.
- Keeps the existing remote session mapping.

Sharing the PIN is the administrator's affirmative approval. The PIN is added
to OpenCode through `noReply`, so no model request is required to display it.

### Challenge Abuse Controls

- Do not create a new approval session for every message while pending.
- Rate-limit enrollment replies per sender and chat.
- Lock the challenge after the attempt limit.
- Require a new challenge after expiration or lockout.
- Limit the number of new relationships per hour.
- Prune expired challenges after a retention interval.

## Authorized Message Processing

1. Resolve the exact authorized relationship.
2. Remove and validate the group alias when applicable.
3. Place the message on a per-session FIFO queue.
4. Submit it to the configured restricted OpenCode agent.
5. Wait for completion, a permission request, timeout, or failure.
6. Extract non-ignored assistant text parts only.
7. Split long text into ordered iMessage-safe chunks.
8. Send chunks through BlueBubbles REST using unique `tempGuid` values.
9. Record successful outbound correlation metadata.

Each relationship must process one prompt at a time. Other relationships can
run concurrently up to a configured global limit.

Attachment-only messages, reactions, system messages, group membership
changes, and message edits should be ignored in the first implementation. They
can be added after the text bridge is stable.

## Restricted Remote Agent

The plugin should define or require a dedicated agent, such as
`bluebubbles-remote`.

Safe plugin-provided tools may execute directly. Other operations should ask
for administrator permission or be permanently denied.

Suggested policy categories:

| Category | Policy |
| --- | --- |
| Bridge-specific safe tools | Allow |
| Workspace reads | Ask |
| Workspace edits | Ask |
| Shell commands | Ask |
| Web fetch/search | Ask |
| Subagents and skills | Ask |
| External directories | Deny by default |
| Credential and environment files | Always deny |
| OpenCode session sharing | Always deny |
| Plugin state and configuration secrets | Always deny |

The implementation must validate the final agent configuration against the
current OpenCode config schema rather than assuming an older permission shape.

## Administrator Permission Broker

Sensitive tools requested by an authorized remote sender remain pending until
the owner responds in a separate OpenCode session.

### Review Flow

1. Observe a permission event belonging to a managed remote session.
2. Persist a pending permission review.
3. Create a dedicated administrator review session.
4. Insert sanitized request details with `noReply: true`.
5. Generate a short random review code.
6. Notify the administrator through the OpenCode TUI.
7. Wait for an exact approval or rejection message.
8. Let the review agent invoke the plugin's decision tool.
9. Verify all authorization conditions inside the tool.
10. Reply `once` or `reject` to the original OpenCode permission.
11. Mark the review resolved and allow the original request to continue.

Example administrator messages:

```text
APPROVE ONCE K7M4
REJECT K7M4
```

### Decision Tool Enforcement

The custom tool, tentatively named `bluebubbles_permission_decide`, is a
security boundary. It must verify:

- Its caller session is the exact mapped administrator review session.
- The permission remains pending.
- The review code matches.
- The latest user-authored message exactly matches the expected command.
- The target permission belongs to a managed remote session.
- The decision is either one-time approval or rejection.
- The review has not expired or already been used.

A remote session can see the tool name but must receive an authorization error
if it attempts to call it. The tool must never expose an `always` decision.

OpenCode's `always` permission can create in-memory approval rules that affect
later requests and potentially other sessions in the same instance. It is too
broad for relationship-scoped remote access.

### Review Content Safety

Permission titles, patterns, commands, paths, and metadata originate from a
remote request and must be rendered as quoted data, not administrator
instructions. Length limits and control-character escaping are required.

The review agent should have no shell, file, network, task, or bridge tools
other than the narrowly gated decision tool.

Unanswered reviews should expire after a configured period and automatically
reject the original permission so a model request cannot remain blocked
indefinitely.

## Persistence

Use SQLite in the platform-appropriate application state directory. Create the
directory and database with owner-only permissions.

Suggested tables:

### `relationships`

```text
id
bluebubbles_instance_id
chat_guid
sender_handle
chat_kind
status
remote_session_id
approval_session_id
created_at
authorized_at
revoked_at
```

Unique key:

```text
(bluebubbles_instance_id, chat_guid, sender_handle)
```

### `challenges`

```text
id
relationship_id
pin_salt
pin_hash
attempts_remaining
expires_at
consumed_at
created_at
```

### `permission_reviews`

```text
id
relationship_id
remote_session_id
permission_id
admin_session_id
review_code_hash
status
expires_at
decided_at
```

### `processed_messages`

```text
message_guid primary key
date_created
processed_at
outcome
```

### `cursors`

```text
bluebubbles_instance_id primary key
last_date_created
last_message_guid
updated_at
```

### `leader_lease`

```text
instance_id primary key
owner_id
heartbeat_at
expires_at
```

Message bodies should not be duplicated into the state database. Authorized
conversation content already belongs to the associated OpenCode session.

## Reconnection and Delivery Semantics

Socket.IO provides realtime delivery but the bridge can miss messages while
OpenCode is stopped or disconnected.

### Connection Strategy

- Connect with the BlueBubbles password in the Socket.IO query.
- Prefer WebSocket while allowing polling fallback.
- Use exponential reconnect backoff with jitter.
- Validate the server through `/api/v1/ping` and `/api/v1/server/info`.
- Log connection state without logging credential-bearing URLs.

### Catch-Up Strategy

After connecting:

1. Subscribe to realtime events first.
2. Query messages after the persisted timestamp using
   `/api/v1/message/query`.
3. Process results oldest first.
4. Deduplicate by message GUID against both realtime and persisted events.
5. Advance the cursor only after an event reaches a terminal outcome.

On first installation, initialize the cursor to the current time. Historical
messages must not unexpectedly create enrollment requests.

BlueBubbles webhooks do not provide durable retries, so they do not improve
this delivery model.

## Transport Security

### BlueBubbles URL

- Allow `http://127.0.0.1`, `http://[::1]`, and `http://localhost`.
- Require HTTPS/WSS with certificate validation for non-loopback hosts.
- Reject credentials in the configured URL.
- Add authentication parameters immediately before a request.
- Redact the full query string from logs and errors.

### Secret Sources

The BlueBubbles password must be loaded from:

- A named environment variable, or
- A future macOS Keychain integration.

It must not be stored directly in `opencode.json`, plugin logs, SQLite, session
messages, or error telemetry.

### OpenCode Server

Keep OpenCode bound to loopback when possible. If it must be exposed, set
`OPENCODE_SERVER_PASSWORD`, use TLS through a trusted local proxy, and protect
administrator sessions as privileged control-plane access.

## Configuration

Conceptual OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-bluebubbles",
      {
        "serverUrl": "http://127.0.0.1:1234",
        "passwordEnv": "BLUEBUBBLES_PASSWORD",
        "alias": "opencode",
        "sendMethod": "private-api",
        "remoteAgent": "bluebubbles-remote",
        "pinExpiryMinutes": 15,
        "pinAttempts": 5,
        "permissionExpiryMinutes": 15,
        "maxConcurrentSessions": 4
      }
    ]
  ],
  "share": "disabled"
}
```

Plugin options must be validated strictly at startup. Invalid or insecure
configuration should prevent the bridge connection while leaving OpenCode
itself usable where possible.

The plugin should be configured at project scope. A globally installed bridge
could start once for every OpenCode project and produce duplicate replies.

## Proposed Package Layout

```text
src/
  index.ts          plugin entry, hooks, tools, and lifecycle
  config.ts         strict option and environment validation
  bluebubbles.ts    Socket.IO connection and REST requests
  messages.ts       payload validation, routing, and response chunks
  enrollment.ts     relationship and PIN state machine
  permissions.ts    administrator permission review broker
  sessions.ts       OpenCode session creation and prompting
  store.ts          SQLite schema, transactions, and leader lease
  security.ts       hashing, redaction, normalization, and rate limits
tests/
  enrollment.test.ts
  routing.test.ts
  permissions.test.ts
  reconnect.test.ts
  security.test.ts
  integration.test.ts
```

Keep dependencies limited. The expected core dependencies are:

- `@opencode-ai/plugin`
- A Socket.IO client compatible with the installed BlueBubbles server
- A runtime schema validator
- Bun's SQLite support

## Logging and Observability

Use `client.app.log()` for structured OpenCode logging.

Logs may include:

- Connection state.
- Hashed or masked relationship identifiers.
- Message GUIDs.
- Enrollment state transitions.
- Permission review IDs and outcomes.
- Retry counts and categorized failures.

Logs must not include:

- BlueBubbles passwords or credential-bearing URLs.
- PINs or review codes.
- Complete phone numbers or email addresses at normal log levels.
- Message content.
- OpenCode provider credentials.

## Failure Handling

| Failure | Behavior |
| --- | --- |
| BlueBubbles unavailable | Reconnect with backoff; do not lose cursor |
| Invalid Socket.IO auth | Disable retries after bounded attempts and alert admin |
| Malformed message | Log masked metadata and discard |
| OpenCode model failure | Return a short generic failure to the authorized chat |
| OpenCode permission timeout | Reject permission and notify chat |
| BlueBubbles send failure | Retry only when idempotency is safe |
| SQLite unavailable | Fail closed and do not process messages |
| Duplicate plugin instance | Non-leader remains inactive |
| Missing remote session | Recreate only after validating relationship state |

No automated retry should cause duplicate iMessages. Outbound retry logic must
use `tempGuid` correlation and confirm BlueBubbles behavior against the target
server version.

## Revocation and Administration

The first release should include narrowly scoped administrative plugin tools:

- List relationships with masked identities.
- Revoke a relationship.
- Reject or expire a pending enrollment.
- Rotate a pending PIN by creating a new challenge.
- Display bridge health and connection state.

Administrative tools must enforce administrator-session provenance in their
execution functions. Tool visibility is not an authorization boundary.

Revocation affects future messages immediately. It should not delete the
OpenCode session automatically; deletion is a separate, explicit retention
decision.

## Verification Plan

### Unit Tests

- Runtime parsing of direct, group, outgoing, attachment-only, and malformed
  BlueBubbles messages.
- Exact and case-insensitive `@alias` parsing with boundary checks.
- Relationship-key isolation across chats, senders, and servers.
- PIN generation, hashing, expiration, attempt limits, lockout, and one-time
  consumption.
- Constant-time comparison behavior at the API boundary.
- Log and URL redaction.
- Response chunking.
- Permission review gating and exact-command verification.

### Integration Tests

- Fake Socket.IO server with authentication and reconnects.
- Fake BlueBubbles REST server validating current request bodies.
- Fake OpenCode client for session creation, `noReply`, prompts, and
  permissions.
- Realtime event plus catch-up query race with GUID deduplication.
- SQLite restart recovery and transaction rollback.
- Leader-lease contention between two plugin processes.

### Security Tests

- Unknown messages never invoke an OpenCode model.
- A malicious group message without `@alias` is ignored.
- A PIN for one sender cannot authorize another group participant.
- A PIN for one chat cannot authorize another chat.
- A remote session cannot call an administrator decision tool.
- A decision tool call from the wrong review session fails.
- A stale or replayed review code fails.
- Remote command text cannot change the review tool's target permission.
- Credential and state paths remain denied after one-time tool approvals.
- Secrets and message content do not appear in logs.

### End-to-End Scenarios

1. Unknown direct sender, administrator PIN disclosure, successful
   authorization, resend, and assistant reply.
2. Unknown group sender without alias ignored.
3. Unknown group sender with alias enrolled and authorized.
4. Two authorized participants in one group maintain separate sessions.
5. Authorized request asks for a shell command, owner approves once, and the
   result returns to iMessage.
6. Owner rejects an edit request and the remote session receives a safe
   explanation.
7. Permission review expires and automatically rejects.
8. Plugin restarts, catches up missed messages, and does not replay processed
   requests.
9. Relationship is revoked and the next message requires enrollment again.

## Delivery Phases

### Phase 1: Connection and Observation

- Implement strict configuration.
- Connect to BlueBubbles Socket.IO.
- Validate and log masked message metadata.
- Implement SQLite, cursoring, deduplication, and leader election.
- Do not create sessions or send replies yet.

### Phase 2: Enrollment

- Add relationship and challenge state machines.
- Create remote and administrator approval sessions.
- Implement PIN verification and rate limits.
- Support direct chats and alias-addressed group chats.

### Phase 3: Restricted Conversation

- Add the remote agent profile.
- Prompt authorized sessions.
- Extract and chunk assistant text.
- Send replies through BlueBubbles REST.

### Phase 4: Permission Brokerage

- Observe OpenCode permission events.
- Create isolated administrator review sessions.
- Add the gated one-time decision tool.
- Add review expiration and automatic rejection.

### Phase 5: Hardening and Release

- Complete reconnect catch-up and idempotency tests.
- Add administrative revocation tools.
- Run live BlueBubbles and OpenCode contract tests.
- Document installation, operations, recovery, and incident response.
- Publish a version-pinned npm package.

## Open Questions for Implementation

- Which exact Socket.IO client version best matches supported BlueBubbles
  releases?
- Should private API or AppleScript be the default send method after probing
  `/api/v1/server/info`?
- What practical iMessage chunk size should be used for model responses?
- Which safe bridge-specific tools should be enabled in the initial release?
- How should administrators select or migrate the project associated with an
  existing relationship?
- Should an always-on companion daemon become an optional deployment mode
  after the project-scoped plugin is stable?

## References

- [BlueBubbles REST API and webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks.md)
- [BlueBubbles webhook example](https://docs.bluebubbles.app/server/developer-guides/simple-web-server-for-webhooks/python-web-server.md)
- [BlueBubbles Socket.IO implementation](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/api/http/index.ts)
- [BlueBubbles message validation](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/api/http/api/v1/validators/messageValidator.ts)
- [BlueBubbles message serialization](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/api/serializers/MessageSerializer.ts)
- [BlueBubbles webhook delivery](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/services/webhookService/index.ts)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode server](https://opencode.ai/docs/server/)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)
