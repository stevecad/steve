"""Renames a top-level parameter and every use of it (docs/MODELING.md section 1).

Scope-aware, with Python's `ast`: only names that resolve to the module-level parameter
change. Locals, function arguments and comprehension variables that happen to share the
name, keyword-argument names, attributes and strings are left alone.
"""
from __future__ import annotations

import ast
import builtins
import io
import keyword
import re
import tokenize

from .parse import MATH, parse

NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
RESERVED = {"model", "result", "cq", "Model", "steve"}
SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef, ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)


class RenameError(ValueError):
    """The rename can't be done safely; the message says why."""


def rename_parameter(code: str, old: str, new: str, *, construction_plane: bool = False) -> str:
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        raise RenameError(f"Fix the syntax error on line {error.lineno} first.") from None
    if construction_plane:
        definitions = [node for node in tree.body if isinstance(node, ast.Assign)
                       and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                       and node.targets[0].id == old]
        if len(definitions) != 1 or not isinstance(definitions[0].value, ast.Call) or ast.unparse(definitions[0].value.func) != 'cq.Plane':
            raise RenameError(f"{old} isn't a unique construction plane definition.")
    elif old not in {p["name"] for p in parse(code)["parameters"]}:
        raise RenameError(f"{old} isn't a parameter of this design.")
    if new == old:
        return code
    problem = _check_name(new, _identifiers(tree))
    if problem:
        raise RenameError(problem)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and old in _bindings(node.body):
            raise RenameError(f"{old} is redefined inside class {node.name} (line {node.lineno}). Rename it in Source.")
    other = _module_binding(tree.body, old)
    if other:
        raise RenameError(f"{old} is also defined by {other}. Rename it in Source.")

    starts = [0] + [m.end() for m in re.finditer(r"\r\n|\r|\n", code)]

    def index(line: int, col_utf8: int) -> int:
        start = starts[line - 1]
        end = starts[line] if line < len(starts) else len(code)
        return start + len(code[start:end].encode("utf-8")[:col_utf8].decode("utf-8", errors="ignore"))

    spans = []
    for node in _references(tree, old):
        if isinstance(node, ast.Name):
            spans.append((index(node.lineno, node.col_offset), index(node.end_lineno, node.end_col_offset)))
        else:  # `global old` inside a function: the name's tokens in that statement.
            first = index(node.lineno, node.col_offset)
            text = code[first:index(node.end_lineno, node.end_col_offset)]
            for token in tokenize.generate_tokens(io.StringIO(text).readline):
                if token.type == tokenize.NAME and token.string == old:
                    row, col = token.start
                    at = first + sum(len(line) for line in text.splitlines(keepends=True)[:row - 1]) + col
                    spans.append((at, at + len(old)))
    out = code
    for start, end in sorted(set(spans), reverse=True):
        if out[start:end] != old:
            raise RenameError(f"Couldn't locate every use of {old}. Rename it in Source.")
        out = out[:start] + new + out[end:]
    try:
        ast.parse(out)
    except SyntaxError:
        raise RenameError(f"Renaming {old} to {new} would break the code.") from None
    return out


def _check_name(new: str, taken: set[str]) -> str | None:
    if not NAME.fullmatch(new):
        return "Use letters, digits and underscores, starting with a letter."
    if keyword.iskeyword(new) or keyword.issoftkeyword(new):
        return f"{new} is a Python keyword."
    if new in RESERVED:
        return f"{new} is reserved by the modeling code."
    if new in MATH:
        return f"{new} is a math function or constant in expressions."
    if hasattr(builtins, new):
        return f"{new} is a Python built-in."
    if new in taken:
        return f"{new} already exists."
    return None


def _identifiers(tree: ast.AST) -> set[str]:
    """Every name the code binds or reads, in any scope (a new name must collide with none)."""
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            out.add(node.id)
        elif isinstance(node, ast.arg):
            out.add(node.arg)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, ast.alias):
            out.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            out.update(node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            out.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            out.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            out.add(node.rest)
    return out


def _own_nodes(body: list[ast.AST]):
    """Nodes of one scope: nested functions, classes and comprehensions are not entered."""
    stack = list(body)
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue  # Their names bind here; their bodies are other scopes.
        if isinstance(node, SCOPES):
            continue
        stack.extend(ast.iter_child_nodes(node))


def _bindings(body: list[ast.AST]) -> set[str]:
    out: set[str] = set()
    for node in _own_nodes(body):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            out.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            out.update((a.asname or a.name).split(".")[0] for a in node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            out.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            out.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            out.add(node.rest)
    return out


def _declared(body: list[ast.AST], kind: type) -> set[str]:
    return {name for node in _own_nodes(body) if isinstance(node, kind) for name in node.names}


def _module_binding(body: list[ast.stmt], old: str) -> str | None:
    """Module-level bindings of `old` that aren't plain assignments (those rename with it)."""
    for node in _own_nodes(body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == old:
            return f"a {'class' if isinstance(node, ast.ClassDef) else 'function'} on line {node.lineno}"
        if isinstance(node, (ast.Import, ast.ImportFrom)) and any((a.asname or a.name).split(".")[0] == old for a in node.names):
            return f"an import on line {node.lineno}"
        if isinstance(node, ast.ExceptHandler) and node.name == old:
            return f"an except clause on line {node.lineno}"
        if isinstance(node, (ast.MatchAs, ast.MatchStar, ast.MatchMapping)) and old in (getattr(node, "name", None), getattr(node, "rest", None)):
            return f"a match pattern on line {node.lineno}"
    return None


def _arg_names(args: ast.arguments) -> set[str]:
    every = args.posonlyargs + args.args + args.kwonlyargs + [a for a in (args.vararg, args.kwarg) if a]
    return {a.arg for a in every}


def _outer_parts(args: ast.arguments) -> list[ast.AST]:
    """Defaults and annotations run in the enclosing scope."""
    every = args.posonlyargs + args.args + args.kwonlyargs + [a for a in (args.vararg, args.kwarg) if a]
    return [*args.defaults, *(d for d in args.kw_defaults if d), *(a.annotation for a in every if a.annotation)]


def _references(tree: ast.Module, old: str) -> list[ast.AST]:
    """Name nodes (and `global` statements) that refer to the module-level `old`."""
    hits: list[ast.AST] = []

    def function_shadows(body: list[ast.AST], args: set[str], outer: bool) -> bool:
        if old in _declared(body, ast.Global):
            return False
        if old in _declared(body, ast.Nonlocal):
            return outer
        return old in args or old in _bindings(body) or outer

    def walk(node: ast.AST, shadowed: bool):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for part in [*node.decorator_list, *_outer_parts(node.args), *([node.returns] if node.returns else [])]:
                walk(part, shadowed)
            inner = function_shadows(node.body, _arg_names(node.args), shadowed)
            for stmt in node.body:
                walk(stmt, inner)
            return
        if isinstance(node, ast.Lambda):
            for part in _outer_parts(node.args):
                walk(part, shadowed)
            walk(node.body, shadowed or old in _arg_names(node.args))
            return
        if isinstance(node, ast.ClassDef):
            for part in [*node.decorator_list, *node.bases, *(k.value for k in node.keywords)]:
                walk(part, shadowed)
            for stmt in node.body:
                walk(stmt, shadowed)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            generators = node.generators
            walk(generators[0].iter, shadowed)
            targets = {n.id for g in generators for n in ast.walk(g.target) if isinstance(n, ast.Name)}
            inner = shadowed or old in targets
            for i, generator in enumerate(generators):
                walk(generator.target, inner)
                if i:
                    walk(generator.iter, inner)
                for condition in generator.ifs:
                    walk(condition, inner)
            for part in ((node.key, node.value) if isinstance(node, ast.DictComp) else (node.elt,)):
                walk(part, inner)
            return
        if isinstance(node, ast.Name):
            if node.id == old and not shadowed:
                hits.append(node)
            return
        if isinstance(node, ast.Global) and old in node.names:
            hits.append(node)
            return
        for child in ast.iter_child_nodes(node):
            walk(child, shadowed)

    walk(tree, False)
    return hits
