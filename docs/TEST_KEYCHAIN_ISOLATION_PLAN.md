# Test keychain isolation

Design note only. This commit does not change production code, tests, or CI.
The app must keep its current behavior: encrypted storage uses the logged-in
macOS Keychain or Linux Secret Service, and there is no plaintext fallback
(`docs/MACOS.md`, `docs/LINUX.md`).

## Recommendation

Install an in-memory Fernet key and a raising guard from `tests/__init__.py`,
and only when the process was started as `python -m unittest` (the runner in
`CONTRIBUTING.md`). Leave `Vault._cipher` in `src/steve_desktop/vault.py`
unchanged. Unit tests then encrypt with a key that lives in the test process.
Any call that would have reached Security.framework, Secret Service, or
`keyring.get_password` / `set_password` raises, so a regression fails the
suite instead of touching the OS store. The app process never imports `tests`,
so it cannot take this path. See "Recommended option" for the files, the
line budget, and the proof tests.

## How this was found

- Searched the tree for `keyring`, `keychain`, `SecretService`, `gnome-keyring`,
  `SecItem`, `security`, `Vault(`, and `ctypes`.
- Read `src/steve_desktop/vault.py`, `src/steve_desktop/legacy_profile.py`,
  `tools/linux_session.py`, `docs/MACOS.md`, `docs/LINUX.md`, `CONTRIBUTING.md`,
  and the three workflows under `.github/workflows/`.
- Followed every `Vault.load` / `Vault.save` caller into the unit tests. `Vault()`
  by itself does not touch the store. `load()` on a missing file returns `{}`
  before `_cipher()`. `save()`, and `load()` of a file that exists, call `_cipher()`.
- Read the published `keyring==25.7.0` wheel (the pin in
  `packaging/requirements-linux.lock`) offline. That is the Linux lock's keyring.
  `requirements.txt` asks for `keyring>=25.6` on every non-Windows platform.
- Ran the unit suite on this Linux VM. Details are in "Linux VM baseline".
  The run did not start `gnome-keyring-daemon`, did not set
  `DBUS_SESSION_BUS_ADDRESS`, and did not call `get_password` or `set_password`.
  Every vault failure raised at the allowlist in `Vault._cipher` (the
  `RuntimeError` on line 54) after `keyring.get_keyring()` selected
  `keyring.backends.fail.Keyring`.

## 1. Where the code reaches a keychain or keyring

Steve has one production call into the OS credential store.

| Module | Function | What it calls |
| --- | --- | --- |
| `src/steve_desktop/vault.py` | `Vault._cipher` | `keyring.get_keyring()`, then `keyring.get_password('Steve', 'vault-encryption-key')`, and on a miss `keyring.set_password(...)` with a new Fernet key. Called from `Vault.save` always, and from `Vault.load` only when the file already exists. |
| `src/steve_desktop/legacy_profile.py` | `legacy_keyring_key` | `keyring.get_password('SteveLocal', 'vault-encryption-key')`. Called only from `Vault._cipher` when the `Steve` item is missing. |

`Vault._cipher` accepts a backend only when `type(backend).__module__`
starts with `keyring.backends.macOS` or `keyring.backends.SecretService`.
Anything else raises `RuntimeError: Steve needs macOS Keychain or Linux Secret
Service for encrypted storage.` That check runs before `get_password`.

On Windows (`os.name == 'nt'`) `load` / `save` use `win32crypt.CryptUnprotectData`
and `CryptProtectData` (DPAPI). They do not import `keyring`. `requirements.txt`
omits `keyring` on Windows (`keyring>=25.6; sys_platform != "win32"`).

The `keyring` 25.7.0 backends, from that wheel:

- **macOS.** `keyring.backends.macOS.Keyring` (priority 5 on Darwin).
  `keyring/backends/macOS/api.py` loads `Security`, `CoreServices`, and
  `Foundation` with `ctypes.CDLL` and calls `SecItemCopyMatching`,
  `SecItemAdd`, and `SecItemDelete`. It does not shell out to the `security`
  CLI. `KEYCHAIN_PATH` is copied onto the backend and then ignored
  (`warn_keychain`, upstream keyring issue 623), so the backend always uses
  the login keychain. A headless or SSH session with no login keychain makes
  Security.framework ask SecurityAgent, which is the "Keychain Not Found"
  dialog on the owner's GUI session. Status codes in that file include
  item-not-found (`-25300`), user-denied (`-128`), auth-failed (`-25293`),
  and interaction-not-allowed (`-25308`).
- **Linux Secret Service.** `keyring.backends.SecretService.Keyring` (priority
  5 when the service is up). It uses the `secretstorage` package
  (jeepney on the session bus, name `org.freedesktop.secrets`). `get_password`
  / `set_password` open the default collection and call `unlock()` if it is
  locked. Steve does not call `gnome-keyring-daemon` itself on this path.
- **Linux libsecret.** `keyring.backends.libsecret.Keyring` (priority 4.8) uses
  `gi.repository.Secret`. `Vault` rejects this module. It is not a fallback
  Steve will use.
- **Reject paths.** `keyring.backends.fail.Keyring` raises `NoKeyringError` on
  use. `keyring.backends.null.Keyring` returns `None` from `get_password` and
  its `set_password` is the same no-op. `keyring.backends.chainer.ChainerBackend`
  walks other backends. None of these module names pass Steve's allowlist.
  `keyring` itself will honor `PYTHON_KEYRING_BACKEND` and `keyringrc.cfg`
  (`keyring.core.load_env` / `load_config`). Steve still rejects the result
  unless the loaded class lives under the two allowed module prefixes.

Other `ctypes` uses in this repo (`cad_resources.py`, `process_watch.py`,
`worker_pool` tests, the Windows update helper, `app.py`'s AppUserModelID)
are unrelated to Keychain.

`tools/linux_session.py` is the CI helper that makes the real Secret Service
exist. On Linux it requires `dbus-run-session`, `gnome-keyring-daemon`, and
`xvfb-run`. Inside the session it runs `gnome-keyring-daemon --unlock
--components=secrets` and writes a random password to the daemon's stdin.
The session uses a throwaway `HOME` and its own D-Bus bus. That is a real
Secret Service, scoped to the throwaway home. It is what the Linux package
workflow wraps unit tests in today.

### Production callers of `load` / `save`

These call `Vault.load` or `Vault.save`, so on macOS and Linux they enter
`_cipher` when the file is missing only on `save`, and on `load` only if the
file exists. On Windows they use DPAPI instead.

| Module | What constructs the vault |
| --- | --- |
| `src/steve_desktop/app.py` | `Window` builds `ToolsController` (`mcp-settings.dpapi`), `AgentSettings`, `ChatPanel` (`chats.dpapi`), and `LocalCadWeb` → `LocalCadServer`. `main` opens `credentials.dpapi`. `--smoke-test` builds a `Window` on a temp vault. |
| `src/steve_desktop/chat_ui.py` | `ToolsController.__init__` loads, then `save`s when no workspace is set. `ChatPanel` loads chats. |
| `src/steve_desktop/settings_store.py` | `AgentSettings` loads `agent-settings.dpapi` and saves if retired keys were present. |
| `src/steve_desktop/chat_images.py` | `ChatImages.vault` saves and loads per image. |
| `src/steve_desktop/diagnostics.py` | `Diagnostics.read` / `record` load and save the diagnostics vault. |
| `src/steve_desktop/service.py` | `CredentialSource` and `Service` load and save the credentials vault. `Service.__init__` only stores the object. |
| `src/steve_desktop/mcp_auth.py` | `EncryptedStore` loads and saves on get, put, and delete. |
| `src/steve_desktop/local_mcp.py` | `LocalMCP` saves `mcp-bridge.dpapi` on start. `__init__` does not load. |
| `src/steve_desktop/local_git.py` | `LocalGit.__init__` loads `git-connections.dpapi`. `action` saves. A missing file loads as `{}` and does not enter `_cipher`. |
| `src/steve_desktop/local_updates.py` | `LocalUpdates.__init__` loads `updates.dpapi` and saves only when the saved dict is non-empty and differs. `check` can load `update-state.dpapi` on Linux. The settings route saves. The Windows install/restart routes save `apply_requested`. |
| `src/steve_desktop/linux_updates.py` | `state_vault` loads and saves `update-state.dpapi` from `stage_bundle`, `activate`, `prune_bundles`, and `bootstrap`. `bootstrap` also loads `updates.dpapi`. |
| `src/steve_desktop/windows_updates.py` | `remember` / `pending` load and save `windows-update.dpapi` and `updates.dpapi`. |
| `src/steve_desktop/studio_connection.py` | `__init__` loads `studio-session.dpapi` and swallows any exception into `storage_error`. `workspaces`, `save_tokens`, and `disconnect` save. |
| `src/steve_desktop/local_studio.py` | Builds a `StudioConnection` unless one is passed in. |
| `src/steve_desktop/cad_server.py` | `routes()` builds `LocalMCP`, `LocalGit`, `LocalStudio`, and `LocalUpdates`. Missing files make those loads return `{}`. |
| `src/steve_desktop/smoke_features.py` | Builds `Service(Vault(...))` for the offline smoke chat. |

`checks/` is outside the unit suite. These hit the same `Vault` path and
should keep using the real store: `check_chat_geometry.py` (builds a
`Window`), `check_update_install.py`, `check_windows_updates.py`,
`check_linux_updates.py`, and every check that constructs `LocalCadServer`
(`check_local_blender.py`, `check_studio_live.py`, `check_studio_navigation.py`,
`check_adaptive_execution.py`, `check_blender_ui.py`, `resume_studio_offline.py`).
`checks/check_frozen_cad.py` imports `tests.test_hot_worker`, which loads the
`tests` package. The hook below must not arm itself merely because that import
happened.

## 2. Tests that reach the store

The suite is `unittest`. `tests/__init__.py` is empty. There is no `conftest.py`
and no shared `TestCase` base. `CONTRIBUTING.md` runs
`python -m unittest tests.<module>`. That import loads `tests/__init__.py`
before the module. `python tests/test_foo.py` does not. `checks/check_package.py`
re-invokes `python -m unittest` for `tests.test_cad_process` and
`tests.test_local_mcp`.

A test reaches the OS store only when its path calls `save()`, or `load()` on
a file that is already there. Constructing `Vault`, `Service(Vault(...))`, or
`LocalCadServer` on an empty temp directory does not. `load()` of a missing
file returns before `_cipher`.

### Reached the store on this VM (Linux, no Secret Service)

These failed in `Vault._cipher` with the allowlist `RuntimeError`, or failed
one layer up because that `RuntimeError` escaped as an HTTP 500, an empty
body, or a swallowed `Exception`.

Direct `RuntimeError` from `_cipher`:

- `tests/test_chat_images.py`: `test_encrypted_image_and_responses_wire_format_survive_restart`, `test_invalid_images_paths_limits_and_orientation`, `test_error_chain_is_encrypted_and_redacted` (`ChatImages.save`, `Diagnostics.record`, direct `Vault.save`).
- `tests/test_desktop_feedback.py`: `test_config_preview_and_report_forward_exactly_the_disclosed_fields` (`Diagnostics.record`). The other feedback tests passed. Their `setUp` loads a missing session file.
- `tests/test_launch_services.py`: `test_older_saved_feed_key_and_token_are_dropped_but_opt_out_is_kept` (`Vault.save` then `LocalUpdates`, which loads that file). `test_real_git_push_pull_and_studio_source_import` (`LocalGit.action` → `vault.save`). `test_download_verifies_signature_and_sends_no_credentials` **failed** rather than errored: `LocalUpdates.check` caught the `RuntimeError` and stored it on `message`. On Linux this test still forces `update_platform()` to `windows-x64`, and `remember()` saves a vault. DPAPI is not involved, because `os.name` is not `nt`.
- `tests/test_legacy_profile.py`: `test_prior_profile_credentials_documents_memory_preserved`.
- `tests/test_linux_updates.py`: all 21 tests on `LinuxUpdateTests`. `setUp` calls `Vault.save` before the body. Bodies that call `linux.stage_bundle` or `linux.activate` would enter `state_vault` as well.
- `tests/test_mcp_auth.py`: `test_encrypted_storage_and_isolation`, `test_browser_pkce_callback_and_saved_session` (`EncryptedStore.put`).
- `tests/test_restart_update.py`: all 6 tests on `LinuxReopen` (`setUp` calls `linux.state_vault(...).save`). `test_accepted_requests_restart_and_closes_through_the_window` **failed** with HTTP 500: `RestartUpdates.platform` is `windows-x64`, and the restart route saves `apply_requested`. The other restart tests do not save (Linux restart does not, and the refuse paths return before `save`).
- `tests/test_service.py`: `test_encrypted_roundtrip_and_logout`, `test_models_use_oauth_header_and_real_response_shape`, `test_cancel_does_not_save_credentials`, `test_401_refresh_is_persisted_and_replayed`, `test_missing_plan_permission_never_sends_request`, `test_callback_state_and_success`. `setUp` only constructs `Vault`. `test_catalog_order_and_visibility` does not touch it and passed.
- `tests/test_studio_sync.py`: `ConnectionTests.test_display_profile_is_optional_encrypted_and_cleared_on_account_change`, `test_profile_scope_is_optional_and_refresh_preserves_or_clears_it`, `test_real_loopback_pkce_storage_refresh_and_disconnect`, `test_cross_origin_and_ambiguous_refresh_fail_closed` (save from `workspaces` / token save / `disconnect`). `SyncTests.test_status_exposes_display_identity_without_credentials` and `test_download_build_inspect_edit_export_offline` (`disconnect` → `vault.save`). `test_denied_team_never_downloads` **failed**: `LocalStudio.run` → `workspaces` → `vault.save`, and the bare `Exception` handler replaced the `RuntimeError` with "Studio could not complete this operation".
- `tests/test_update_channel_keys.py`: `test_the_app_never_changes_the_feed_or_its_keys` (PUT `/v1/local/updates` → `vault.save`; the client then saw an empty body). The other override tests do not save and passed. `setUp` loads a missing file.
- `tests/test_windows_updates.py`: `test_restart_verifies_files_signature_and_version`, `test_successful_current_release_check_clears_old_failure`. `test_failure_report_visible_after_restart` writes a plain JSON report, does not open a vault, and passed.
- `tests/test_local_mcp.py`: `test_real_stdio_build_inspect_export_and_stop`. `LocalCadServer` startup only loads missing files. The failure is the `/v1/local/mcp-server/start` handler, which `vault.save`s and returns a non-JSON 500.

Reached `_cipher` and still passed:

- `tests/test_studio_sync.py` `ConnectionTests.test_damaged_session_does_not_prevent_local_startup`. It writes bytes to `studio-session.dpapi` and constructs `StudioConnection`. `load()` calls `_cipher`, the allowlist raises, and `__init__` swallows that into `storage_error`. The assertion still holds. A green run does not prove the OS store was left alone.

### Would reach it, and did not run here

Importing PySide6 failed with `libEGL.so.1` missing, so these modules were one
error each and their methods did not run. `Window.__init__` builds
`ToolsController`, which `save`s `mcp-settings.dpapi` whenever no workspace is
set. That is a real `_cipher` call.

- `tests/test_chat_ui.py`: all 5 `ChatUITests` methods (`setUp` builds `Window`).
- `tests/test_studio_assistant.py`: all 8 `StudioAssistantTests` methods (same).
- `tests/test_cad_webview.py`: `PasteEventFilterTests` does not build a vault.
  The import error is Qt, not keyring.

### Construct a vault and do not reach the store

Confirmed by a passing run plus the `load()` early return:

- `tests/test_runtime.py` and `tests/test_features.py` build `Service(Vault(...))` and pass it to `chat(..., model_override=FunctionModel(...))`. `Service.__init__` does not load. The function model never asks the credential source to load. All of their non-skipped tests passed.
- `LocalCadServer` tests whose path never `save`s: `tests/test_cad_archive.py`, `test_cad_archive_materials.py`, `test_cad_drawings.py`, `test_cad_history.py`, `test_cad_images.py`, `test_cad_links.py`, `test_cad_local.py`, `test_cad_materials.py`, `test_cad_parallel_server.py`, `test_cad_parts.py`. `LocalGit`, `LocalStudio`, and `LocalUpdates` load missing files and get `{}`.
- `tests/test_launch_services.py`: `test_shipped_channel_is_dl_stevecad_studio_and_needs_no_configuration`, `test_older_or_same_version_is_not_downloaded`, `test_signed_manifest_tampering_expiry_and_host`, `test_archive_paths_and_expected_executable`, `test_unsupported_platform_does_not_download_windows_updates`, `test_reported_platforms_keep_their_ids`, `test_apple_silicon_id_does_not_download_updates`, `test_symlink_above_the_checkout_is_not_an_escape`. `LocalUpdates.__init__` on an empty directory does not save.
- `tests/test_studio_sync.py`: `test_desktop_discovery_rejects_missing_and_unsafe_configuration` (load of a missing file). Sync tests that call `LocalStudio.download` directly and do not `disconnect` or `workspaces`.
- `tests/test_restart_update.py`: `RestartRoute` tests other than `test_accepted_requests_restart_and_closes_through_the_window`, `WindowsClose`, and `LinuxClose`. Their `LocalUpdates` loads a missing file. Linux restart does not save the vault.
- `tests/test_service.py`: `test_catalog_order_and_visibility`.

### Skipped on this VM, and what they would touch

- `tests/test_service.py` `test_steve_directory_preserves_existing_profile` and `tests/test_windows_update_helper.py` `test_helper_rechecks_authenticated_signature_and_files` call `Vault.save` / `load`. On Windows that is DPAPI. On macOS and Linux it would be `_cipher`.
- `tests/test_windows_update_helper.py` `test_launch_copies_windowless_helper_outside_installation`, the three `tests/test_features.py` Windows-process tests, and `tests/test_worker_pool.py` `test_windows_shared_cpu_limit` are Windows-only and do not open a vault.
- `tests/test_cad_local.py` `test_step_import_roundtrip` called `skipTest` because a manual export fixture is absent. It builds `LocalCadServer` and does not need the store for that skip.

## 3. Linux CI, macOS, and this VM

**Linux CI uses a real Secret Service, on purpose.**
`.github/workflows/linux-package.yml` installs `gnome-keyring` and runs

```sh
python tools/linux_session.py -- python -m unittest tests.test_launch_services ...
```

`linux_session.py` starts Xvfb, a private D-Bus session, and
`gnome-keyring-daemon --unlock`. `keyring.get_keyring()` then returns
`keyring.backends.SecretService.Keyring`. That module passes the allowlist.
`get_password` misses, `set_password` stores a new Fernet key in the throwaway
collection, and the vault tests pass. They are not skipped. There is no
plaintext backend in that path. The Windows job in `release-build.yml` runs
`python -m unittest` with no keyring helper, because those tests hit DPAPI
(`os.name == 'nt'`), and `keyring` is not installed. There is no macOS workflow.

**macOS talks to the login keychain through Security.framework.**
On Darwin, `keyring` 25.7 selects `keyring.backends.macOS.Keyring` and
`Vault._cipher` accepts it. The first `save` or `load` of an existing file
calls `SecItemCopyMatching` / `SecItemAdd`. Over SSH, or any session whose
keychain search list has no login keychain, SecurityAgent shows
"Keychain Not Found" on the GUI session. The test then fails. `KEYCHAIN_PATH`
does not redirect this backend. `docs/MACOS.md` requires a logged-in user and
a usable `Steve` keychain item for the app and for `--smoke-test`. That stays
true.

**This VM failed closed, before any password call.**
`gnome-keyring` is installed and `org.freedesktop.secrets` is D-Bus
activatable, but the shell had no `DBUS_SESSION_BUS_ADDRESS` and no
`XDG_RUNTIME_DIR`. `secretstorage.dbus_init` raises `KeyError` on the missing
variable and does not activate the daemon (`secretstorage` 3.5.0). The
libsecret typelib is absent, so that backend's priority fails too. `get_keyring()`
returned `keyring.backends.fail.Keyring`. `Vault._cipher` rejected it at the
allowlist. `get_password` and `set_password` were not called. No
`gnome-keyring-daemon` was running after the suite. Linux "does not pop a
dialog" here because the allowlist refuses the fail backend. It does not
succeed, and it does not fall back to a file.

## 4. Design options

Upstream limits from `CONTRIBUTING.md`: one fix per PR, at most 400 changed
lines, at most 25 files, text only. The suite is `unittest`, invoked as
`python -m unittest tests.<module>`. A `conftest.py` or a new pytest dependency
would fight that. `tests/__init__.py` runs for that command. Do not edit
`.github/` in the implementation PR. Workflow edits are reviewed by hand and
need an issue first, and unit tests can stop touching the store without
changing the workflow. `linux_session.py` stays so `checks/` still have a
display and a Secret Service.

All three options keep the allowlist. None of them add
`keyring.backends.null`, a file backend, or a test class to that tuple.
`null.Keyring.set_password` is a no-op, so accepting it would mint a new
Fernet key on every `save` and drop it. Spoofing a test class's `__module__`
so it starts with `keyring.backends.SecretService` would also let
`PYTHON_KEYRING_BACKEND` select that class in the app whenever `tests` is
importable. Do not do that.

### Option A — in-memory cipher and a raising guard, installed by `tests/__init__.py`

`tests/__init__.py` calls an installer in a new `tests/keyring_isolation.py`
only when `sys.argv[0]` is `unittest/__main__.py` (the `python -m unittest`
entry). The installer:

- Replaces `Vault._cipher` on the class with a function that returns a
  `Fernet` for one key generated in that process (`Fernet.generate_key()`).
  The key is not read from the environment and is not written down.
- Wraps `keyring.backends.macOS.api.find_generic_password`,
  `set_generic_password`, and `delete_generic_password`;
  `keyring.backends.SecretService.Keyring.get_password`, `set_password`, and
  `delete_password`; and `keyring.get_password`, `set_password`, and
  `get_keyring`. Each wrapper raises `RealKeyringForbidden` from the test
  module.

Pros:

- `vault.py` stays byte for byte the same. The app cannot select the fake.
  `python -m steve_desktop` does not import `tests`. `checks/check_frozen_cad.py`
  imports a test module, but its `argv[0]` is the check script, so the hook
  stays off and that process keeps the real cipher.
- Fits `unittest`. Three text files. Comfortably inside 400 lines and 25 files.
- The guard is the proof: a test that puts the original `_cipher` back still
  cannot complete a real `SecItem*` or Secret Service call.

Cons:

- The body of `Vault._cipher` (allowlist, legacy `SteveLocal` read, `set_password`)
  does not run on the ordinary suite path. The proof tests have to call the
  saved original under a mock backend.
- `python tests/test_service.py` does not load the package hook. `CONTRIBUTING.md`
  does not use that form. A developer who does will still hit the real store.
- Patching a private method will need a follow-up if `_cipher` is renamed.

Production cannot silently use the fake: the replacement exists only on the
class object inside a `python -m unittest` process. There is no environment
variable, config key, or allowlist entry for it.

### Option B — injectable store on `Vault`, default `None`

Add `keystore=None` to `Vault.__init__` and a module global `_keystore` that
stays `None`. `_cipher` uses the instance store, then the global, and otherwise
runs today's keyring code unchanged, including the allowlist. `tests/__init__.py`
sets the global to an in-memory `get_password` / `set_password` object, under
the same `python -m unittest` gate, and installs the same raising guard on the
real backends.

Pros:

- Every `Vault()` the suite builds, including ones constructed inside
  `ChatImages`, `LocalUpdates`, and `StudioConnection`, picks up the memory
  store. Ordinary tests still execute the real `_cipher` body (Fernet, atomic
  replace, and the branch that writes a new key).
- The default is `None`. `PYTHON_KEYRING_BACKEND` and `keyringrc.cfg` still
  have to pass the allowlist. The global is not read from the environment.
- Same unittest shape, still a few files, still under the line cap if the
  `vault.py` edit stays a short prefix.

Cons:

- The bypass lives in the shipping module. A later patch that assigns
  `_keystore` from application code would skip the Keychain with no config
  change. Review has to keep that assignment test-only.
- `keystore=` on the constructor is not enough by itself. Dozens of production
  `Vault(path)` calls would still use the real store unless the global is set.
  Threading a store through `LocalCadServer`, `Window`, and the update helpers
  would blow the file limit and would be a behavior change.
- Slightly harder to review than a tests-only diff, because `vault.py` changes
  even though the `None` path is the current path.

Production cannot silently use the fake: with `_keystore is None` and no
instance store, the function is today's `_cipher`. Nothing in the environment
sets the global. A proof test in a subprocess that does not import `tests`
asserts the global is `None` and that a fail backend still raises the existing
`RuntimeError`.

### Option C — `STEVE_TEST_KEYRING`, honored only from test code

Two different designs share this name.

**C1. `vault.py` reads the variable.** If it is set, `_cipher` uses a memory
store and skips the allowlist. This is the one to reject. The app would switch
store because of its environment. That is a plaintext-equivalent fallback: the
Fernet key never enters the Keychain, and a constant or empty store would
encrypt credentials with a key the OS does not hold. Gating it on
`'unittest' in sys.modules` is still reachable from the app (import `unittest`,
set the variable). `docs/MACOS.md` would be false the moment the variable is
set.

**C2. Only `tests/__init__.py` reads the variable.** Default is "isolation on"
for `python -m unittest`. `STEVE_TEST_KEYRING=off` skips the hook for someone
debugging against a real Secret Service. `vault.py` does not mention the
variable. This is safe, and it is a switch on option A or B, not a third
architecture. It does not, by itself, isolate anything.

Pros of C2: a developer can aim one module at a real Secret Service without
editing code. Cons: an off switch that is easy to leave on in a shell, and
the variable's name will be mistaken for a production feature unless the
comment says the app ignores it. Prefer no off switch in the first change.
Someone who needs the real store can run a single test in a process that does
not go through the hook, or temporarily revert the patch locally.

## 5. Recommended option

Option A. It is the smallest change that matches the unittest runner, stays
inside the upstream size cap, and keeps the fake out of the shipping module.
Option B is the one to pick up if review wants ordinary tests to keep running
the real `_cipher` body. Option C1 should not be implemented.

### Files the implementation would touch

- `tests/__init__.py` — call the installer when `sys.argv[0]` ends with
  `unittest/__main__.py`. Empty today, so this is the whole file.
- `tests/keyring_isolation.py` — new. `install()`, the in-memory `_cipher`,
  `RealKeyringForbidden`, and the wrappers around the macOS `api` functions,
  `SecretService.Keyring`'s password methods, and `keyring.get_password` /
  `set_password` / `get_keyring`. On Windows, `keyring` is not installed; the
  guard imports it only when it is present, and the `_cipher` swap is a no-op
  for the DPAPI branch because Windows `load` / `save` never call `_cipher`.
- `tests/test_keyring_isolation.py` — new. The proof tests below.

No edit to `src/steve_desktop/vault.py`, `docs/MACOS.md`, `tools/linux_session.py`,
or `.github/`. `checks/` and `python -m steve_desktop --smoke-test` keep the
real Keychain or Secret Service.

Estimated diff: about 250 to 350 added lines across those 3 files. No
deletions in production. Under the 400-line and 25-file caps with room to
spare. Text only. One concern (unit tests must not touch the OS store).

### Proof tests

1. `test_guard_rejects_real_entry_points`. With the hook installed, calling
   the wrapped `find_generic_password`, `set_generic_password`,
   `SecretService` `get_password` / `set_password`, and `keyring.get_password`
   / `set_password` / `get_keyring` raises `RealKeyringForbidden`.
2. `test_roundtrip_does_not_call_the_guard`. `Vault.save` / `load` of a dict
   that contains a sentinel. The ciphertext bytes do not contain the sentinel.
   The load returns the dict. The guard's call counter stays 0.
3. `test_original_cipher_hits_the_guard_for_an_allowed_backend`. Put the
   original `Vault._cipher` back for the duration of the test. Mock
   `keyring.get_keyring` so the backend's class module is
   `keyring.backends.macOS` (or `keyring.backends.SecretService`) and its
   password methods are the guarded ones. `Vault.save` raises
   `RealKeyringForbidden`. That is the proof that today's cipher would have
   entered the real backend, and that the suite's replacement is what stopped
   it.
4. `test_original_cipher_still_rejects_other_backends`. Same restoration.
   Backends whose modules are `keyring.backends.fail` and
   `keyring.backends.null` still raise the existing `RuntimeError` from
   `vault.py`, and `get_password` is not called. This locks the allowlist.
5. `test_legacy_service_is_copied_under_a_mock`. Original `_cipher`, mock
   backend with a Secret Service module path. `get_password('Steve', ...)`
   returns `None`, `get_password('SteveLocal', ...)` returns a Fernet key,
   `set_password` records the `Steve` write. No guarded OS function runs.
6. `test_app_process_has_no_hook`. A subprocess runs
   `python -c` to import `steve_desktop.vault` and `keyring` only. It does not
   import `tests` and does not call `get_password`. It asserts `get_keyring()`
   is the platform backend (on Linux, the fail backend when no Secret Service
   is configured) and that `Vault.save` raises the allowlist `RuntimeError`.
   The parent assertion is that the child exited 0. This is the production
   guarantee in executable form.

The guard stays installed for the whole suite, so tests 3 and 4 restore
`_cipher` and stub `get_keyring` only inside the test, and they still cannot
call `SecItem*` or Secret Service.

## 6. Open questions

1. Should `checks/` and `--smoke-test` stay on the real Keychain and Secret
   Service? This plan says yes. They are the integration path `docs/MACOS.md`
   already documents. Say if they should grow a disposable store too.
2. Should Windows unit tests stop using DPAPI in the same change? They never
   import `keyring`, and they do not pop a Keychain dialog. Leaving DPAPI
   keeps `test_encrypted_roundtrip_and_logout` on Windows as a real DPAPI
   round trip. Isolating it would make every OS use the in-memory Fernet key.
   This plan leaves DPAPI alone.
3. Is `python -m unittest tests.<module>` the only runner that must be safe?
   The hook follows that command. `python tests/test_foo.py` would still reach
   the real store. `discover -s tests -t .` from the repo root loads
   `tests.*` and is covered.
4. Is an explicit `STEVE_TEST_KEYRING=off` escape hatch wanted for debugging
   one module against Secret Service? This plan leaves it out so the name
   cannot be read as an app setting.
5. After unit tests stop using the collection, should a later PR (with an
   issue, because it touches `.github/`) stop expecting `gnome-keyring` for
   the unit-test step? `linux_session.py` would still be required for the
   GUI checks. This plan does not change CI.

## 7. Linux VM baseline at `0cd709d`

Command, from the repo root, Python 3.13.18, dependencies from
`requirements.txt` plus an editable install. `QT_QPA_PLATFORM=offscreen` so Qt
tests that got past import could paint. `DBUS_SESSION_BUS_ADDRESS` and
`GNOME_KEYRING_CONTROL` were unset. `tools/linux_session.py` was not used.
`npm test` was not run.

```sh
python -m unittest discover -s tests -t .
```

`keyring.get_keyring()` in that environment was
`keyring.backends.fail.Keyring` (`keyring` 25.7.0, `secretstorage` 3.5.0).
No `gnome-keyring-daemon` was running before or after.

Result: **Ran 244 tests in 44.644s. FAILED (failures=3, errors=55, skipped=8).**
178 passed. The process exit code was 1.

The 8 skips:

- `tests.test_features.FeatureTests.test_windows_script_and_timeout`
- `tests.test_features.FeatureTests.test_enabled_script_runs_without_approval`
- `tests.test_features.FeatureTests.test_script_cancellation_kills_descendants`
- `tests.test_service.Tests.test_steve_directory_preserves_existing_profile`
- `tests.test_windows_update_helper.PythonUpdateHelper.test_helper_rechecks_authenticated_signature_and_files`
- `tests.test_windows_update_helper.PythonUpdateHelper.test_launch_copies_windowless_helper_outside_installation`
- `tests.test_worker_pool.CpuBudgetTests.test_windows_shared_cpu_limit`
- `tests.test_cad_local.LocalCadTests.test_step_import_roundtrip` (`skipTest`: manual export fixture unavailable)

The 3 failures, all from a vault save that did not surface as the test's
exception type:

- `tests.test_launch_services.UpdateTests.test_download_verifies_signature_and_sends_no_credentials` — `Update check failed: Steve needs macOS Keychain or Linux Secret Service for encrypted storage.`
- `tests.test_restart_update.RestartRoute.test_accepted_requests_restart_and_closes_through_the_window` — HTTP 500 from the restart route's `vault.save`.
- `tests.test_studio_sync.SyncTests.test_denied_team_never_downloads` — `workspaces()` → `vault.save`, swallowed as "Studio could not complete this operation. Local projects were preserved."

The 55 errors:

- 52 are the allowlist `RuntimeError` from `Vault._cipher`, including
  `test_local_mcp` and `test_the_app_never_changes_the_feed_or_its_keys`,
  which show up as `JSONDecodeError` on an empty 500 body. The full method
  list is in section 2.
- 3 are module import errors, `libEGL.so.1` missing, before any vault call:
  `tests.test_cad_webview`, `tests.test_chat_ui`, `tests.test_studio_assistant`.
  Unittest counts each failed module as one error, so the 5 chat-UI methods
  and 8 studio-assistant methods did not run. Those `Window` tests would have
  entered `_cipher` from `ToolsController.save`.

Passing tests that build a `Vault` or a `LocalCadServer` did so against missing
files, except `test_damaged_session_does_not_prevent_local_startup`, which
enters `_cipher` and swallows the error.
