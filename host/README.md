# Host adapter prototype

This directory contains a dependency-injected tool adapter and a browser-parent MessageChannel transport (`iframe-transport.mjs`). It is not installed in a DSH profile. The transport has Node MessageChannel tests with a simulated iframe, not real-browser acceptance. No real DSH tool-to-editor path has been verified. The browser session currently shows the parent page at `http://127.0.0.1:59239/` with its same-origin editor iframe loaded. Same-origin `/`, `/editor/`, `/health`, `/boot`, and authenticated `/editor-relay/register` were observed returning HTTP 200 from that browser context. Host PowerShell health and direct Node TCP checks also succeeded while the managed server process remained alive.

## Verify

From the prototype root:

```powershell
node host/editor-tools.test.mjs
node host/iframe-transport.test.mjs
node host/relay.test.mjs
```

The isolated prototype server in `prototype-server.mjs` serves the parent page at `/`, editor at `/editor/`, and maps `/editor/<path>` to `miniPaint/miniPaint-master/<path>` with runtime-asset allowlisting. The parent bootstraps a token from same-origin `/boot`, connects the iframe via `createIframeTransport({ iframe, origin: location.origin })`, and starts `browser-relay.mjs` polling `/editor-relay/*`. The local registry is explicitly a harness, not DSH. The current browser observed same-origin health/boot and relay registration responses, and the served bundle SHA-256 matches the latest build; this does not prove user-edit/undo acceptance or actual DSH Host registration.

This runs each suite in one Node process. Current recorded component results are: editor-tools 8/8, iframe-transport 3/3, relay 10/10. They are component tests, not end-to-end editor acceptance.

## Adapter interface

`registerEditorTools({ tools, defineTool, transport, timeoutMs, allowedOrigin })` registers `editor_read_state`, `editor_apply_command`, and `editor_get_command_result`. `tools` and `defineTool` are injected, not imported from a verified host installation. Registration with the actual DSH runtime remains unverified.

`transport.request(message, { timeoutMs, allowedOrigin })` must return the request result or reject with an editor error. It must bind requests to a specific editor instance and validate origin, source and request correlation. Passing allowedOrigin to this interface alone does not implement those protections.

The adapter uses the shared contract's explicit `commandEnvelope: { type, payload }`. `type` is an allowlisted command name; `payload` contains the command-specific fields.

## Revision and command outcomes

The adapter forwards expectedRevision unchanged to editor.apply_command. It deliberately does not use a host read-then-write check as authorization. The editor must serialize human edits and agent edits and atomically validate the live document id/revision at its native mutation boundary.

An apply timeout returns `EDITOR_TIMEOUT_OUTCOME_UNKNOWN` with the original `commandId`; it does not mean the command was not applied. Query `editor.get_command_result` using that same id. An `unknown` result never permits replay; the adapter instance continues blocking that command. An `applied` result allows returning the original outcome without reapplying. Under the shared contract's `retryRule`, a rejected command may only be corrected and submitted with a new `commandId` after the editor explicitly confirms that the original was not applied. The adapter does not automatically retry or infer this confirmation from a generic rejection.

Completed and uncertain maps are process-local conveniences, not authoritative durable idempotency. Editor-owned command outcome caching is mandatory, including after host restart, delayed responses and retransmission. Tests use simulated transport and cannot prove native editor atomicity or native undo integration.

## Node to parent-page relay

- Node: create `relay = createEditorRelay()`; inject it as `transport` into `registerEditorTools`. Mount `createRelayHttpHandler({ relay, origin, accessToken })` on an isolated same-origin HTTP server. Use a fresh random accessToken, at least 32 characters, supplied to its trusted parent page without URL/log exposure.
- Parent page: create the iframe transport, then `await startBrowserRelay({ transport, accessToken })`. It registers the editor instance and polls authenticated `/editor-relay/*` POST routes. The returned handle exposes editorInstanceId/pageId and an async stop method.
- Routing is bound to one live editor instance per page, with a page token, requestId correlation, single dispatch, lease expiry, bounded page/pending counts and timeouts. Origin + Host header and bearer authentication are required. Routes have no CORS allowance and never read/write project files.
- Disconnect/lease expiry rejects pending mutations with `EDITOR_TIMEOUT_OUTCOME_UNKNOWN`. A late response cannot resolve another request. State remains exclusively editor-owned.
- Tests: relay suite 10/10, including a temporary loopback HTTP server, simulated browser transport, forged-page rejection, timeout/disconnect, lease expiry, output size limits and reconnect/idempotency boundaries. Browser reachability was separately confirmed from the current browser session; these results still do not establish actual DSH tool-call acceptance.
- Actual DSH integration requires explicit loading of this adapter with tools/defineTool and mounting relay routes plus a trusted parent page in an isolated approved host. No existing desktop/web profile has been modified. A production install/configuration change requires separate approval; current artifacts are importable modules only.

## Remaining integration work

- Remaining acceptance: verify the full real-browser MessageChannel request path and user-visible edit/undo/redo state roundtrip. Current session verified page/iframe loading, same-origin health/boot, and relay registration, but did not perform an editor mutation.
- Verify actual DSH defineTool/parameter schema types and runtime loading in an explicitly approved isolated host.
- Verify Agent-triggered mutation and native history/revision outcome acceptance.
- Bounded cache lifecycle and stricter command/style/output validation before production.
- Save/reopen and valid PNG/JPEG export acceptance remain unverified.
