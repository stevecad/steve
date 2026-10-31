"""Studio drawing PDF merger, from pinned Steve Studio app/product_drawings.py.

Only the CAD PDF object merger is reused; storage and routes are local.
See UPSTREAM.txt and THIRD-PARTY-LICENSES for provenance.
"""
import re

OBJECT = re.compile(rb"(\d+) 0 obj\n")
REFERENCE = re.compile(rb"(\d+) 0 R")


def _objects(data: bytes) -> dict[int, tuple[bytes, bytes]]:
    """Each object: (its dictionary text, its stream's bytes or b"")."""
    out, at = {}, data.index(b"\n") + 1
    at = data.index(b"\n", at) + 1 if data[at:at + 1] == b"%" else at
    while found := OBJECT.match(data, at):
        number, at = int(found.group(1)), found.end()
        end, stream = data.find(b"\nendobj\n", at), data.find(b"\nstream\n", at)
        if 0 <= stream < end:
            head = data[at:stream]
            length = int(re.search(rb"/Length (\d+)", head).group(1))
            body_start = stream + len(b"\nstream\n")
            out[number] = (head, data[body_start:body_start + length])
            at = body_start + length + len(b"\nendstream\nendobj\n")
        else:
            out[number] = (data[at:end], b"")
            at = end + len(b"\nendobj\n")
    return out


def _root(data: bytes) -> int:
    return int(re.search(rb"/Root (\d+) 0 R", data[data.rindex(b"trailer"):]).group(1))


def merge(pdfs: list[bytes], title: str = "") -> bytes:
    """One PDF of every page of `pdfs`, in order: each file's objects renumbered after the last's, its pages hung under
    one page tree, its own catalog, page tree and information dropped."""
    out: list[bytes] = []   # object bodies, numbered from 1
    kids: list[int] = []
    tree = 1   # the new page tree is object 1
    out.append(b"")   # its place
    for data in pdfs:
        objects = _objects(data)
        catalog = objects[_root(data)][0]
        pages = int(re.search(rb"/Pages (\d+) 0 R", catalog).group(1))
        info = re.search(rb"/Info (\d+) 0 R", data[data.rindex(b"trailer"):])
        dropped = {_root(data), pages, int(info.group(1)) if info else -1}
        kept =[number for number in sorted(objects) if number not in dropped]
        renumber = {number: len(out) + 1 + index for index, number in enumerate(kept)}
        renumber[pages] = tree
        page_order = [int(n) for n in re.findall(rb"(\d+) 0 R", re.search(rb"/Kids \[([^\]]*)\]", objects[pages][0]).group(1))]
        for number in kept:
            head, stream = objects[number]
            head = REFERENCE.sub(lambda m: b"%d 0 R" % renumber[int(m.group(1))], head)
            out.append(head + (b"\nstream\n" + stream + b"\nendstream" if stream or b"/Length" in head else b""))
        kids += [renumber[number] for number in page_order]
    out[0] = b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % kid for kid in kids) + b"] /Count %d >>" % len(kids)
    out.append(b"<< /Type /Catalog /Pages %d 0 R >>" % tree)
    root = len(out)
    info = "<< /Producer <FEFF" + "STEVE".encode("utf-16-be").hex().upper() + ">" + (
        " /Title <FEFF" + title[:200].encode("utf-16-be").hex().upper() + ">" if title else "") + " >>"
    out.append(info.encode())
    data = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(out, 1):
        offsets.append(len(data))
        data += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    start = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(out) + 1) + b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    data += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(out) + 1, root, len(out), start)
    return bytes(data)


