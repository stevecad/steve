"""Tables of values kept in a design as .csv files (holes.csv beside main.py), read with `steve.table`.

    from steve import Design, table
    design.pattern(hole, points=table("holes.csv"))

The delimiter (comma, semicolon or tab) is detected with csv.Sniffer; a first row with any cell that isn't a number is
the header. Cells that are numbers come back as floats (a semicolon or tab file may write 2,5 for 2.5), the rest as
text, empty ones as None. Errors name the file, row and column, never a cell's value: a table is the person's data.

Deliberately narrow: stdlib csv only; a cell is a number or text and is never evaluated, imported,
executed or used as a path; no formulas, macros, URLs or remote tables. Widening any of that (xlsx included) is a
person's decision, never part of another change.
"""
from __future__ import annotations

import csv
import io
import re
import sys
from pathlib import Path

NAME = re.compile(r"[a-z][a-z0-9_]{0,63}\.csv")
_PACKAGE = Path(__file__).resolve().parent


class TableError(ValueError):
    pass


class Table(list):
    """The rows of a table (tuples, header row left out), with `columns` (the header's names, or None) and `path`."""

    def __init__(self, rows, columns, path, lines):
        super().__init__(rows)
        self.columns = columns
        self.path = path
        self.lines = lines   # each row's line in the file (1-based), for errors

    def where(self, index: int) -> str:
        """Where row `index` is in the file, for an error: "holes.csv row 4"."""
        return f"{self.path} row {self.lines[index]}" if 0 <= index < len(self.lines) else f"{self.path}"

    def dicts(self) -> list[dict]:
        """The rows as {column: value}; needs a header row."""
        if not self.columns:
            raise TableError(f"{self.path} has no header row: name its columns in the first row (like x,y) to read rows by name.")
        return [dict(zip(self.columns, row)) for row in self]


def _root() -> Path:
    """The folder of the document whose code is calling: the job's own, or a linked document's (.linked/<alias>/v<n>/)."""
    root = Path.cwd().resolve()
    frame = sys._getframe(2)
    while frame is not None:
        path = Path(frame.f_code.co_filename)
        if path.is_absolute():
            path = path.resolve()
            if _PACKAGE not in path.parents and root in path.parents:
                parts = path.relative_to(root).parts
                nested = [i for i, part in enumerate(parts) if part == ".linked"]
                if nested and len(parts) > nested[-1] + 3:
                    return root.joinpath(*parts[:nested[-1] + 3])
                return root
        frame = frame.f_back
    return root


def _number(cell: str, decimal_comma: bool):
    text = cell.strip()
    if decimal_comma and text.count(",") == 1 and "." not in text:
        text = text.replace(",", ".")
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value == value and abs(value) != float("inf") else None


def table(path: str, columns=None) -> Table:
    """The rows of the design's table `path` (a .csv file beside main.py, like holes.csv) as tuples. `columns=("x",
    "y")` picks those columns by their header names, in that order."""
    if not isinstance(path, str) or not NAME.fullmatch(path):
        raise TableError(f"steve.table takes the name of one of the design's .csv files, like \"holes.csv\": lowercase letters, "
                         "digits and underscores ending in .csv, beside main.py.")
    file = _root() / path
    if not file.is_file():
        raise TableError(f"This design has no {path}. Add it in the Source panel: file switcher → Import table….")
    text = file.read_text(encoding="utf-8-sig", errors="replace")
    sample = "\n".join([line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")][:50])
    if not sample:
        raise TableError(f"{path} is empty.")
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t").delimiter
    except csv.Error:
        delimiter = ","   # One column, or nothing the sniffer could tell apart.
    decimal_comma = delimiter != ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    try:
        # Blank rows and comment rows (# …) are left out; each row keeps the line it starts on.
        raw, start = [], 1
        for cells in reader:
            if any(cell.strip() for cell in cells) and not cells[0].lstrip().startswith("#"):
                raw.append((start, cells))
            start = reader.line_num + 1
    except csv.Error:
        raise TableError(f"{path} row {reader.line_num} can't be read as a table row (an unclosed quote?).") from None
    if not raw:
        raise TableError(f"{path} is empty.")
    header = None
    if any(_number(cell, decimal_comma) is None and cell.strip() for cell in raw[0][1]):
        header = [cell.strip() for cell in raw[0][1]]
        raw = raw[1:]
    rows, numbers = [], []
    for number, cells in raw:
        rows.append(tuple(None if not cell.strip() else value if (value := _number(cell, decimal_comma)) is not None else cell.strip()
                          for cell in cells))
        numbers.append(number)
    result = Table(rows, header, path, numbers)
    if columns is None:
        return result
    if isinstance(columns, str):
        columns = [columns]
    if not header:
        raise TableError(f"{path} has no header row to pick columns from: name its columns in the first row (like x,y), or leave "
                         "out columns=.")
    indices = []
    for name in columns:
        if name not in header:
            raise TableError(f"{path} has no column {name!r} in its header row ({len(header)} columns).")
        indices.append(header.index(name))
    picked = []
    for row, number in zip(rows, numbers):
        if any(i >= len(row) for i in indices):
            missing = next(header[i] for i in indices if i >= len(row))
            raise TableError(f"{path} row {number} has no value in column {missing!r}.")
        picked.append(tuple(row[i] for i in indices))
    return Table(picked, [header[i] for i in indices], path, numbers)
