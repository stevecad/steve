"""What a running build is doing, for the person waiting on it: a stage (app/kernel_protocol.py PROGRESS_STAGES), and in
a loop the item and how many of how many are done. Written to the job directory's progress.json (STEVE_PROGRESS, set by
the kernel's job child), which the kernel reads every few seconds and passes on; anywhere else a no-op. Writes at most
once a second within a stage, and never fails the build."""
from __future__ import annotations

import json
import os
import time

INTERVAL = 1.0  # s between writes within one stage; a new stage is written at once.
_current: dict = {}
_written = 0.0


def stage(name: str, item: str | None = None, of: int | None = None) -> None:
    """The build starts `name` (on `item`, of `of` steps)."""
    global _current
    _current = {"stage": name, **({"name": str(item)[:200]} if item is not None else {}), **({"done": 0, "of": int(of)} if of is not None else {})}
    _write(force=True)


def step(done: int, of: int | None = None, item: str | None = None) -> None:
    """`done` steps of the current stage are done (of `of`, now on `item`)."""
    if not _current:
        return
    _current["done"] = int(done)
    if of is not None:
        _current["of"] = int(of)
    if item is not None:
        _current["name"] = str(item)[:200]
    _write()


def _write(force: bool = False) -> None:
    global _written
    path = os.environ.get("STEVE_PROGRESS")
    if not path:
        return
    now = time.monotonic()
    if not force and now - _written < INTERVAL:
        return
    _written = now
    try:
        temporary = path + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(_current, handle)
        os.replace(temporary, path)  # The kernel never reads half a record.
    except (OSError, ValueError):
        pass
