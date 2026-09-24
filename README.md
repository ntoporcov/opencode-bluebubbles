# OpenCode BlueBubbles

Securely bridge iMessage conversations from a BlueBubbles server into isolated
[OpenCode](https://opencode.ai/) sessions.

> [!IMPORTANT]
> This plugin controls a privileged development agent. Review the security
> model and test against your exact OpenCode and BlueBubbles versions before
> relying on it outside a trusted environment.

## Goals

- Receive BlueBubbles messages over an authenticated Socket.IO connection.
- Map each authorized sender and chat to a dedicated OpenCode session.
- Require administrator approval through a short-lived, one-time PIN.
- Support direct messages and explicitly addressed group messages.
- Route sensitive OpenCode permission requests to separate administrator
  review sessions.
- Send assistant responses back through the BlueBubbles REST API.
- Keep unknown messages away from the model until authorization succeeds.

## Proposed Flow

1. An unknown sender addresses the bridge.
2. The plugin creates a pending relationship and an isolated OpenCode session.
3. A separate administrator session displays a one-time PIN without invoking a
   model.
4. The administrator approves the sender by sharing that PIN out of band.
5. The sender returns the PIN in the original chat.
6. Future messages from that exact sender and chat can reach the restricted
   OpenCode agent.
7. Workspace reads, edits, network, and similar operations pause for approval
   in a separate administrator review session. Shell, subagent, and skill
   execution are denied in the first release.

Group messages are processed only when they begin with a configurable alias,
such as `@opencode`. Authorization is scoped to both the sender handle and the
group chat GUID.

## Architecture

The full research, protocol details, threat model, state machine, permission
broker design, package layout, and test plan are in
[docs/architecture.md](docs/architecture.md).

## Development Setup

The repository includes a project-scoped `opencode.jsonc` that loads the local
TypeScript entry point. It expects BlueBubbles on `http://127.0.0.1:1234` and
reads its password from `BLUEBUBBLES_PASSWORD`.

```sh
npm install
npm run typecheck
npx --yes bun test
npm run build
```

Start OpenCode from this repository with the password in its environment. Do
not place the password in `opencode.jsonc`, logs, SQLite, or a tracked file.

The first build intentionally denies shell, subagent, and skill execution from
remote sessions. Workspace file and network operations require one-time local
review. Credential, OpenCode control-plane, and plugin-state paths are
permanently denied.

Authorized requests receive a configurable tapback and typing indicator when
processing begins. Typing pauses while local permission is pending and resumes
after the decision. The bridge also sends a configurable status message once
for that request. Set `thinkingReaction` or `permissionWaitMessage` to `false`,
or set `typingIndicator` to `false`, to disable an individual signal.

Set `sessionDirectory` to place every bridge-created conversation in one
dedicated OpenCode project, separate from the server's working directory. Set
`model` to a provider-qualified model ID, such as `openai/gpt-5.4-mini`, to
select the model for BlueBubbles chats without changing other OpenCode agents.

`allowedTools` is an exact-name allowlist for tools that authorized chats may
run without administrator review. Tools omitted from the list continue to ask
for one-time approval. Shell, subagent, skill, and BlueBubbles administrator
tools cannot be allowlisted.

Set `toolCallMessages` to `true` to send an opt-in, argument-free status
message when each remote tool starts: `Running <tool>`. The bridge does not
edit that message or send a separate completion status because private message
editing is not safe across BlueBubbles and macOS versions. Failed status sends
do not block the tool or final response.

On first startup, the bridge begins observing at the current time rather than
processing historical messages. Direct messages qualify automatically. Group
messages must begin with the configured alias, such as `@opencode`.

## Security Position

The proposed design intentionally:

- Uses Socket.IO rather than exposing a BlueBubbles webhook receiver.
- Reads the BlueBubbles password from an environment variable or secret store.
- Allows plaintext BlueBubbles transport only over loopback.
- Stores PIN hashes rather than plaintext PINs in plugin state.
- Never forwards an unknown sender's initial message to a model.
- Rejects duplicate and outgoing BlueBubbles events.
- Resolves approvals only from native questions bound to administrator review sessions.
- Offers only one-time approval or rejection for OpenCode permission requests.
- Permanently denies access to credential files and sensitive external paths.

This bridge controls an agent capable of interacting with a development
environment. It should be treated as a privileged remote-access service, not a
general-purpose chatbot.

## Research Sources

- [BlueBubbles REST API and webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks.md)
- [BlueBubbles Socket.IO server](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/api/http/index.ts)
- [BlueBubbles message endpoint](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/api/http/api/v1/routers/messageRouter.ts)
- [OpenCode plugin documentation](https://opencode.ai/docs/plugins/)
- [OpenCode SDK documentation](https://opencode.ai/docs/sdk/)
- [OpenCode permission documentation](https://opencode.ai/docs/permissions/)

## License

[MIT](LICENSE)
