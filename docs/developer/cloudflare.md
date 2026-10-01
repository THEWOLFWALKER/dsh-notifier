# Cloudflare deployment and Telegram forwarding

`src/cloudflare/deployment.mjs` owns deployment metadata. `wrangler-runner.mjs` lazily
installs and invokes Wrangler 4.119.0. Plugin startup performs no tool installation,
login, account discovery or cloud IO.

## Telegram

The Worker forwards only to `api.telegram.org` and one configured bot. `BOT_TOKEN`
is the only secret required by the deployed service. Native automatic configuration
uses `/api/<method>` and the `x-notifier-gateway-key` header with that same token.
The persisted `gatewayKey` is a transport compatibility field, not a separately
generated credential. Both notification and inbound configurations receive the same
endpoint and token in one canonical store transaction.

A custom `apiBase` with no header credential uses the ordinary Bot API path
`/bot<token>/<method>`. The template accepts this path only for its configured bot,
so importing an existing gateway requires only its root address. This compatibility
mode includes the token in the request URL; automatically configured connections use
the header path. Worker observability is disabled and the template logs no requests.

Multipart uploads and response bodies stream through. Status codes, JSON and
Retry-After survive forwarding. Authentication failures have a distinct response
marker. There is no direct fallback, configurable upstream destination or query-string
credential. Rotating a local bot token without updating the Worker is rejected before
sending a request.

## Deployment and local save

The UI opts into login and deployment explicitly. Device login exposes only the
official verification URL and user code. Multiple accounts require a selection.
Subprocesses use `shell: false`; secrets are written to a temporary private file,
never passed as command arguments, and removed after deployment. Output is bounded.

Resource names and ownership are durably recorded before creating resources. Bark
retries resolve an exact database name and reuse its ID. Wrangler's structured deploy
output provides endpoint/version; the service retains that cloud success before
readback and health checks. A failed verification does not erase cloud ownership.

For Telegram the default workflow deploys, obtains the address, checks the service,
and saves local channel settings automatically. Canonical outbound/inbound plans
merge in the same durable transaction. If local saving fails, prior channel settings
remain and the deployed service can be linked later. Cancellation stops the current
job; disposal aborts the active subprocess. Resources are never deleted automatically.

Unbind restores the previous transport settings only while this deployment is still
selected. Later manual endpoint edits survive. Cloud resources remain owned by the
user and are removed through their Cloudflare account if desired.

## Bark and APNs

The Bark template is an isolated GPL-3.0 derivative of cwxiaos/bark-worker; source,
migrations, attribution and license ship together. The original public signing key
matches the Bark project's published self-hosting configuration. It is intentionally
retained for personal self-hosting. Environment overrides remain possible.

Registration is closed by default. The UI allows explicit enrollment; existing
devices continue to work after enrollment is closed. Administrative info/MCP endpoints
are hidden. APNs JWT encoding uses base64url.

## Evidence

Core fixtures cover authentication, fixed destination, stream bytes, 429, abort,
resource reuse, atomic binding, local-save failure, manual edit preservation and the
one-click workflow. Real React DOM checks cover gateway entry, editable custom
address, automatic save and manual link/unbind. Miniflare/workerd tests execute real
D1 migrations and Bark registration, validate a signed APNs request against a local
upstream, and run Telegram forwarding with deterministic upstream responses.

These are local runtime/protocol checks. Production Cloudflare account deployment,
Apple receipt on a physical device, and Telegram delivery in a live chat require
account/device evidence; they are not implied by the fixture results.
