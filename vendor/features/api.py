"""Source-authoritative feature inspection, validated edits, and local revisions."""
import asyncio
import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, Query
from pydantic import BaseModel, Field, StrictFloat, StrictInt, model_validator

from app.main import get_document, get_build, create_build, update_document, BuildRequest, DocumentUpdate
from ..config import BUILD_WAIT
from .bindings import captured_edit, verify_captured
from .model import analyze, edit_source, FeatureError, source_hash
from . import history

router = APIRouter()
CAPTURED = "steve.features/0.2"
FAILURES = {"generation_failed": "Candidate geometry failed; the document was not changed.",
            "geometry_failure": "CadQuery could not build the edited value; the document was not changed."}


class ParameterChange(BaseModel):
    """Either {feature_id, parameter, value} or {design_parameter, value}."""
    feature_id: str | None = Field(default=None, max_length=100)
    parameter: str | None = Field(default=None, max_length=100)
    design_parameter: str | None = Field(default=None, max_length=100)
    value: StrictInt | StrictFloat

    @model_validator(mode="after")
    def one_target(self):
        targets = (self.feature_id is not None, self.parameter is not None)
        if targets != ((False, False) if self.design_parameter is not None else (True, True)):
            raise ValueError("Send either feature_id and parameter, or design_parameter.")
        return self


class FeatureEdit(BaseModel):
    revision: int = Field(ge=1)
    changes: Annotated[list[ParameterChange], Field(min_length=1, max_length=8)]


def current_tree(document):
    if document["kind"] != "part":
        raise HTTPException(422, {"code": "not_a_part", "message": "Feature editing applies to part documents; a design edits each component in its own file."})
    plan = analyze(document["code"])
    tree = plan.public()
    if document["preview_build_id"]:
        build = get_build(UUID(document["preview_build_id"]))
        recorded = (build.get("metadata") or {}).get("feature_tree")
        if build["kind"] == "part" and build["status"] == "succeeded" and build["code"] == document["code"] and recorded and recorded.get("source_sha256") == tree["source_sha256"]:
            if plan.status == "supported" and recorded.get("schema_version") == tree["schema_version"] and recorded.get("status") == "supported":
                tree = recorded
            elif recorded.get("schema_version") == CAPTURED and recorded.get("status") in {"captured", "partial"}:
                # Editability was decided at capture from source bindings and verification.
                tree = {**recorded, "editable": bool(recorded.get("editable"))}
    if not tree["execution_verified"]:
        tree["editable"] = False
        if tree["status"] == "supported":
            tree["diagnostics"] = [*tree["diagnostics"], {"code": "generation_required", "message": "Generate this source revision to verify its features before editing.", "source": None}]
    return {"document_id": document["id"], "revision": document["revision"], **tree}


@router.get("/v1/documents/{document_id}/features")
def get_features(document_id: UUID):
    return current_tree(get_document(document_id))


@router.post("/v1/documents/{document_id}/features/edit")
async def edit_features(document_id: UUID, body: FeatureEdit):
    document = await asyncio.to_thread(get_document, document_id)
    if document["revision"] != body.revision:
        raise HTTPException(409, {"code": "stale_revision", "message": "Read the current document and feature tree before editing."})
    tree = await asyncio.to_thread(current_tree, document)
    changes = [change.model_dump(exclude_none=True) for change in body.changes]
    if tree["schema_version"] == CAPTURED:
        return await edit_captured(document_id, document, tree, body.revision, changes)
    if tree["status"] != "supported":
        raise HTTPException(422, tree["diagnostics"][0])
    if not tree["execution_verified"]:
        raise HTTPException(409, {"code": "generation_required", "message": "Generate the current source before editing its feature tree."})
    try:
        candidate = edit_source(document["code"], changes)
    except FeatureError as exc:
        raise HTTPException(422, exc.diagnostic()) from None
    build = await generate_candidate(document, candidate)
    recorded = build["metadata"].get("feature_tree", {})
    if not recorded.get("execution_verified") or recorded.get("source_sha256") != source_hash(candidate):
        raise HTTPException(422, {"code": "unverified_history", "message": "Candidate geometry has no verified feature history; the document was not changed."})
    # Existing compare-and-swap rejects a concurrent human/AI write during execution.
    updated = await asyncio.to_thread(update_document, document_id, DocumentUpdate(
        name=document["name"], kind="part", code=candidate, preview_build_id=build["id"], revision=body.revision))
    return {"document": updated, "features": await asyncio.to_thread(current_tree, updated), "model": build}


async def edit_captured(document_id, document, tree, revision, changes):
    """Source round-trip edit of a captured history: rewrite bound literals, regenerate, verify, save."""
    if not tree["execution_verified"] or not tree["editable"]:
        # Unverified replays and older builds without source bindings stay read-only.
        raise HTTPException(422, {"code": "read_only_capture", "message": "This captured history has no verified source-bound values to edit. Regenerate the model, or edit the source.", "source": None})
    try:
        candidate, expected = captured_edit(document["code"], tree, changes)
    except FeatureError as exc:
        raise HTTPException(422, exc.diagnostic()) from None
    build = await generate_candidate(document, candidate, "geometry_failure")
    recorded = build["metadata"].get("feature_tree") or {}
    if recorded.get("source_sha256") != source_hash(candidate):
        raise HTTPException(422, {"code": "unverified_history", "message": "Candidate geometry has no verified feature history; the document was not changed."})
    problem = verify_captured(tree, recorded, expected)
    if problem:
        raise HTTPException(422, {**problem, "build_id": build["id"]})
    # Existing compare-and-swap rejects a concurrent human/AI write during execution.
    updated = await asyncio.to_thread(update_document, document_id, DocumentUpdate(
        name=document["name"], kind="part", code=candidate, preview_build_id=build["id"], revision=revision))
    return {"document": updated, "features": await asyncio.to_thread(current_tree, updated), "model": build}


async def build_code(document, code):
    """Builds `code` with the document's files and links; returns the build once it finished, or still running after BUILD_WAIT."""
    request = BuildRequest(kind=document.get("kind", "part"), name=document["name"], code=code,
                           files=document.get("files") or {}, links=document.get("links") or {})
    # The same candidate is never computed twice: an identical build that succeeded is reused, one in flight joined, and
    # one that used its whole budget answers with that (docs/WORK_BUDGETS.md).
    build = await asyncio.to_thread(create_build, request, Response(), None, True)
    deadline = time.monotonic() + BUILD_WAIT  # How long this waits, not how long the build may run (app/config.py).
    while time.monotonic() < deadline:
        build = await asyncio.to_thread(get_build, UUID(build["id"]))
        if build["status"] in {"succeeded", "failed"}:
            break
        await asyncio.sleep(.5)
    return build


async def generate_candidate(document, candidate, failure="generation_failed"):
    # The saved source remains intact while candidate geometry is evaluated.
    build = await build_code(document, candidate)
    if build["status"] not in {"succeeded", "failed"}:
        raise HTTPException(504, {"code": "generation_timeout", "message": "Candidate generation is still running; the document was not changed. "
                                  "It carries on: ask again to wait for the same build.", "build_id": build["id"]})
    if build["status"] == "failed":
        raise HTTPException(422, {"code": failure, "message": FAILURES[failure], "error": build["error"], "build_id": build["id"]})
    return build


@router.get("/v1/documents/{document_id}/history")
def get_history(document_id: UUID, limit: int = Query(100, ge=1, le=100), offset: int = Query(0, ge=0)):
    get_document(document_id)
    return history.list_revisions(document_id, limit, offset)


@router.get("/v1/documents/{document_id}/history/{commit_id}")
def get_historical_document(document_id: UUID, commit_id: str):
    get_document(document_id)  # Not found, or in the Trash (app/trash.py), like the document itself.
    return history.read_snapshot(document_id, commit_id)


class RestoreRequest(BaseModel):
    revision: int = Field(ge=1)
    commit_id: str = Field(pattern=r"^[0-9a-f]{40}$")
    branch: str = Field(default="main", max_length=48)


@router.post("/v1/documents/{document_id}/history/restore")
async def restore_history(document_id: UUID, body: RestoreRequest):
    """Makes any recorded revision (from any branch) the head of `branch`, as a new revision.

    A restore is about getting the code back: a revision that doesn't build today (an engine change, a linked part
    that moved on) or whose build is still running is saved all the same, without a preview, and its build is returned
    so the caller shows the error or follows it."""
    from .branches import read_document, write_document
    current = await asyncio.to_thread(read_document, document_id, body.branch)
    if current["revision"] != body.revision:
        raise HTTPException(409, {"code": "stale_revision", "message": "Read the current revision before restoring."})
    snapshot = (await asyncio.to_thread(history.read_snapshot, document_id, body.commit_id))["document"]
    if snapshot["kind"] != current["kind"]:
        raise HTTPException(422, {"code": "kind_change", "message": "A revision can only be restored onto a document of the same type."})
    model = await build_code(snapshot, snapshot["code"]) if snapshot["code"].strip() else None
    preview = model["id"] if model and model["status"] == "succeeded" else None  # Only a succeeded build is a preview.
    update = DocumentUpdate(name=snapshot["name"], kind=snapshot["kind"], code=snapshot["code"],
                            files=snapshot.get("files") or {}, links=snapshot.get("links") or {}, preview_build_id=preview, revision=body.revision)
    updated = await asyncio.to_thread(write_document, document_id, body.branch, update)
    features = await asyncio.to_thread(current_tree, updated) if body.branch == "main" and updated["kind"] == "part" else None
    return {"document": updated, "features": features, "model": model, "restored_from": body.commit_id}
