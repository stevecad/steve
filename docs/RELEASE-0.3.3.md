# Steve 0.3.3

- Add construction-plane editing and reference-safe renaming in the Model tree.
- Preserve named plane references when starting a sketch; dependent sketches follow plane edits.
- Fix creating a construction plane before the first sketch or solid in an empty document.
- Preserve plane orientation during relative offset edits and clear edit state when creating another plane.

Verified native create, rename, offset edit, extrusion, reopen, Cancel and new-plane workflows; geometry volume and sketch placement checked. Scope-aware rename tests cover collisions and unrelated Python locals/strings.

Existing sketches stored as literal coordinates are not automatically relinked. Face-derived planes retain fixed placements. The broader CAD audit remains open; this release does not claim all CAD commands or arbitrary Python parallelism are verified.

Windows x64 private evaluation release. Signed update manifest; executable and installer are not Authenticode-signed. Downloads require GitHub access to stevecad/steve.
