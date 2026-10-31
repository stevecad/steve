# STEVE Studio integration

Connecting to STEVE Studio is optional. People sign in in their browser, select a
personal or permitted team workspace and choose CAD projects to download. Local CAD
execution and offline operation remain the default, and disconnecting keeps
downloaded projects usable. The implementation is in
`src/steve_desktop/studio_connection.py`, `src/steve_desktop/local_studio.py` and
`src/steve_desktop/local_feedback.py`.

## Public API contract

The desktop uses only STEVE Studio's public API; MCP and web-client credentials are
never used.

- `GET /api/v1/capabilities` must report `api: "steve"`, `sync_version: 1` and the
  `projects`, `workspaces` and `project_snapshots` features. Its `oauth` section
  advertises the authorization, token and revocation endpoints and the official
  public desktop client (`oauth.desktop_client`).
- Sign-in is public-client OAuth with PKCE and a loopback redirect on an arbitrary
  port. The desktop validates the advertised client (public client type, loopback
  callback, arbitrary-port support) and requests `designs:read`, plus `profile` and
  `feedback:write` when the client advertises them. A missing descriptor means
  desktop sign-in is not available; no guessed or locally configured client is
  substituted. No client registration or copied credentials are required.
- After sign-in, read-only `/api/v1` operations list workspaces and projects and
  download project snapshots. Disconnect revokes the grant at `/oauth/revoke` and
  removes local credentials.
- Downloaded snapshots are `steve.project` version 2 packages, imported with the
  existing archive validator. Original pinned inputs must be complete and
  checksummed; latest source is never substituted for a pinned revision.

## Implemented behavior

1. Browser OAuth with encrypted credentials, serialized noninteractive refresh, explicit
   reconnect on expired/revoked sessions, and local disconnect. Scope sync state by
   server, account and workspace identities.
2. Settings page for connection, project selection, status and refresh. Use the
   existing Settings components and show actionable structured transfer errors.
3. Stage complete immutable packages off the UI thread. Validate schema, checksums,
   paths and source/input closure before publishing an import. Preserve Studio's
   runtime and reference-build metadata for diagnosis; compatibility of geometry
   execution must be established by local builds, not inferred from archive validity.
   Adapt to the documented Studio format; do not force the local archive
   format on upstream.
4. Persist remote snapshot identity and local copy IDs. Skip unchanged transfers.
   Every changed remote snapshot creates a new local copy and becomes the latest
   entry in Settings; previous local copies, including open/unsaved work, remain
   intact. Never infer local deletion from a missing/forbidden remote listing.
   Automatic refresh checks downloaded projects every five minutes while open,
   is switchable, never opens authentication in the background, and respects a
   conservative persistent account-wide download budget. No remote writes.

## Tests

`tests/test_studio_sync.py` verifies PKCE with a real loopback listener and a fixture
OAuth server, encrypted persistence, renewal, disconnect, account/team separation,
resume after a streamed failure, checksum rejection, pinned source preservation,
local API protection, unchanged refresh, restart, local edits and an offline
download/build/inspect/edit/STEP-export workflow.

Successful transfer is not a guarantee that every saved project builds on this
machine. Automatic two-way merging, hosted computation and non-CAD account-data
migration are outside the download/refresh feature.

## Bug reports and feature requests

The Feedback menu (Report a bug, Request a feature, My reports) uses Studio's
desktop-feedback API with the person's own desktop sign-in. Reports are stored
only by Studio; nothing goes to GitHub from the desktop. `src/steve_desktop/local_feedback.py`
serves the local `/v1/feedback/*` routes and forwards through the serialized Studio
worker (the same worker as project sync, so token refreshes never race):

- `GET /v1/feedback/config` -> Studio `GET /api/v1/desktop-feedback/config` when the
  sign-in holds `feedback:write`. Otherwise `enabled: false` with `reason`
  `sign_in_required`, `consent_required` (sign in again to grant the permission),
  `not_offered` (Studio does not advertise the scope for the desktop client),
  `unsupported_platform` or `unavailable`. The dialog offers sign-in for the first two.
- `GET /v1/feedback/preview` -> app version, OS and the redacted, capped local log
  (recorded diagnostics and the last update result, most recent `max_log_bytes`).
  Redaction: the diagnostics rules (URLs, bearer/token/password values, long secrets,
  the session's own tokens) plus `C:\Users\<name>`, `/home/<name>`, `/Users/<name>`,
  the actual home folder, the account name and email addresses.
- `POST /v1/feedback/bug` -> Studio `POST /api/v1/desktop-feedback/reports` with
  `client_report_id` (a UUID made when the dialog opens and reused on every resend,
  so Studio stores a report once), `kind`, `what`, `expected`, `app_version`,
  `platform`, `os`, the log only when the person leaves "Include the app's log"
  ticked (redacted and capped again) and a screenshot (plain base64 PNG/JPEG) only
  when attached. Nothing else: no tokens, document names or contents, or paths.
- `GET /v1/feedback/reports` -> Studio `GET /api/v1/desktop-feedback/reports`,
  with `unseen` for resolved reports kept locally (`feedback-seen.json`, report ids
  and statuses only) and issue links accepted only for stevecad/steve issues.

Sign-in requests `feedback:write` whenever Studio lists it in
`oauth.desktop_client.scopes`; earlier grants keep working for project sync.
