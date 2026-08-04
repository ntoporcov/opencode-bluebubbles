# OpenCode BlueBubbles

Securely bridge iMessage conversations from a BlueBubbles server into isolated
[OpenCode](https://opencode.ai/) sessions.

> [!IMPORTANT]
> This repository currently contains the researched architecture and security
> plan. The plugin has not been implemented yet.

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
7. Shell, edit, network, and similar operations pause for approval in a
   separate administrator review session.

Group messages are processed only when they begin with a configurable alias,
such as `@opencode`. Authorization is scoped to both the sender handle and the
group chat GUID.

## Architecture

The full research, protocol details, threat model, state machine, permission
broker design, package layout, and test plan are in
[docs/architecture.md](docs/architecture.md).

## Security Position

The proposed design intentionally:

- Uses Socket.IO rather than exposing a BlueBubbles webhook receiver.
- Reads the BlueBubbles password from an environment variable or secret store.
- Allows plaintext BlueBubbles transport only over loopback.
- Stores PIN hashes rather than plaintext PINs in plugin state.
- Never forwards an unknown sender's initial message to a model.
- Rejects duplicate and outgoing BlueBubbles events.
- Prevents remote sessions from invoking administrator decision tools.
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
