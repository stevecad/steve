# Test keychain isolation

Unit tests stay off the OS keychain, Secret Service, and DPAPI. The app still
requires the logged-in Keychain or Secret Service (`docs/MACOS.md`).
`vault.py` is unchanged.

`tests/__init__.py` arms `tests/vault_hook.py` only for `python -m unittest`
(discover and `tests.<module>`). One process-local Fernet key replaces
`Vault._cipher`. Windows `load`/`save` take that branch, so DPAPI is not
called. Real `keyring`, macOS Keychain, Secret Service, and DPAPI entry points
raise `RealKeyringForbidden`. There is no off switch.

Checks and `python -m steve_desktop --smoke-test` do not arm the hook. A unit
test's child Python inherits it: `STEVE_UNITTEST_VAULT_KEY` plus
`tests/subprocess_hook` on `PYTHONPATH`, and `make_mcp` is wrapped so its
session allowlist still carries those two variables. The app never reads the
variable. Workflows are unchanged.

Proof: `tests/test_vault.py`.
