"""Per-document branch journal and its projection into the local Git history.

`main` is the ordinary `documents` row and its `document_revisions` journal. Every other
branch has a head row in `document_branches` and immutable revisions in
`document_branch_revisions`. Branch revisions draw their event IDs from the main journal's
sequence under the same advisory lock as the main journal trigger, so one global event
order exists and `history.synchronize()` can export both journals in that order: a branch
commit is written after the main commit it forks from, and a main merge commit is written
after the branch commit it merges. Commit identity stays deterministic (timestamps and
messages come from SQL), so the existing crash reconciliation still applies.

Git refs, each inside its workspace's namespace refs/namespaces/<workspace>/ (docs/ACCOUNTS.md):
  refs/heads/main                                       unchanged linear first-parent chain
  refs/heads/doc/<document UUID>/<branch>               live branch head
  refs/archive/doc/<document UUID>/<branch>/<branch ID> deleted branch head (kept reachable)
"""

from psycopg import sql
from psycopg.types.json import Jsonb

from .. import db, migrations
from . import history

JOURNAL_LOCK = 87412031  # Also taken by the main journal trigger (feature_lab_record_revision).


def initialize(conn):
    """Idempotent schema; runs inside history.initialize() after document_revisions exists."""
    sequence = conn.execute("SELECT pg_get_serial_sequence('document_revisions', 'event_id') AS name").fetchone()["name"]
    conn.execute("""CREATE TABLE IF NOT EXISTS document_branches (
        id uuid PRIMARY KEY,
        document_id uuid NOT NULL REFERENCES documents(id),
        branch text NOT NULL,
        name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('part', 'design', 'circuit', 'shop')),
        code text NOT NULL DEFAULT '',
        part_references jsonb NOT NULL DEFAULT '{}'::jsonb,  -- Retired with assemblies; read once by app/migrations.py.
        preview_build_id uuid REFERENCES builds(id),
        revision integer NOT NULL DEFAULT 1,
        base_revision integer NOT NULL,
        base_branch_revision integer,
        merged_revision integer NOT NULL DEFAULT 1,
        created_from jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        ref_archived boolean NOT NULL DEFAULT false
    )""")
    conn.execute("ALTER TABLE document_branches ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '{}'::jsonb")
    conn.execute("ALTER TABLE document_branches ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '{}'::jsonb")
    migrations.assemblies_to_designs(conn, "document_branches")
    migrations.widen_kinds(conn, "document_branches")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS document_branches_live ON document_branches(document_id, branch) WHERE deleted_at IS NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS document_branches_document ON document_branches(document_id, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS document_branches_unarchived ON document_branches(deleted_at) WHERE deleted_at IS NOT NULL AND NOT ref_archived")
    conn.execute(sql.SQL("""CREATE TABLE IF NOT EXISTS document_branch_revisions (
        event_id bigint PRIMARY KEY DEFAULT nextval({sequence}::regclass),
        branch_id uuid NOT NULL REFERENCES document_branches(id),
        document_id uuid NOT NULL,
        revision integer NOT NULL,
        change text NOT NULL CHECK (change IN ('branch', 'edit', 'sync')),
        parents jsonb NOT NULL,
        snapshot jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        git_commit text,
        UNIQUE(branch_id, revision)
    )""").format(sequence=sql.Literal(sequence)))
    conn.execute("CREATE INDEX IF NOT EXISTS document_branch_revisions_pending ON document_branch_revisions(event_id) WHERE git_commit IS NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS document_branch_revisions_document ON document_branch_revisions(document_id, event_id)")
    conn.execute("""CREATE TABLE IF NOT EXISTS document_merges (
        document_id uuid NOT NULL,
        revision integer NOT NULL,
        branch_id uuid NOT NULL REFERENCES document_branches(id),
        branch_revision integer NOT NULL,
        base jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(document_id, revision)
    )""")
    # Journal rows are immutable apart from their Git acknowledgment.
    conn.execute("""CREATE OR REPLACE FUNCTION steve_branch_journal_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
            IF TG_OP = 'DELETE' OR TG_TABLE_NAME = 'document_merges'
               OR (to_jsonb(NEW) - 'git_commit') IS DISTINCT FROM (to_jsonb(OLD) - 'git_commit') THEN
                RAISE EXCEPTION 'Branch history is immutable.';
            END IF;
            RETURN NEW;
        END $$""")
    for table in ("document_branch_revisions", "document_merges"):
        conn.execute(sql.SQL("""CREATE OR REPLACE TRIGGER {name} BEFORE UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION steve_branch_journal_immutable()""").format(
            name=sql.Identifier(f"{table}_immutable"), table=sql.Identifier(table)))


def journal(conn, branch_id, change, parents):
    """Record the branch head's current state as an immutable revision (same transaction)."""
    # Serialize with the main journal trigger so event IDs are assigned in commit order.
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (JOURNAL_LOCK,))
    conn.execute("""INSERT INTO document_branch_revisions(workspace_id, branch_id, document_id, revision, change, parents, snapshot)
        SELECT workspace_id, id, document_id, revision, %s, %s, to_jsonb(b) - 'deleted_at' - 'ref_archived' - 'workspace_id'
        FROM document_branches b WHERE id=%s""",
                 (change, Jsonb(parents), branch_id))


def live_ref(document_id, branch):
    return history.namespaced(f"refs/heads/doc/{document_id}/{branch}")


def archive_ref(document_id, branch, branch_id):
    return history.namespaced(f"refs/archive/doc/{document_id}/{branch}/{branch_id}")


def resolve(ref):
    value = history.git("rev-parse", "--verify", "--quiet", ref, allow_missing=True)
    return value.decode().strip() if value else None


def parent_commit(conn, document_id, parent):
    if parent.get("branch_id") is None:
        row = conn.execute("SELECT git_commit FROM document_revisions WHERE document_id=%s AND revision=%s",
                           (document_id, parent["revision"])).fetchone()
    else:
        row = conn.execute("SELECT git_commit FROM document_branch_revisions WHERE branch_id=%s AND revision=%s",
                           (parent["branch_id"], parent["revision"])).fetchone()
    if not row or not row["git_commit"]:
        raise RuntimeError("Branch export is waiting for a parent revision that has no Git commit yet.")
    return row["git_commit"]


def write_commit(document_id, snapshot, revision, base, parents, message, timestamp, branch):
    identity = str(document_id)
    manifest = {"id": identity, "name": snapshot["name"], "kind": snapshot["kind"], "revision": revision,
                "branch": branch, **({"links": snapshot["links"]} if snapshot.get("links") else {}),
                **({"parts": snapshot["part_references"]} if snapshot.get("part_references") else {})}  # Journaled assemblies
    tree = history.snapshot_tree(identity, snapshot, manifest, base, prefix="branch-history-")
    arguments = [value for parent in parents for value in ("-p", parent)]
    return history.git("commit-tree", tree, *arguments, data=message.encode(), timestamp=timestamp).decode().strip()


def archive_deleted(conn, workspace):
    """Move one fully exported deleted branch from refs/heads/doc/... to refs/archive/doc/..."""
    row = conn.execute("""SELECT * FROM document_branches b WHERE deleted_at IS NOT NULL AND NOT ref_archived AND workspace_id=%s
        AND NOT EXISTS (SELECT 1 FROM document_branch_revisions r WHERE r.branch_id=b.id AND r.git_commit IS NULL)
        ORDER BY deleted_at, id LIMIT 1 FOR UPDATE""", (workspace,)).fetchone()
    if not row:
        return False
    head = conn.execute("SELECT git_commit FROM document_branch_revisions WHERE branch_id=%s ORDER BY revision DESC LIMIT 1",
                        (row["id"],)).fetchone()["git_commit"]
    archived, live = archive_ref(row["document_id"], row["branch"], row["id"]), live_ref(row["document_id"], row["branch"])
    current = resolve(archived)
    if current is None:
        history.git("update-ref", archived, head, history.ZERO)
    elif current != head:
        raise RuntimeError("An archived branch ref was changed outside the history service; export stopped.")
    if resolve(live) == head:
        history.git("update-ref", "-d", live, head)
    conn.execute("UPDATE document_branches SET ref_archived=true WHERE id=%s", (row["id"],))
    return True


def export_next(conn, before_event, workspace):
    """Export one of the workspace's pending branch steps that precedes main event `before_event` (None: no main
    event pending).

    Called by history.synchronize() while it holds the export lock. Returns True if work was done.
    """
    if archive_deleted(conn, workspace):
        return True
    row = conn.execute("""SELECT r.*, b.branch FROM document_branch_revisions r JOIN document_branches b ON b.id=r.branch_id
        WHERE r.git_commit IS NULL AND r.workspace_id=%(workspace)s AND (%(before)s::bigint IS NULL OR r.event_id < %(before)s)
        ORDER BY r.event_id LIMIT 1 FOR UPDATE OF r""", {"before": before_event, "workspace": workspace}).fetchone()
    if not row:
        return False
    parents = [parent_commit(conn, row["document_id"], parent) for parent in row["parents"]]
    main_parents = [commit for parent, commit in zip(row["parents"], parents) if parent.get("branch_id") is None]
    # Other documents' files come from main at the fork/sync point; a plain edit builds on the branch.
    base = main_parents[-1] if main_parents else parents[0]
    message = f"Branch {row['branch']} checkpoint {row['event_id']}: {row['document_id']} revision {row['revision']}\n"
    main_revisions = [parent["revision"] for parent in row["parents"] if parent.get("branch_id") is None]
    if row["change"] == "branch":
        message += f"\nBranched from main revision {main_revisions[0]}\n"
    elif row["change"] == "sync":
        message += f"\nMerge main revision {main_revisions[-1]} into {row['branch']}\n"
    commit = write_commit(row["document_id"], row["snapshot"], row["revision"], base, parents, message, row["recorded_at"], row["branch"])
    ref = live_ref(row["document_id"], row["branch"])
    expected = parents[0] if row["revision"] > 1 else None
    head = resolve(ref)
    if head == expected:
        history.git("update-ref", ref, commit, expected or history.ZERO)
    elif head != commit:
        raise RuntimeError("A branch ref was changed outside the history service; automatic history export stopped without overwriting it.")
    conn.execute("UPDATE document_branch_revisions SET git_commit=%s WHERE event_id=%s", (commit, row["event_id"]))
    return True


def merge_parent(conn, row):
    """Second parent for a main journal row produced by a branch merge, else None."""
    merge = conn.execute("""SELECT m.branch_revision, b.branch, r.git_commit FROM document_merges m
        JOIN document_branches b ON b.id=m.branch_id
        LEFT JOIN document_branch_revisions r ON r.branch_id=m.branch_id AND r.revision=m.branch_revision
        WHERE m.document_id=%s AND m.revision=%s""", (row["document_id"], row["revision"])).fetchone()
    if not merge:
        return None
    if not merge["git_commit"]:
        raise RuntimeError("Main merge export is waiting for its branch revision's Git commit.")
    return {"branch": merge["branch"], "branch_revision": merge["branch_revision"], "commit": merge["git_commit"]}
