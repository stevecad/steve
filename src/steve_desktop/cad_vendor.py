"""Studio's McMaster identity/provenance rules (see UPSTREAM.txt)."""
import re
import time
from pathlib import Path
PART_NUMBER_RE = re.compile(r"^[0-9]{2,6}[A-Za-z][0-9A-Za-z]{1,8}$")
FILENAME_PN_RE = re.compile(r"([0-9]{2,6}[A-Za-z][0-9A-Za-z]{1,8})")
_CAD_VARIANT_PREFIX = re.compile(r"^(3-?D\s*STEP|3D|STEP|NO THREADS|NO-THREADS|NOTHREADS|SIMPLIFIED)\s+", re.IGNORECASE)

def normalize_part_number(raw: str) -> str:
    """A part number as McMaster writes it, from a number, a pasted product URL or spaced text."""
    token = (raw or "").strip()
    if "mcmaster.com" in token.lower():
        token = token.split("?", 1)[0].split("#", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    return token.strip().upper().replace(" ", "").strip("/")

def product_url(part_number: str) -> str:
    return f"https://www.mcmaster.com/{part_number}"

def part_number_from_filename(name: str) -> str:
    match = FILENAME_PN_RE.search(Path(name).stem.upper().replace(" ", ""))
    return match.group(1) if match and PART_NUMBER_RE.match(match.group(1)) else ""

def catalog_description(part_number: str, filename: str) -> str:
    """The catalog title from a McMaster file name, without the part number or CAD-variant prefixes."""
    stem = re.sub(r"[_\s]+", " ", Path(filename).stem).strip()
    title = _CAD_VARIANT_PREFIX.sub("", stem).strip()
    if part_number:
        title = re.compile(re.escape(part_number) + r"[\s\-]*", re.IGNORECASE).sub("", title, count=1).strip(" -")
    title = re.sub(r"\s+", " ", _CAD_VARIANT_PREFIX.sub("", title)).strip()
    if not title or (part_number and title.upper() == part_number.upper()):
        return "McMaster-Carr catalog part"
    return title[:120]

def provenance(part_number: str, title: str, sha256: str, used: str | None = None) -> str:
    """The comment kept above a McMaster part's import in the source."""
    when = used or time.strftime("%Y-%m-%d")
    return f"# McMaster-Carr {part_number} · {product_url(part_number)} · {title} · downloaded by the user {when} · sha256 {sha256}"
