# CodexPro Remote Gateway

This mode exposes CodexPro through a VPS without opening the development machine to inbound Internet traffic.

## Flow

```text
Client / app
    |
    | HTTPS + Bearer client token
    v
VPS: CodexPro Gateway
    ^
    | outbound long-poll + Bearer node token
    |
Local machine: CodexPro Node
    |
    | Bearer local API token
    v
127.0.0.1:8787/v1/invoke
    |
    v
Local workspace / Git / bash
```

The VPS never mounts the local filesystem and does not execute workspace commands. The local node receives a job, calls the local CodexPro REST API, and uploads the bounded result back to the gateway.

## 1. Local CodexPro API

On the machine that owns the source code:

```bash
export CODEXPRO_ROOT=/path/to/repo
export CODEXPRO_ALLOWED_ROOTS=/path/to/repo
export CODEXPRO_HOST=127.0.0.1
export CODEXPRO_PORT=8787
export CODEXPRO_HTTP_TOKEN='replace-with-a-random-token-at-least-24-bytes'
export CODEXPRO_BASH_MODE=safe
export CODEXPRO_WRITE_MODE=handoff
export CODEXPRO_TOOL_MODE=standard
npm run start:http
```

Keep this server on loopback. The remote node is the only component that needs to reach it.

## 2. VPS Gateway

On the VPS:

```bash
export CODEXPRO_GATEWAY_HOST=127.0.0.1
export CODEXPRO_GATEWAY_PORT=8790
export CODEXPRO_GATEWAY_CLIENT_TOKEN='replace-with-a-random-client-token-at-least-24-bytes'
export CODEXPRO_GATEWAY_NODE_TOKEN='replace-with-a-different-random-node-token-at-least-24-bytes'
export CODEXPRO_GATEWAY_DEFAULT_NODE='my-pc'
npm run start:gateway
```

Put an HTTPS reverse proxy such as nginx, Caddy, or a cloud load balancer in front of `127.0.0.1:8790`. Do not expose the gateway over raw public HTTP.

The public endpoint can then be, for example:

```text
https://api.example.com/v1/invoke
```

## 3. Local outbound node

On the development machine, in a second process:

```bash
export CODEXPRO_NODE_ID='my-pc'
export CODEXPRO_GATEWAY_URL='https://api.example.com'
export CODEXPRO_GATEWAY_NODE_TOKEN='same-node-token-as-the-gateway'
export CODEXPRO_LOCAL_API_URL='http://127.0.0.1:8787'
export CODEXPRO_HTTP_TOKEN='same-token-as-the-local-CodexPro-server'
npm run start:node
```

The node only makes outbound HTTP(S) requests to the gateway. No router port-forward is required.

## 4. Call from another machine

With a default node configured:

```bash
curl https://api.example.com/v1/invoke \
  -H 'Authorization: Bearer YOUR_CLIENT_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "open_current_workspace",
    "args": { "include_tree": false }
  }'
```

For multiple nodes, pass `nodeId` explicitly:

```json
{
  "nodeId": "my-pc",
  "action": "read",
  "args": {
    "workspace_id": "ws_...",
    "path": "src/server.ts"
  }
}
```

List connected nodes:

```bash
curl https://api.example.com/v1/nodes \
  -H 'Authorization: Bearer YOUR_CLIENT_TOKEN'
```

## Security notes

- Gateway client and node tokens must be at least 24 UTF-8 bytes and should be independent random secrets.
- Keep the local CodexPro HTTP server bound to `127.0.0.1` in gateway mode.
- Put TLS in front of the VPS gateway before using it over the Internet.
- Local `allowedRoots`, `toolMode`, `writeMode`, `bashMode`, Zod validation, PathGuard, secret redaction, and tool policies remain authoritative because the node calls the same local `/v1/invoke` endpoint.
- A queued invocation that times out at the gateway is discarded instead of being executed later when a node reconnects.
- The first gateway implementation keeps node state and pending jobs in memory. Restarting the VPS gateway clears them; clients should retry intentionally rather than assuming durable delivery.
