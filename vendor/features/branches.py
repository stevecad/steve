"""Per-document branches, three-way source merges, and the revision graph.

`main` is the existing `documents` row, so every existing REST/MCP path keeps meaning main.
Named branches have their own head row and journal (see branch_store). Merging into main
is validated like a feature edit: the merged source is generated as a candidate build and
main is saved only after it succeeds, with a compare-and-swap on both revisions.
"""
import asyncio
import json
import logging
import re
import time
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, Response
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from app import assistant_effects, db, migrations, trash
from app.main import (MAX_FILES, BuildRequest, DocumentUpdate, LinkRef, create_build, document_files, get_build, get_document,
                      insert_document, link_status, pin_links, refuse_catalogue, save_document, serialize_document, update_document,
                      validate_files, validate_preview, live_preview)
from ..config import BUILD_WAIT
from ..modeling import MAX_SOURCE
from . import branch_store, history
from .merge import has_conflict_markers, merge_map, merge_text, merge_value

router = APIRouter()
# The web's validBranchName / BRANCH_NAME_RULE (web/src/lib/branches.ts) mirror these: keep them in step.
BRANCH_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,47}")
NAME_RULE = ("Branch names are 1–48 lowercase letters, digits, '.', '_' or '-', start with a letter or digit, "
             "and cannot be 'main', contain '..', or end with '.' or '.lock'.")


def fail(status, code, message, **extra):
    return HTTPException(status, {"code": code, "message": message, **extra})


def valid_name(name):
    return bool(BRANCH_NAME.fullmatch(name)) and name != "main" and ".." not in name and not name.endswith((".", ".lock"))


def iso(value):
    return value.isoformat() if value else None


def text_id(value):
    return str(value) if value else None


def main_row(conn, document_id, lock=""):
    if lock:  # Branching or merging changes the document: never a catalogue shop's (app/main.py refuse_catalogue).
        refuse_catalogue(conn, document_id)
    row = conn.execute("SELECT * FROM documents WHERE id=%s" + {"": "", "share": " FOR SHARE", "update": " FOR UPDATE"}[lock],
                       (document_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Design not found.")
    trash.refuse_if_trashed(conn, row)  # A trashed design's branches are hidden with it (app/trash.py).
    return row


def branch_row(conn, document_id, name, lock=False):
    row = conn.execute("SELECT * FROM document_branches WHERE document_id=%s AND branch=%s AND deleted_at IS NULL"
                       + (" FOR UPDATE" if lock else ""), (document_id, name)).fetchone()
    if not row:
        raise fail(404, "branch_not_found", f"This design has no branch named {name!r}.")
    return row


def main_snapshot(conn, document_id, revision):
    row = conn.execute("SELECT snapshot FROM document_revisions WHERE document_id=%s AND revision=%s", (document_id, revision)).fetchone()
    return migrations.snapshot(conn, row["snapshot"]) if row else None


def revision_content(document_id, branch, revision):
    """One saved revision of main or a branch as its journal snapshot (kind, name, code, files, links), or None."""
    with db.pool.connection() as conn:
        if branch in (None, "main"):
            return main_snapshot(conn, document_id, revision)
        row = conn.execute("SELECT snapshot FROM document_branch_revisions WHERE branch_id=%s AND revision=%s",
                           (branch_row(conn, document_id, branch)["id"], revision)).fetchone()
        return migrations.snapshot(conn, row["snapshot"]) if row else None


def packed(link) -> str:
    """A stored link (or LinkRef) as merges compare it: "<document>@<revision>", "#<component>" for one component."""
    link = link.model_dump() if isinstance(link, LinkRef) else link
    return f"{link['document_id']}@{link['revision']}" + (f"#{link['component']}" if link.get("component") else "")


def content(value):
    """Mergeable content of a documents row, branch row, or journal snapshot."""
    return {"name": value["name"], "code": value["code"], "files": dict(value.get("files") or {}),
            "links": {alias: packed(link) for alias, link in (value.get("links") or {}).items()}}


def base_source(branch):
    if branch["base_branch_revision"] is not None:
        return {"branch": branch["branch"], "revision": branch["base_branch_revision"]}
    return {"branch": "main", "revision": branch["base_revision"]}


def base_content(conn, branch):
    """Merge base: main at the fork/last sync, or the branch revision last merged into main."""
    if branch["base_branch_revision"] is not None:
        row = conn.execute("SELECT snapshot FROM document_branch_revisions WHERE branch_id=%s AND revision=%s",
                           (branch["id"], branch["base_branch_revision"])).fetchone()
        return content(migrations.snapshot(conn, row["snapshot"]))
    return content(main_snapshot(conn, branch["document_id"], branch["base_revision"]))


def plan_merge(base, main, branch, label):
    text = merge_text(base["code"], main["code"], branch["code"], theirs_label=label)
    conflicts = list(text["conflicts"])
    files, file_conflicts = merge_files(base["files"], main["files"], branch["files"], label, len(conflicts))
    conflicts += file_conflicts
    links, link_conflicts = merge_map(base["links"], main["links"], branch["links"])
    conflicts += [{"index": len(conflicts) + i, "kind": "link", "alias": c["alias"], "start_line": None, "end_line": None,
                   "base": c["base"], "ours": c["ours"], "theirs": c["theirs"],
                   "message": f"Main and {label} link {c['alias']!r} to different designs or revisions. Send the resolved links."}
                  for i, c in enumerate(link_conflicts)]
    result = {"name": merge_value(base["name"], main["name"], branch["name"]), "code": text["code"], "files": files, "links": links}
    if conflicts:
        status = "conflict"
    elif result == main:
        status = "up_to_date"
    elif main == base:
        status = "fast_forward"
    else:
        status = "clean"
    return {"status": status, **result, "conflicts": conflicts}


def merge_files(base, main, branch, label, offset):
    """A design's other files, merged one by one (main.py is `code`). Deleting a file on one side while the
    other changes it is a conflict; otherwise deletions and additions merge like edits."""
    files, conflicts = {}, []
    for path in sorted(set(base) | set(main) | set(branch)):
        b, m, t = base.get(path), main.get(path), branch.get(path)
        if m is None or t is None:
            survivor = t if m is None else m
            if survivor is None or survivor == b:
                continue  # Deleted on one side, untouched on the other (or on both).
            if b is None:
                files[path] = survivor  # Added on one side.
                continue
            conflicts.append({"index": offset + len(conflicts), "kind": "file", "file": path, "start_line": None, "end_line": None,
                              "base": b, "ours": m, "theirs": t,
                              "message": f"{'Main' if m is None else label} deleted {path} while the other side changed it. Send the resolved files."})
            files[path] = survivor
            continue
        text = merge_text(b or "", m, t, theirs_label=label)
        files[path] = text["code"]
        conflicts += [{**c, "index": offset + len(conflicts) + i, "file": path} for i, c in enumerate(text["conflicts"])]
    return files, conflicts


def stored_links(merged: dict) -> dict:
    """Merged links ({alias: "<document>@<revision>[#<component>]"}) as stored: {alias: {document_id, revision[, component]}}."""
    out = {}
    for alias, value in merged.items():
        value, _, component = value.partition("#")
        document_id, revision = value.rsplit("@", 1)
        out[alias] = {"document_id": document_id, "revision": int(revision), **({"component": component} if component else {})}
    return out


def unpack_links(merged: dict) -> dict:
    return {alias: LinkRef(**link) for alias, link in stored_links(merged).items()}


def ahead(conn, branch):
    # Branch revisions not yet merged into main; syncs from main are not branch work.
    return conn.execute("""SELECT count(*) AS n FROM document_branch_revisions
        WHERE branch_id=%s AND revision > %s AND change <> 'sync'""", (branch["id"], branch["merged_revision"])).fetchone()["n"]


def status_fields(conn, branch, main):
    plan = plan_merge(base_content(conn, branch), content(main), content(branch), branch["branch"])
    return {"ahead": ahead(conn, branch), "behind": main["revision"] - branch["base_revision"], "merged": plan["status"] == "up_to_date"}


def entry(conn, branch, main):
    from app.teams import who
    return {"name": branch["branch"], "revision": branch["revision"], "base_revision": branch["base_revision"],
            "updated_at": iso(branch["updated_at"]), "created_at": iso(branch["created_at"]), "by": who(branch.get("actor")),
            "preview_build_id": text_id(branch["preview_build_id"]), **status_fields(conn, branch, main)}


def main_entry(main):
    return {"name": "main", "revision": main["revision"], "base_revision": None, "updated_at": iso(main["updated_at"]),
            "created_at": iso(main["created_at"]), "preview_build_id": text_id(main["preview_build_id"]),
            "ahead": 0, "behind": 0, "merged": True}


def branch_document(conn, branch, main):
    status = link_status(conn, branch["links"])
    return {"id": str(branch["document_id"]), "name": branch["name"], "kind": branch["kind"], "code": branch["code"],
            "files": dict(branch["files"]), "links": dict(branch["links"]), "preview_build_id": text_id(branch["preview_build_id"]),
            "revision": branch["revision"], "created_at": iso(branch["created_at"]), "updated_at": iso(branch["updated_at"]),
            **({"link_status": status} if status else {}),
            "branch": branch["branch"], "base_revision": branch["base_revision"], "created_from": branch["created_from"],
            **status_fields(conn, branch, main)}


def main_document(document_id):
    return {**get_document(document_id), "branch": "main", "base_revision": None, "created_from": None,
            "ahead": 0, "behind": 0, "merged": True}


# Shared with the MCP tools: branch None/"main" keeps the original main paths and shapes.
def read_document(document_id, branch=None):
    if branch in (None, "main"):
        return get_document(document_id)
    with db.pool.connection() as conn:
        main = main_row(conn, document_id)
        return branch_document(conn, branch_row(conn, document_id, branch), main)


def write_document(document_id, branch, body):
    if branch in (None, "main"):
        return update_document(document_id, body)
    with db.pool.connection() as conn:
        previous = assistant_effects.cached(conn, lock=True)
        if previous is not None:
            return previous
        result = save_branch(conn, document_id, branch, body)
        assistant_effects.record(conn, result)
    return result


def save_branch(conn, document_id, branch, body):
    """A branch's next revision, saved on `conn` (the caller commits)."""
    main = main_row(conn, document_id)
    current = branch_row(conn, document_id, branch, lock=True)
    if current["revision"] != body.revision:
        raise fail(409, "stale_revision", "This branch changed in another window. Reopen it before saving. Your edits remain in this window.")
    if current["kind"] != body.kind:
        raise fail(409, "kind_change", "A branch keeps its document's type.")
    document_files(body, current)
    preview = validate_preview(conn, body.preview_build_id)
    links = pin_links(conn, body.links, document_id, kind=body.kind)
    row = conn.execute("""UPDATE document_branches SET name=%s, code=%s, files=%s, links=%s, preview_build_id=%s,
        revision=revision+1, updated_at=now() WHERE id=%s RETURNING *""",
                       (body.name, body.code, Jsonb(body.files), Jsonb(links), preview, current["id"])).fetchone()
    branch_store.journal(conn, row["id"], "edit", [{"branch_id": str(row["id"]), "revision": current["revision"]}])
    return branch_document(conn, row, main)


def write_with_part(document_id, branch, part, host):
    """Saves a new part and the host document's next revision together, all or nothing (extracting a component into
    its own part): `part` is the new part's DocumentRequest, `host(part_id)` the host's DocumentUpdate linking it.
    Both are the caller's, in its own workspace. Returns (the part, the host as saved)."""
    with db.pool.connection() as conn:
        previous = assistant_effects.cached(conn, lock=True)
        if previous is not None:
            return previous.get("part"), previous
        row = insert_document(conn, part)
        made = serialize_document(row)
        body = host(row["id"])
        result = serialize_document(save_document(conn, document_id, body)) if branch in (None, "main") else save_branch(conn, document_id, branch, body)
        assistant_effects.record(conn, {**result, "part": made})
    return made, result


@router.get("/v1/documents/{document_id}/branches")
def list_branches(document_id: UUID):
    with db.pool.connection() as conn:
        main = main_row(conn, document_id)
        rows = conn.execute("SELECT * FROM document_branches WHERE document_id=%s AND deleted_at IS NULL ORDER BY created_at, branch",
                            (document_id,)).fetchall()
        return {"document_id": str(document_id), "default": "main",
                "branches": [main_entry(main), *(entry(conn, row, main) for row in rows)]}


class BranchCreate(BaseModel):
    name: str = Field(max_length=100)
    from_revision: int | None = Field(default=None, ge=1)


@router.post("/v1/documents/{document_id}/branches", status_code=201)
def create_branch(document_id: UUID, body: BranchCreate, response: Response):
    if not valid_name(body.name):
        raise fail(422, "invalid_branch_name", NAME_RULE)
    with db.pool.connection() as conn:
        main = main_row(conn, document_id, "share")
        fork = body.from_revision or main["revision"]
        source = main_snapshot(conn, document_id, fork) if fork <= main["revision"] else None
        if source is None:
            raise fail(422, "revision_unavailable", f"Main revision {fork} is not in this design's recorded history.")
        if fork == main["revision"]:
            source = main
        if conn.execute("SELECT 1 FROM document_branches WHERE document_id=%s AND branch=%s AND deleted_at IS NULL",
                        (document_id, body.name)).fetchone():
            raise fail(409, "branch_exists", f"This design already has a branch named {body.name!r}.")
        # An earlier revision's preview may have had its files cleared since (app/build_retention.py): then the branch
        # starts without one and builds it, as a save does (validate_preview).
        preview = live_preview(conn, source["preview_build_id"])
        try:
            row = conn.execute("""INSERT INTO document_branches(id, document_id, branch, name, kind, code, files, links,
                preview_build_id, base_revision, created_from) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                               (uuid4(), document_id, body.name, source["name"], main["kind"], source["code"], Jsonb(dict(source.get("files") or {})),
                                Jsonb(dict(source.get("links") or {})), preview, fork, Jsonb({"branch": "main", "revision": fork}))).fetchone()
        except UniqueViolation:
            raise fail(409, "branch_exists", f"This design already has a branch named {body.name!r}.") from None
        branch_store.journal(conn, row["id"], "branch", [{"branch_id": None, "revision": fork}])
        result = entry(conn, row, main)
    response.headers["Location"] = f"/v1/documents/{document_id}/branches/{body.name}"
    return result


@router.get("/v1/documents/{document_id}/branches/{name}")
def get_branch(document_id: UUID, name: str):
    return main_document(document_id) if name == "main" else read_document(document_id, name)


@router.put("/v1/documents/{document_id}/branches/{name}")
def update_branch(document_id: UUID, name: str, body: DocumentUpdate):
    if name == "main":
        update_document(document_id, body)
        return main_document(document_id)
    from app import revision_messages
    with revision_messages.saving_with(body.message):
        return write_document(document_id, name, body)


@router.delete("/v1/documents/{document_id}/branches/{name}", status_code=204)
def delete_branch(document_id: UUID, name: str):
    if name == "main":
        raise fail(422, "main_branch", "main cannot be deleted.")
    with db.pool.connection() as conn:
        main_row(conn, document_id)
        branch = branch_row(conn, document_id, name, lock=True)
        # Soft delete: the journal and Git commits remain; the ref moves to refs/archive/.
        conn.execute("UPDATE document_branches SET deleted_at=now() WHERE id=%s", (branch["id"],))
        assistant_effects.record(conn, {"discarded": {"document_id": str(document_id), "branch": name}})  # An MCP retry replays it.
    return Response(status_code=204)


def side(row):
    return {"revision": row["revision"], "code": row["code"], "files": dict(row["files"]), "links": dict(row["links"]), "preview_build_id": text_id(row["preview_build_id"]),
            "name": row["name"]}


@router.get("/v1/documents/{document_id}/branches/{name}/compare")
def compare_branch(document_id: UUID, name: str):
    if name == "main":
        raise fail(422, "main_branch", "Compare a named branch with main.")
    with db.pool.connection() as conn:
        main = main_row(conn, document_id)
        branch = branch_row(conn, document_id, name)
        base = base_content(conn, branch)
        return {"base": {"revision": branch["base_revision"], **base, "source": base_source(branch)},
                "main": side(main), "branch": side(branch), "ahead": ahead(conn, branch),
                "behind": main["revision"] - branch["base_revision"],
                "merge": plan_merge(base, content(main), content(branch), name)}


class MergeRequest(BaseModel):
    main_revision: int = Field(ge=1)
    branch_revision: int = Field(ge=1)
    code: str | None = Field(default=None, max_length=MAX_SOURCE)
    files: dict[str, str] | None = Field(default=None, max_length=MAX_FILES)
    links: dict[str, LinkRef] | None = Field(default=None, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=100)


def check_revisions(main, branch, body, during=""):
    if main["revision"] != body.main_revision:
        raise fail(409, "stale_revision", f"Main changed{during}. Compare again before merging; nothing was changed.", main_revision=main["revision"])
    if branch["revision"] != body.branch_revision:
        raise fail(409, "stale_revision", f"The branch changed{during}. Compare again before merging; nothing was changed.", branch_revision=branch["revision"])


def resolve(plan, body, label):
    kinds = {conflict["kind"] for conflict in plan["conflicts"]}
    if ("code" in kinds and body.code is None) or ("file" in kinds and body.files is None) \
            or ("link" in kinds and body.links is None) \
            or (any(c.get("file") for c in plan["conflicts"]) and body.files is None):
        raise fail(422, "conflict", f"Main and {label} changed the same lines, files or links. Send the resolved code (and files or links for those conflicts).",
                   conflicts=plan["conflicts"])
    code = plan["code"] if body.code is None else body.code
    if has_conflict_markers(code):
        raise fail(422, "conflict_markers", "The merged source still contains conflict markers (<<<<<<<, |||||||, =======, >>>>>>>).")
    files = plan["files"] if body.files is None else validate_files(body.files)
    if len(code) + sum(len(text) for text in files.values()) > MAX_SOURCE:
        raise fail(422, "too_large", f"The merged source exceeds {MAX_SOURCE:,} characters together.")
    if any(has_conflict_markers(text) for text in files.values()):
        raise fail(422, "conflict_markers", "A merged file still contains conflict markers (<<<<<<<, |||||||, =======, >>>>>>>).")
    links = plan["links"] if body.links is None else {alias: packed(link) for alias, link in body.links.items()}
    return {"name": body.name or plan["name"], "code": code, "files": files, "links": links}


def prepare_merge(document_id, name, body):
    if name == "main":
        raise fail(422, "main_branch", "Merge a named branch into main.")
    with db.pool.connection() as conn:
        main = main_row(conn, document_id)
        branch = branch_row(conn, document_id, name)
        check_revisions(main, branch, body)
        plan = plan_merge(base_content(conn, branch), content(main), content(branch), name)
    result = resolve(plan, body, name)
    if result == content(main):
        raise fail(422, "up_to_date", "Main already contains this branch; nothing was merged.")
    if not result["code"].strip():
        raise fail(422, "geometry_failure", "The merged source is blank; main was not changed.")
    return main, result


async def build_candidate(kind, result):
    """Generate the merged source without touching the saved document (same wait as feature edits)."""
    request = BuildRequest(kind=kind, name=result["name"], code=result["code"], files=result["files"], links=unpack_links(result["links"]))
    build = await asyncio.to_thread(create_build, request, Response(), None, True)  # Never computed twice (as feature edits).
    deadline = time.monotonic() + BUILD_WAIT  # How long this waits, not how long the build may run (app/config.py).
    while time.monotonic() < deadline:
        build = await asyncio.to_thread(get_build, UUID(build["id"]))
        if build["status"] in {"succeeded", "failed"}:
            break
        await asyncio.sleep(.5)
    if build["status"] not in {"succeeded", "failed"}:
        raise fail(504, "generation_timeout", "Merged geometry is still generating; main was not changed. It carries on: merge again to "
                                              "wait for the same build.", build_id=build["id"])
    if build["status"] == "failed":
        raise fail(422, "geometry_failure", "The merged source failed to generate; main was not changed.", error=build["error"], build_id=build["id"])
    if kind == "part" and (build.get("metadata") or {}).get("solids") != 1:
        raise fail(422, "geometry_failure", "A merged part must produce exactly one valid solid; main was not changed.", build_id=build["id"])
    return build


def save_merge(document_id, name, body, result, build_id):
    with db.pool.connection() as conn:
        main = main_row(conn, document_id, "update")
        branch = branch_row(conn, document_id, name, lock=True)
        # Compare-and-swap: a human/AI write to either head during generation wins; nothing is saved.
        check_revisions(main, branch, body, " while the merge was generating")
        build_id = validate_preview(conn, build_id)
        row = conn.execute("""UPDATE documents SET name=%s, code=%s, files=%s, links=%s, preview_build_id=%s,
            revision=revision+1, updated_at=now() WHERE id=%s RETURNING *""",
                           (result["name"], result["code"], Jsonb(result["files"]), Jsonb(stored_links(result["links"])), build_id, document_id)).fetchone()
        conn.execute("INSERT INTO document_merges(document_id, revision, branch_id, branch_revision, base) VALUES (%s,%s,%s,%s,%s)",
                     (document_id, row["revision"], branch["id"], branch["revision"], Jsonb(base_source(branch))))
        # Git-style merge base: main now contains this branch revision.
        conn.execute("UPDATE document_branches SET base_revision=%s, base_branch_revision=%s, merged_revision=%s WHERE id=%s",
                     (row["revision"], branch["revision"], branch["revision"], branch["id"]))
        document = serialize_document(row)
        assistant_effects.record(conn, document)  # An MCP retry (merge_branch) replays the merge instead of repeating it.
    # Exactly the saved merge revision (same shape as GET /v1/documents/{id}).
    return document


def exported_commit(document_id, revision):
    try:
        history.synchronize()
    except Exception as error:
        logging.getLogger("feature.branches").warning("Git export paused (%s); the merge is saved in the journal.", type(error).__name__)
    with db.pool.connection() as conn:
        row = conn.execute("SELECT git_commit FROM document_revisions WHERE document_id=%s AND revision=%s", (document_id, revision)).fetchone()
    return row["git_commit"] if row else None


@router.post("/v1/documents/{document_id}/branches/{name}/merge")
async def merge_branch(document_id: UUID, name: str, body: MergeRequest):
    main, result = await asyncio.to_thread(prepare_merge, document_id, name, body)
    model = await build_candidate(main["kind"], result)
    document = await asyncio.to_thread(save_merge, document_id, name, body, result, UUID(model["id"]))
    commit_id = await asyncio.to_thread(exported_commit, document_id, document["revision"])
    return {"document": document, "model": model, "merge": {"branch": name, "main_revision": document["revision"], "commit_id": commit_id}}


@router.post("/v1/documents/{document_id}/branches/{name}/sync")
def sync_branch(document_id: UUID, name: str, body: MergeRequest):
    if name == "main":
        raise fail(422, "main_branch", "Sync a named branch with main.")
    with db.pool.connection() as conn:
        main = main_row(conn, document_id, "share")
        branch = branch_row(conn, document_id, name, lock=True)
        check_revisions(main, branch, body)
        result = resolve(plan_merge(base_content(conn, branch), content(main), content(branch), name), body, name)
        if result == content(branch):
            # Main's changes are already here: only the merge base moves.
            row = conn.execute("UPDATE document_branches SET base_revision=%s, base_branch_revision=NULL WHERE id=%s RETURNING *",
                               (main["revision"], branch["id"])).fetchone()
        else:
            # No build here: reuse main's preview when the branch becomes identical to main, else keep the
            # branch's (clients already compare a preview's source with the document before calling it current).
            preview = main["preview_build_id"] if result == content(main) else branch["preview_build_id"]
            row = conn.execute("""UPDATE document_branches SET name=%s, code=%s, files=%s, links=%s, preview_build_id=%s,
                revision=revision+1, base_revision=%s, base_branch_revision=NULL, updated_at=now() WHERE id=%s RETURNING *""",
                               (result["name"], result["code"], Jsonb(result["files"]), Jsonb(stored_links(result["links"])), preview,
                                main["revision"], branch["id"])).fetchone()
            branch_store.journal(conn, row["id"], "sync", [{"branch_id": str(row["id"]), "revision": branch["revision"]},
                                                           {"branch_id": None, "revision": main["revision"]}])
        return branch_document(conn, row, main)


def fingerprint(row):
    return row["name"], row["code"], row["files"], json.dumps(row["links"] or {}, sort_keys=True)


def describe(previous, row, seen):
    """Derive a node kind/message from its predecessor on the same line."""
    current = fingerprint(row)
    if current != fingerprint(previous) and current in seen:
        return "restore", f"Restored r{seen[current]}"
    if row["code"] != previous["code"] or row["files"] != previous["files"]:
        return "edit", "Edited source"
    if row["name"] != previous["name"]:
        return "edit", f"Renamed to {row['name']}"
    if row["links"] != previous["links"]:
        return "edit", "Changed links"
    if row["preview"] != previous["preview"]:
        return "edit", "Generated model" if row["preview"] else "Cleared model"
    return "edit", "Saved without changes"


@router.get("/v1/documents/{document_id}/graph")
def get_graph(document_id: UUID, limit: int = Query(default=300, ge=1, le=1000)):
    from app.teams import who   # who made each revision, and how (docs/TEAMS.md "Attribution")
    try:
        history.synchronize()
    except Exception as error:
        logging.getLogger("feature.branches").warning("Git export paused (%s); graph commit IDs may be null.", type(error).__name__)
    columns = """event_id, revision, recorded_at, git_commit, snapshot->>'name' AS name, md5(snapshot->>'code') AS code,
        md5(coalesce(snapshot->>'files', '{}')) AS files, snapshot->'links' AS links, snapshot->>'preview_build_id' AS preview, actor, message AS saved_message"""
    with db.pool.connection() as conn:
        main = main_row(conn, document_id)
        main_rows = conn.execute(f"SELECT {columns} FROM document_revisions WHERE document_id=%s ORDER BY revision", (document_id,)).fetchall()
        merges = {row["revision"]: row for row in conn.execute(
            "SELECT revision, branch_id, branch_revision FROM document_merges WHERE document_id=%s", (document_id,)).fetchall()}
        branches = conn.execute("SELECT id, branch, revision, deleted_at FROM document_branches WHERE document_id=%s ORDER BY created_at, id",
                                (document_id,)).fetchall()
        branch_rows = conn.execute(f"""SELECT branch_id, change, parents, {columns} FROM document_branch_revisions
            WHERE document_id=%s ORDER BY revision""", (document_id,)).fetchall()
    merged = {str(row["branch_id"]) for row in merges.values()}
    # Deleted branches stay visible only where main merged them; their labels get a stable suffix.
    labels = {str(b["id"]): b["branch"] if b["deleted_at"] is None else f"{b['branch']}~{b['id'].hex[:8]}"
              for b in branches if b["deleted_at"] is None or str(b["id"]) in merged}

    def key(branch_id, revision):
        return f"{'main' if branch_id is None else labels[str(branch_id)]}@{revision}"

    def node(row, label, parents, kind, message):
        return {"key": f"{label}@{row['revision']}", "branch": label, "revision": row["revision"], "recorded_at": iso(row["recorded_at"]),
                # The saver's own words when given (app/revision_messages.py); `change` is what STEVE sees changed.
                "parents": parents, "kind": kind, "message": row.get("saved_message") or message, "change": message,
                "commit_id": row["git_commit"],
                "preview_build_id": row["preview"], "event_id": row["event_id"], "by": who(row.get("actor"))}

    nodes, previous, seen = [], None, {}
    for row in main_rows:
        parents = [f"main@{previous['revision']}"] if previous else []
        merge = merges.get(row["revision"])
        if merge and str(merge["branch_id"]) in labels:
            parents.append(key(merge["branch_id"], merge["branch_revision"]))
            kind, message = "merge", f"Merged {labels[str(merge['branch_id'])]}"
        elif previous is None:
            kind, message = ("create", f"Created {row['name']}") if row["revision"] == 1 else ("edit", f"Earliest recorded revision (r{row['revision']})")
        else:
            kind, message = describe(previous, row, seen)
        nodes.append(node(row, "main", parents, kind, message))
        seen[fingerprint(row)], previous = row["revision"], row
    lines = {}
    for row in branch_rows:
        if str(row["branch_id"]) in labels:
            lines.setdefault(str(row["branch_id"]), []).append(row)
    for branch_id, rows in lines.items():
        previous, seen = None, {}
        for row in rows:
            parents = [key(parent.get("branch_id"), parent["revision"]) for parent in row["parents"]]
            main_parents = [parent["revision"] for parent in row["parents"] if parent.get("branch_id") is None]
            if row["change"] == "branch":
                kind, message = "branch", f"Branched from main r{main_parents[0]}"
            elif row["change"] == "sync":
                kind, message = "sync", f"Synced with main r{main_parents[-1]}"
            else:
                kind, message = describe(previous, row, seen)
            nodes.append(node(row, labels[branch_id], parents, kind, message))
            seen[fingerprint(row)], previous = row["revision"], row
    nodes.sort(key=lambda item: item["event_id"], reverse=True)
    for item in nodes:
        item.pop("event_id")
    heads = [{"name": "main", "head_key": f"main@{main['revision']}", "color_index": 0, "deleted": False}]
    heads += [{"name": labels[str(b["id"])], "head_key": f"{labels[str(b['id'])]}@{b['revision']}", "color_index": index,
               "deleted": b["deleted_at"] is not None} for index, b in enumerate(branches, start=1) if str(b["id"]) in labels]
    return {"document_id": str(document_id), "nodes": nodes[:limit], "branches": heads}


class CombineRequest(BaseModel):
    """Unsaved edits made on `base_revision` of `branch` (main by default)."""
    base_revision: int = Field(ge=1)
    branch: str = Field(default="main", max_length=48)
    name: str = Field(min_length=1, max_length=100)
    code: str = Field(default="", max_length=MAX_SOURCE)
    files: dict[str, str] = Field(default_factory=dict, max_length=MAX_FILES)
    links: dict[str, LinkRef] = Field(default_factory=dict, max_length=64)


LATEST_MARKER = re.compile(r"^<<<<<<< main$", re.M)


def line_merge(result: dict) -> dict:
    """diff3 conflicts adjacent edits (a parameter block where one side changed `width` and the other
    `height`). Where a conflicting block has the same lines on every side and each line was changed by at
    most one side, it merges line by line; only lines both sides changed stay marked."""
    lines = result["code"].splitlines(keepends=True)
    kept = []
    for conflict in sorted(result["conflicts"], key=lambda c: c["start_line"] or 0, reverse=True):
        if not conflict.get("start_line"):
            kept.append(conflict)
            continue
        base, ours, theirs = (conflict[k].splitlines(keepends=True) for k in ("base", "ours", "theirs"))
        if not (len(base) == len(ours) == len(theirs)):
            kept.append(conflict)
            continue
        merged = []
        for b, o, t in zip(base, ours, theirs):
            if o == b or o == t:
                merged.append(t)
            elif t == b:
                merged.append(o)
            else:
                break
        else:
            lines[conflict["start_line"] - 1:conflict["end_line"]] = merged
            continue
        kept.append(conflict)
    return {**result, "code": "".join(lines), "conflicts": sorted(kept, key=lambda c: c["start_line"] or 0)}


@router.post("/v1/documents/{document_id}/combine")
def combine_edits(document_id: UUID, body: CombineRequest):
    """Edits made on an older revision, combined with what was saved since (STEVE, another window): the same
    three-way merge as branches. Nothing is saved. `clean`: the combined document, to save at `revision`.
    `conflict`: the text carries diff3 markers (<<<<<<< latest / >>>>>>> your edits) to resolve first."""
    with db.pool.connection() as conn:
        if body.branch == "main":
            current = main_row(conn, document_id)
            base = main_snapshot(conn, document_id, body.base_revision)
        else:
            current = branch_row(conn, document_id, body.branch)
            row = conn.execute("SELECT snapshot FROM document_branch_revisions WHERE branch_id=%s AND revision=%s",
                               (current["id"], body.base_revision)).fetchone()
            base = migrations.snapshot(conn, row["snapshot"]) if row else None
    if base is None:
        raise fail(422, "revision_unavailable", f"Revision {body.base_revision} isn't in this design's history; keep your version or reopen the latest.")
    old, latest = content(base), content(current)
    mine_links = {alias: packed(link) for alias, link in body.links.items() if link.revision is not None}
    mine_links.update({alias: latest["links"][alias] for alias, link in body.links.items() if link.revision is None and alias in latest["links"]})
    text = line_merge(merge_text(old["code"], latest["code"], body.code, ours_label="latest", theirs_label="your edits"))
    conflicts = list(text["conflicts"])
    mine_files = validate_files(body.files)
    files, file_conflicts = merge_files(old["files"], latest["files"], mine_files, "your edits", len(conflicts))
    for path in {c["file"] for c in file_conflicts if c.get("start_line")}:  # Text conflicts inside a file: refine them too.
        refined = line_merge(merge_text(old["files"].get(path, ""), latest["files"][path], mine_files[path], ours_label="latest", theirs_label="your edits"))
        files[path] = refined["code"]
        file_conflicts = [c for c in file_conflicts if c.get("file") != path or not c.get("start_line")] + [{**c, "file": path} for c in refined["conflicts"]]
    files = {path: LATEST_MARKER.sub("<<<<<<< latest", value) for path, value in files.items()}
    conflicts += file_conflicts
    links, link_conflicts = merge_map(old["links"], latest["links"], mine_links)
    conflicts += [{"index": len(conflicts) + i, "kind": "link", "alias": c["alias"], "start_line": None, "end_line": None,
                   "base": c["base"], "ours": c["ours"], "theirs": c["theirs"],
                   "message": f"The latest revision and your edits link {c['alias']!r} differently."} for i, c in enumerate(link_conflicts)]
    return {"revision": current["revision"], "kind": current["kind"], "status": "conflict" if conflicts else "clean",
            "name": merge_value(old["name"], latest["name"], body.name), "code": text["code"], "files": files,
            "links": stored_links(links), "conflicts": conflicts}
