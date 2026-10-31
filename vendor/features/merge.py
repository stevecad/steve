"""Deterministic three-way merge of document source and part references.

Pure functions; nothing is executed. The line merge follows the classic diff3/merge3
algorithm: regions where base, main ("ours"), and branch ("theirs") all agree are kept,
a region changed on one side only takes that side, identical changes are accepted once,
and different changes to the same (or directly adjacent) base lines are conflicts.
"""
from difflib import SequenceMatcher
import re

# Standard diff3 markers at the start of a line. A bare "=======" separator is also
# rejected because it is never valid Python on its own.
CONFLICT_MARKERS = re.compile(r"^(?:<{7}|\|{7}|>{7})(?:[ \t].*)?\r?$|^={7}[ \t]*\r?$", re.M)


def has_conflict_markers(code):
    return bool(CONFLICT_MARKERS.search(code))


def split_lines(text):
    """Split on LF only (keeping it); CR and form feeds stay inside their line."""
    parts = text.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def _sync_regions(base, ours, theirs):
    """Yield (base_start, base_end, ours_start, ours_end, theirs_start, theirs_end) where all agree."""
    ours_blocks = SequenceMatcher(None, base, ours, autojunk=False).get_matching_blocks()
    theirs_blocks = SequenceMatcher(None, base, theirs, autojunk=False).get_matching_blocks()
    i = j = 0
    regions = []
    while i < len(ours_blocks) and j < len(theirs_blocks):
        a_base, a_match, a_len = ours_blocks[i]
        b_base, b_match, b_len = theirs_blocks[j]
        start, end = max(a_base, b_base), min(a_base + a_len, b_base + b_len)
        if start < end:
            a_start = a_match + start - a_base
            b_start = b_match + start - b_base
            regions.append((start, end, a_start, a_start + end - start, b_start, b_start + end - start))
        if a_base + a_len < b_base + b_len:
            i += 1
        else:
            j += 1
    regions.append((len(base), len(base), len(ours), len(ours), len(theirs), len(theirs)))
    return regions


def _merge_regions(base, ours, theirs):
    z = a = b = 0
    for z_match, z_end, a_match, a_end, b_match, b_end in _sync_regions(base, ours, theirs):
        if a_match - a or b_match - b:
            a_lines, b_lines, z_lines = ours[a:a_match], theirs[b:b_match], base[z:z_match]
            if a_lines == b_lines:
                yield "ours", a_lines
            elif a_lines == z_lines:
                yield "theirs", b_lines
            elif b_lines == z_lines:
                yield "ours", a_lines
            else:
                yield "conflict", (z_lines, a_lines, b_lines)
        a, b, z = a_match, b_match, z_match
        if z_end > z_match:
            yield "unchanged", base[z_match:z_end]
            z, a, b = z_end, a_end, b_end


def _terminated(lines):
    if lines and not lines[-1].endswith("\n"):
        return [*lines[:-1], lines[-1] + "\n"]
    return list(lines)


def merge_text(base, ours, theirs, ours_label="main", theirs_label="branch", base_label="base"):
    """Return {code, conflicts}. Conflicts are marked in diff3 style inside `code`.

    Each conflict reports 1-based inclusive `start_line`/`end_line` of its marker block
    (the `<<<<<<<` and `>>>>>>>` lines) within the returned code, plus the conflicting
    base/ours/theirs text blocks.
    """
    out, conflicts = [], []
    for kind, value in _merge_regions(split_lines(base), split_lines(ours), split_lines(theirs)):
        if kind != "conflict":
            out.extend(value)
            continue
        z_lines, a_lines, b_lines = value
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
        start = len(out) + 1
        out.append(f"<<<<<<< {ours_label}\n")
        out.extend(_terminated(a_lines))
        out.append(f"||||||| {base_label}\n")
        out.extend(_terminated(z_lines))
        out.append("=======\n")
        out.extend(_terminated(b_lines))
        out.append(f">>>>>>> {theirs_label}\n")
        conflicts.append({"index": len(conflicts), "kind": "code", "start_line": start, "end_line": len(out),
                          "base": "".join(z_lines), "ours": "".join(a_lines), "theirs": "".join(b_lines),
                          "message": f"Main and {theirs_label} changed the same source lines differently."})
    return {"code": "".join(out), "conflicts": conflicts}


def merge_map(base, ours, theirs):
    """Three-way merge of alias -> ID maps. Returns (merged, conflicts).

    Aliases added on either side are kept (union). A removal or change made on only one
    side applies. The same alias changed to different IDs (or changed on one side and
    removed on the other) is a conflict; the merged map then keeps main's value.
    """
    merged, conflicts = {}, []
    for key in [*ours, *(k for k in theirs if k not in ours), *(k for k in base if k not in ours and k not in theirs)]:
        b, o, t = base.get(key), ours.get(key), theirs.get(key)
        if o == t or t == b:
            value = o
        elif o == b:
            value = t
        else:
            value = o
            conflicts.append({"alias": key, "base": b, "ours": o, "theirs": t})
        if value is not None:
            merged[key] = value
    return merged, conflicts


def merge_value(base, ours, theirs):
    """Scalar three-way merge where a disagreement keeps main's value."""
    return theirs if ours == base else ours
