"""Durable revision journal projected into one local bare Git repository.

The database trigger records every document write, including existing REST/MCP tools.
Git export is restartable: an interrupted ref update is reconciled by deterministic
commit identity. A Git outage never erases the database's immutable source revisions.
"""
import asyncio
from contextlib import asynccontextmanager, suppress
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import tempfile

from fastapi import HTTPException
from app import accounts_db, core_scope, db, migrations
from app.accounts_db import Migration
from app.workspace import acting_for, current_workspace
from . import branch_store

REPOSITORY = Path(os.getenv("FEATURE_HISTORY_DIR", "/history/workspace.git"))
ZERO = "0" * 40
# Design refs, each workspace's under refs/namespaces/<workspace>/ (docs/ACCOUNTS.md, mechanism 4). Study and
# manufacturing refs in the same repository follow when their areas are scoped.
DOCUMENT_REFS = ("refs/heads/main", "refs/heads/doc/", "refs/archive/doc/")


def owns_repository() -> bool:
    """Whether this process can write the history repository (its volume is mounted read-write here)."""
    return os.access(REPOSITORY.parent, os.W_OK)


def namespaced(ref: str, workspace: str | None = None) -> str:
    """A design ref inside the workspace's Git namespace (the current workspace unless given)."""
    workspace = workspace or current_workspace.get()
    if not workspace:
        raise PermissionError("Git history needs a workspace.")
    return f"refs/namespaces/{workspace}/{ref}"


@asynccontextmanager
async def lifespan():
    await asyncio.to_thread(initialize)
    async def export_history():
        while True:
            try:
                await asyncio.to_thread(synchronize)
            except Exception as error:
                logging.getLogger("feature.history").warning("Git export paused (%s); revisions remain in the database journal.", type(error).__name__)
            await asyncio.sleep(1)
    task = asyncio.create_task(export_history())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


def git(*args, data=None, index=None, timestamp=None, allow_missing=False, work_tree=None):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_AUTHOR_NAME": "STEVE", "GIT_COMMITTER_NAME": "STEVE",
           "GIT_AUTHOR_EMAIL": "steve@local.invalid", "GIT_COMMITTER_EMAIL": "steve@local.invalid"}
    if index:
        env["GIT_INDEX_FILE"] = str(index)
    if work_tree:
        # The repository is bare; the few index commands that insist on a work tree get an empty one.
        env["GIT_WORK_TREE"] = str(work_tree)
    if timestamp:
        date = f"{int(timestamp.timestamp())} +0000"
        env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    command = ["git", "-c", "core.hooksPath=/dev/null", "--git-dir", str(REPOSITORY), *args]
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30)
    if result.returncode and not allow_missing:
        raise RuntimeError("Local Git history operation failed: " + result.stderr.decode(errors="replace")[:1000])
    return result.stdout if not result.returncode else None


def initialize():
    with db.pool.connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(87412030)")
        conn.execute("""CREATE TABLE IF NOT EXISTS document_revisions (
            event_id bigserial PRIMARY KEY,
            document_id uuid NOT NULL,
            revision integer NOT NULL,
            snapshot jsonb NOT NULL,
            recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            git_commit text,
            UNIQUE(document_id, revision)
        )""")
        conn.execute("""CREATE OR REPLACE FUNCTION feature_lab_record_revision() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                PERFORM pg_advisory_xact_lock(87412031);
                INSERT INTO document_revisions(workspace_id, document_id, revision, snapshot)
                VALUES (NEW.workspace_id, NEW.id, NEW.revision, to_jsonb(NEW) - 'workspace_id');
                RETURN NEW;
            END $$""")
        # A revision is recorded when one is created. Attaching the full build to a saved
        # revision (POST /v1/documents/{id}/preview) changes no revision and records nothing.
        conn.execute("""CREATE OR REPLACE TRIGGER feature_lab_document_revision
            AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION feature_lab_record_revision()""")
        conn.execute("""CREATE OR REPLACE TRIGGER feature_lab_document_revision_update
            AFTER UPDATE ON documents FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
            EXECUTE FUNCTION feature_lab_record_revision()""")
        branch_store.initialize(conn)  # Per-document branch journal sharing this event sequence.
        from app import revision_messages  # what a save is, in the saver's words (both revision tables)
        revision_messages.ensure(conn)
        from .. import trash  # An AI agent session's claim on the documents it created ends when anyone else acts on them.
        trash.watch_origins(conn)
        # A new revision of main or a branch, or a build attached to one (an agent's save is built in the background and
        # attached afterwards, app/cad_tools.py _attach_latest), wakes the windows that have that design open
        # (app/document_events.py), on commit, whichever path saved it (the editor, STEVE, MCP, a merge or a restore).
        # Only the id is sent.
        conn.execute("""CREATE OR REPLACE FUNCTION steve_document_event() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                IF TG_TABLE_NAME = 'documents' THEN
                    PERFORM pg_notify('document_events', NEW.id::text);
                ELSE
                    PERFORM pg_notify('document_events', NEW.document_id::text);
                END IF;
                RETURN NEW;
            END $$""")
        for table in ("documents", "document_branches"):
            conn.execute(f"""CREATE OR REPLACE TRIGGER steve_{table}_event AFTER UPDATE ON {table} FOR EACH ROW
                WHEN (OLD.revision IS DISTINCT FROM NEW.revision OR OLD.preview_build_id IS DISTINCT FROM NEW.preview_build_id)
                EXECUTE FUNCTION steve_document_event()""")
        # Moving refs is for the process that owns the repository (the API); others (e.g. the simulation service) only
        # scope the tables, so the move is never recorded by a process that couldn't make it.
        accounts_db.migrate(conn, core_scope.HISTORY_MIGRATIONS + (GIT_MIGRATIONS if owns_repository() else []))
        # Seed pre-experiment current documents once. Earlier overwritten revisions
        # cannot be recovered retroactively and are never fabricated.
        conn.execute("""INSERT INTO document_revisions(workspace_id, document_id, revision, snapshot)
            SELECT workspace_id, id, revision, to_jsonb(documents) - 'workspace_id' FROM documents ORDER BY created_at, id
            ON CONFLICT(document_id, revision) DO NOTHING""")
        adopt_configured_account(conn)
    synchronize()


def move_namespace(source: str, target: str | None, refs: tuple[str, ...] | None = DOCUMENT_REFS) -> int:
    """Moves refs from one place to a workspace's namespace: `source` is a ref prefix ("refs/" for the pre-accounts
    global refs, or "refs/namespaces/<ws>/refs/" for a whole workspace), `refs` limits it to those ref prefixes (the
    design refs by default; None: every ref under `source`, e.g. a workspace's studies and programs too). Objects stay
    where they are; nothing is rewritten. Refuses to overwrite a ref the target already has. Returns the refs moved."""
    listing = git("for-each-ref", "--format=%(refname) %(objectname)", allow_missing=True)
    moved = 0
    for line in (listing or b"").decode().splitlines():
        name, commit = line.split()
        if not name.startswith(source):
            continue
        ref = "refs/" + name[len(source):]
        if refs is not None and not ref.startswith(refs):
            continue
        destination = namespaced(ref, target)
        current = git("rev-parse", "--verify", "--quiet", destination, allow_missing=True)
        if current and current.decode().strip() != commit:
            raise RuntimeError(f"{destination} already exists; the history was not moved.")
        if not current:
            git("update-ref", destination, commit, ZERO)
        git("update-ref", "-d", name, commit)
        moved += 1
    return moved


def _namespace_existing_refs(conn):
    """Pre-accounts design refs (refs/heads/main, refs/heads/doc/..., refs/archive/doc/...) belong to the migration
    target (the dev local workspace until an account is adopted): they move under its namespace."""
    if (REPOSITORY / "HEAD").exists():
        move_namespace("refs/", accounts_db.migration_target(conn))


GIT_MIGRATIONS = [Migration("0012-history-git-namespaces", _namespace_existing_refs)]


def adopt_configured_account(conn):
    """ACCOUNTS_MIGRATE_TO=<issuer>|<subject>: the named account takes over the dev install's data once (rows in every
    scoped table and the design history refs). docs/ACCOUNTS.md, "Migration of existing data". The other form,
    first-admin, happens on the first admin sign-in instead (app/adoption.py)."""
    value = os.getenv("ACCOUNTS_MIGRATE_TO", "").strip()
    if not value or value.lower() == "first-admin" or not owns_repository():
        return
    issuer, _, subject = value.rpartition("|")
    if not issuer or not subject:
        raise RuntimeError("ACCOUNTS_MIGRATE_TO must be <issuer>|<subject>.")
    from app.workspace import personal_workspace
    workspace = personal_workspace(issuer, subject)
    def adopt(conn):
        previous = accounts_db.migration_target(conn)
        accounts_db.adopt_target(conn, workspace)
        if (REPOSITORY / "HEAD").exists() and previous != workspace:  # Everything in it: designs, studies, programs.
            move_namespace(f"refs/namespaces/{previous}/refs/", workspace, refs=None)
    accounts_db.migrate(conn, [Migration(accounts_db.target_migration_id(workspace), adopt)])


# Documents kept as a folder in the history tree: (folder, entry file holding `code`). A kind missing here would be kept
# as its one main file, and its other files dropped from history.
FOLDERS = {"design": ("designs", "main.py"), "circuit": ("circuits", "main.tsx"), "shop": ("shops", "main.py"),
           "cam": ("cam", "main.py"), "blender": ("blender", "main.py")}   # CAM programs: until 2026-10-16 their main.py alone went to assemblies/<id>.py


def snapshot_tree(identity, snapshot, manifest, base, prefix="feature-history-"):
    """The tree of `base` with this document's files replaced: one file for a part (or a journaled
    assembly), or a folder for a design (designs/<id>/main.py and its other files), a circuit
    (circuits/<id>/main.tsx and its other files) or a shop (shops/<id>/main.py and its other files); removed files are
    dropped."""
    if snapshot["kind"] in FOLDERS:
        root, entry = FOLDERS[snapshot["kind"]]
        folder = f"{root}/{identity}/"
        files = {f"{folder}{entry}": snapshot["code"].encode(), **{f"{folder}{path}": text.encode() for path, text in (snapshot.get("files") or {}).items()}}
    else:
        folder = None
        files = {f"{'parts' if snapshot['kind'] == 'part' else 'assemblies'}/{identity}.py": snapshot["code"].encode()}
    files[f"documents/{identity}.json"] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    with tempfile.TemporaryDirectory(prefix=prefix) as temporary:
        index = Path(temporary) / "index"
        git("read-tree", base or "--empty", index=index)
        if folder:
            # An assembly's single file went away when it became a design.
            listed = git("ls-files", "--cached", "--", folder, f"assemblies/{identity}.py", index=index).decode().splitlines()
            for stale in (path for path in listed if path not in files):
                # update-index refuses to run without a work tree, even for --force-remove of an index entry.
                git("update-index", "--force-remove", stale, index=index, work_tree=temporary)
        for path, data in files.items():
            blob = git("hash-object", "-w", "--stdin", data=data).decode().strip()
            git("update-index", "--add", "--cacheinfo", "100644", blob, path, index=index)
        return git("write-tree", index=index).decode().strip()


def make_commit(row, parent, merge=None):
    snapshot = row["snapshot"]
    identity = str(row["document_id"])
    manifest = {"id": identity, "name": snapshot["name"], "kind": snapshot["kind"],
                "revision": row["revision"], **({"links": snapshot["links"]} if snapshot.get("links") else {}),
                **({"parts": snapshot["part_references"]} if snapshot.get("part_references") else {})}  # Journaled assemblies
    tree = snapshot_tree(identity, snapshot, manifest, parent)
    message = f"Checkpoint {row['event_id']}: {identity} revision {row['revision']}\n"
    parents = ["-p", parent] if parent else []
    if merge:  # A branch merged into main: its head commit is the second parent.
        message += f"\nMerge branch '{merge['branch']}' revision {merge['branch_revision']} into main\n"
        parents += ["-p", merge["commit"]]
    return git("commit-tree", tree, *parents, data=message.encode(), timestamp=row["recorded_at"]).decode().strip()


def pending_workspaces() -> list[str]:
    """Workspaces with design revisions not yet in Git (a system operation: the exporter serves every workspace)."""
    with db.system("history.export") as conn:
        rows = conn.execute("""SELECT workspace_id FROM document_revisions WHERE git_commit IS NULL
            UNION SELECT workspace_id FROM document_branch_revisions WHERE git_commit IS NULL
            UNION SELECT workspace_id FROM document_branches WHERE deleted_at IS NOT NULL AND NOT ref_archived""").fetchall()
    return [str(row["workspace_id"]) for row in rows]


def synchronize(limit=100):
    """Exports pending revisions to Git: the current workspace's (a request), or every workspace's in turn (the
    background exporter), each into its own namespace."""
    if not owns_repository():
        return  # Only the API exports; a process without the history volume must never record commits it can't keep.
    if current_workspace.get():
        return _synchronize(current_workspace.get(), limit)
    for workspace in pending_workspaces():
        with acting_for(workspace):
            _synchronize(workspace, limit)


def _synchronize(workspace, limit):
    for _ in range(limit):
        # One transaction per Git ref advance, so crash recovery handles at most
        # one already-written but unacknowledged commit.
        with db.pool.connection() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(87412030)")
            if not (REPOSITORY / "HEAD").exists():
                REPOSITORY.mkdir(parents=True, exist_ok=True)
                git("init", "--bare", "--initial-branch=main", str(REPOSITORY))
            # Filters name the workspace as well: the same code is right under a role that sees every workspace.
            row = conn.execute("SELECT * FROM document_revisions WHERE git_commit IS NULL AND workspace_id=%s ORDER BY event_id LIMIT 1 FOR UPDATE",
                               (workspace,)).fetchone()
            # Branch revisions share the event order; export those preceding this main revision first.
            if branch_store.export_next(conn, row["event_id"] if row else None, workspace):
                continue
            if not row:
                return
            # A permanently deleted document's exported rows are gone from the journal; their commits stay in the
            # chain (document_purged_commits, app/trash.py).
            previous = conn.execute("""SELECT git_commit FROM (
                    SELECT event_id, git_commit FROM document_revisions WHERE git_commit IS NOT NULL AND workspace_id=%(ws)s
                    UNION ALL SELECT event_id, git_commit FROM document_purged_commits WHERE workspace_id=%(ws)s) chain
                WHERE event_id < %(event)s ORDER BY event_id DESC LIMIT 1""", {"event": row["event_id"], "ws": workspace}).fetchone()
            parent = previous["git_commit"] if previous else None
            commit = make_commit(row, parent, branch_store.merge_parent(conn, row))
            main = namespaced("refs/heads/main", workspace)
            head_bytes = git("rev-parse", "--verify", main, allow_missing=True)
            head = head_bytes.decode().strip() if head_bytes else None
            if head == parent:
                git("update-ref", main, commit, parent or ZERO)
            elif head != commit:
                raise RuntimeError("Git main was changed outside the history service; automatic history export stopped without overwriting it.")
            conn.execute("UPDATE document_revisions SET git_commit=%s WHERE event_id=%s", (commit, row["event_id"]))


def list_revisions(document_id, limit=100, offset=0):
    synchronize()
    with db.pool.connection() as conn:
        rows = conn.execute("""SELECT event_id, revision, recorded_at, git_commit AS commit_id, actor, message
            FROM document_revisions WHERE document_id=%s ORDER BY revision DESC LIMIT %s OFFSET %s""", (document_id, limit, offset)).fetchall()
    from app.teams import who   # who made each revision, and how (docs/TEAMS.md "Attribution")
    return {"document_id": str(document_id), "revisions": [{**{k: v for k, v in row.items() if k != "actor"},
                                                            "recorded_at": row["recorded_at"].isoformat(), "by": who(row["actor"])} for row in rows]}


def read_snapshot(document_id, commit_id):
    if not re.fullmatch(r"[0-9a-f]{40}", commit_id):
        raise HTTPException(422, {"code": "invalid_commit", "message": "Use a full local-history commit ID."})
    synchronize()
    with db.pool.connection() as conn:
        known = conn.execute("""SELECT 1 FROM document_revisions WHERE git_commit=%s
            UNION ALL SELECT 1 FROM document_branch_revisions WHERE git_commit=%s LIMIT 1""", (commit_id, commit_id)).fetchone()
    if not known:
        raise HTTPException(404, "History commit not found.")
    manifest = git("show", f"{commit_id}:documents/{document_id}.json", allow_missing=True)
    if manifest is None:
        raise HTTPException(404, "This document did not exist at that commit.")
    document = json.loads(manifest)
    if document["kind"] in FOLDERS:  # A folder: the entry file (main.py, main.tsx) is the code, everything else its files.
        root, entry = FOLDERS[document["kind"]]
        prefix = f"{root}/{document_id}/"
        document["code"], document["files"] = "", {}
        listed = git("ls-tree", "-r", "--name-only", commit_id, "--", prefix).decode().splitlines()
        for path in listed:
            text = git("show", f"{commit_id}:{path}").decode()
            if path == f"{prefix}{entry}":
                document["code"] = text
            else:
                document["files"][path[len(prefix):]] = text
        if not listed:   # an older commit of a CAM program: its main.py alone, as an assembly's file
            older = git("ls-tree", "--name-only", commit_id, "--", f"assemblies/{document_id}.py").decode().strip()
            if older:
                document["code"] = git("show", f"{commit_id}:{older}").decode()
    else:
        folder = "parts" if document["kind"] == "part" else "assemblies"
        document["code"] = git("show", f"{commit_id}:{folder}/{document_id}.py").decode()
    return {"commit_id": commit_id, "document": migrations.historical(document)}
