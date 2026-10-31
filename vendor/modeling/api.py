"""HTTP access to the modeling parser, for unsaved drafts in the browser."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import MAX_SOURCE
from .parse import parse
from .rename import RenameError, rename_parameter

router = APIRouter(prefix="/v1/modeling")


class ParseRequest(BaseModel):
    # main.py or any other file of a design: one file may be as large as a whole document's source.
    code: str = Field(max_length=MAX_SOURCE)
    # A design's component file: the shared parameter values it can import from params.py.
    imported: dict[str, float] | None = Field(default=None, max_length=500)


class RenameParameterRequest(BaseModel):
    code: str = Field(max_length=MAX_SOURCE)
    old: str = Field(max_length=200)
    new: str = Field(max_length=200)


@router.post("/parse")
def parse_code(body: ParseRequest):
    """Parameters, features and sketches (with UTF-16 spans) of modeling code. Nothing runs."""
    return parse(body.code, body.imported)


@router.post("/rename-parameter")
def rename_parameter_code(body: RenameParameterRequest):
    """The code with a top-level parameter renamed wherever it is used (scope-aware). Nothing runs.
    422 with a message when the new name isn't usable or the rename can't be done safely."""
    try:
        return {"code": rename_parameter(body.code, body.old, body.new)}
    except RenameError as error:
        raise HTTPException(422, str(error)) from None


@router.post("/rename-plane")
def rename_plane_code(body: RenameParameterRequest):
    """Rename a construction plane and its scope-resolved references without executing code."""
    try:
        return {"code": rename_parameter(body.code, body.old, body.new, construction_plane=True)}
    except RenameError as error:
        raise HTTPException(422, str(error)) from None
