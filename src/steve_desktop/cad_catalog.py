"""Studio catalog contract, adapted from app/standard_parts.py (see UPSTREAM.txt).
Only public catalog metadata is requested; geometry is downloaded and built locally.
"""
import re
import time
from urllib.parse import urlparse
import httpx
API = "https://api.step.parts/v1"
DOWNLOAD_HOSTS = frozenset({"media.githubusercontent.com", "raw.githubusercontent.com"})
LICENSE = "MIT"
REPOSITORY = "github.com/earthtojake/step.parts"
TIMEOUT = httpx.Timeout(20.0, connect=5.0)
UNAVAILABLE = "step.parts is unavailable right now. Try again later or import a downloaded STEP file."
PAGE_MAX = 60
IMAGE_HOST = "8ljrorjug0ps5al0.public.blob.vercel-storage.com"
KEY_ATTRIBUTES = ("nominalSize", "thread", "lengthMm", "boreMm", "outerDiameterMm", "widthMm", "diameterMm", "heightMm", "pitchMm", "teeth", "module", "bearingCode", "frameSize", "voltage", "material", "headStyle", "driveStyle")
_client = None

class Unavailable(Exception):
    """The catalog couldn't be reached (after one retry) or answered with a server error."""

def client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=TIMEOUT, follow_redirects=False, headers={"User-Agent": "Steve/standard-parts"})
    return _client

def _request(method: str, url: str, **kwargs) -> httpx.Response:
    """One retry on network errors and 5xx; a 4xx is returned to the caller."""
    for attempt in range(2):
        try:
            response = client().request(method, url, **kwargs)
        except httpx.TransportError:
            if attempt:
                raise Unavailable(UNAVAILABLE) from None
            time.sleep(0.5)
            continue
        if response.status_code >= 500:
            if attempt:
                raise Unavailable(UNAVAILABLE)
            time.sleep(0.5)
            continue
        return response
    raise Unavailable(UNAVAILABLE)

def _json(path: str, params=None) -> dict:
    response = _request("GET", f"{API}{path}", params=params)
    if response.status_code == 404:
        raise LookupError(path)
    if response.status_code >= 400:
        raise Unavailable(f"step.parts refused the request ({response.status_code}).")
    try:
        return response.json()
    except ValueError:
        raise Unavailable("step.parts sent an unreadable answer.") from None

def web_url(value, host: str | None = None) -> str | None:
    """`value` when it is an absolute http(s) URL (https on `host`, when given); else None."""
    if not isinstance(value, str) or any(c.isspace() or not c.isprintable() for c in value.strip()):
        return None
    parsed = urlparse(value.strip())
    if parsed.scheme not in ({"https"} if host else {"http", "https"}) or not parsed.hostname or (host and parsed.hostname != host):
        return None
    return value.strip()

def compact(item: dict) -> dict:
    """What a person or STEVE needs to choose a part: identity, the dimensions that matter, a picture and a link."""
    attributes = item.get("attributes") or {}
    key = {name: attributes[name] for name in KEY_ATTRIBUTES if name in attributes}
    for name, value in attributes.items():  # Then any other short facts, up to eight in all.
        if len(key) >= 8:
            break
        if name not in key and isinstance(value, (str, int, float, bool)) and len(str(value)) <= 40:
            key[name] = value
    standard = item.get("standard") or {}
    return {"id": item.get("id"), "name": item.get("name"), "description": item.get("description"),
            "category": item.get("category"), "family": item.get("family"), "tags": item.get("tags") or [],
            "standard": standard.get("designation") if isinstance(standard, dict) else standard,
            "attributes": key, "thumbnail": web_url(item.get("pngUrl"), IMAGE_HOST), "page": web_url(item.get("pageUrl")),
            "size": item.get("byteSize"), "sha256": item.get("sha256"), "license": LICENSE}

def search(query: str = "", category=(), family=(), standard=(), tag=(), page: int = 1, page_size: int = 24) -> dict:
    """Catalog search: query tokens are ANDed; values within a facet group are ORed."""
    params: list[tuple[str, str | int]] = [("page", max(1, int(page))), ("pageSize", max(1, min(PAGE_MAX, int(page_size))))]
    if query.strip():
        params.append(("q", " ".join(query.split())[:200]))
    for name, values in (("category", category), ("family", family), ("standard", standard), ("tag", tag)):
        params.extend((name, value) for value in ([values] if isinstance(values, str) else values or ()) if value)
    body = _json("/parts", params)
    facets = body.get("facets") or {}
    return {"total": body.get("total", 0), "page": body.get("page", 1), "page_size": body.get("pageSize"),
            "has_next": bool(body.get("hasNextPage")), "items": [compact(item) for item in body.get("items") or []],
            "facets": {"categories": facets.get("categories") or [], "families": facets.get("families") or [],
                       "standards": facets.get("standards") or [], "tags": facets.get("tags") or []},
            "catalog": {"parts": (body.get("catalog") or {}).get("partCount"), "sha256": (body.get("catalog") or {}).get("sha256")}}

def part(part_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", part_id or ""):
        raise LookupError(part_id)
    return _json(f"/parts/{part_id}")

def provenance(item: dict) -> str:
    """The comment kept above a standard part's import in the source: one line, whatever the catalog's answer holds."""
    text = f"Standard part {item.get('id')} from step.parts ({LICENSE}, {REPOSITORY}): {web_url(item.get('pageUrl')) or 'no page'} · sha256 {item.get('sha256')}"
    return "# " + " ".join("".join(c if c.isprintable() else " " for c in text).split())
