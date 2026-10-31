"""Observed CadQuery history, NOT a general Python-to-editable-CAD compiler.

Runs only in the disposable CAD sandbox. CPython profiling observes calls from the
submitted source, so loops/functions/formulas execute normally, without AST rewriting.
The graph describes the executed path. Arguments written as numeric literals or as
numeric top-level variables assigned once are bound to their source spans (bindings.py);
edits rewrite that text and are verified by regeneration. Everything else is read-only.
"""
import ast
from collections import Counter
import inspect
import math
import sys

import cadquery as cq

from .bindings import SourceIndex, code_signature, limits_for, merge_limits, numeric
from .model import location, source_hash
from .trace import metrics

SCHEMA = "steve.features/0.2"
SOURCE_FILE = "/work/model.py"
MAX_EVENTS = 128
MAX_TREE_BYTES = 56000  # Worker result.json has a 64 KiB limit; fail explicitly, never truncate silently.
CATEGORIES = {
    **dict.fromkeys("box sphere cylinder cone wedge extrude twistExtrude revolve loft sweep cutBlind cutThruAll hole cboreHole cskHole fillet chamfer shell union cut intersect combine split".split(), "solid"),
    **dict.fromkeys("rect circle ellipse polygon polyline line lineTo hLine vLine move moveTo center spline bezier threePointArc radiusArc sagittaArc close wire slot2D".split(), "sketch"),
    **dict.fromkeys("Workplane workplane faces edges vertices wires solids shells objects pushPoints rarray polarArray tag workplaneFromTagged end findSolid val vals".split(), "reference"),
    **dict.fromkeys("translate rotate rotateAboutCenter mirror mirrorX mirrorY transformed".split(), "transform"),
}
OPERATORS = {"__add__": "union", "__or__": "union", "__sub__": "cut", "__and__": "intersect"}
LABELS = {'Workplane': 'Origin plane', 'workplane': 'Workplane', 'rect': 'Rectangle',
          'polyline': 'Polyline', 'close': 'Close profile', 'circle': 'Circle',
          'extrude': 'Extrude', 'revolve': 'Revolve', 'fillet': 'Fillet', 'chamfer': 'Chamfer',
          'union': 'Union', 'cut': 'Subtract', 'cutBlind': 'Pocket', 'hole': 'Hole',
          'cboreHole': 'Counterbored holes', 'pushPoints': 'Point pattern',
          'faces': 'Face selection', 'edges': 'Edge selection', 'rotate': 'Rotate'}
# Gaps that make occurrence/reference counts or call-site mapping untrustworthy for edits.
BLOCKING = {'capture_limit', 'metadata_limit', 'recorder_error', 'unresolved_source', 'dynamic_code', 'untracked_result', 'unverified_replay'}
READ_ONLY = {"code": "read_only_capture", "message": "Executed operations are recorded; these additional operations do not yet support graphical parameter edits.", "source": None}
SOURCE_EDITS = {"code": "source_bound_edits", "message": "Numeric literals and numeric top-level variables used once can be edited; each edit rewrites that source text and is verified by regeneration. Other values are read-only.", "source": None}


class Recorder:
    def __init__(self, source):
        self.source = source
        self.events, self.pending, self.producers, self.keepalive = [], {}, {}, []
        self.occurrences = Counter()
        self.operation_counts = Counter()
        self.diagnostics = [dict(READ_ONLY)]
        self.gaps = set()
        self.previous_profile = None
        self.tree = ast.parse(source)
        calls = sorted((n for n in ast.walk(self.tree) if isinstance(n, (ast.Call, ast.BinOp))),
                       key=lambda n: (n.lineno, n.col_offset, n.end_lineno, n.end_col_offset))
        self.sites = {(n.lineno, n.end_lineno, n.col_offset, n.end_col_offset): (i + 1, n) for i, n in enumerate(calls)}
        self.index = SourceIndex(source, self.tree)
        self.used_by = {}
        # This is a conservative warning, not a sandbox or a proof of completeness.
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split('.')[0] not in {'cadquery', 'math'}:
                        self.gap('external_code', 'Imported external code can perform geometry operations outside the observed source.')
            elif isinstance(node, ast.ImportFrom) and (node.module or '').split('.')[0] not in {'cadquery', 'math'}:
                self.gap('external_code', 'Imported external code can perform geometry operations outside the observed source.')
            elif isinstance(node, ast.Attribute) and (node.attr == 'wrapped' or node.attr.startswith('_')):
                self.gap('low_level_access', 'Direct kernel/private access cannot be reconstructed as a semantic feature.')
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {'exec', 'eval', 'getattr', 'setattr', '__import__'}:
                self.gap('dynamic_code', 'Dynamic dispatch or generated code may bypass observed call sites.')

    def gap(self, code, message):
        if code not in self.gaps:
            self.gaps.add(code)
            self.diagnostics.append({'code': code, 'message': message, 'source': None})

    def __enter__(self):
        self.previous_profile = sys.getprofile()
        sys.setprofile(self.profile)
        return self

    def __exit__(self, *_):
        sys.setprofile(self.previous_profile)

    def refs(self, value, depth=0):
        if depth > 4:
            return []
        producer = self.producers.get(id(value))
        if producer:
            return [producer]
        if isinstance(value, (list, tuple)):
            return [ref for item in value[:128] for ref in self.refs(item, depth + 1)]
        if isinstance(value, dict):
            return [ref for item in list(value.values())[:128] for ref in self.refs(item, depth + 1)]
        return []

    def serialize(self, value, depth=0):
        if value is None or isinstance(value, (str, bool, int)):
            return value[:256] if isinstance(value, str) else value
        if isinstance(value, float):
            return value if math.isfinite(value) else str(value)
        refs = self.refs(value)
        if isinstance(value, (cq.Workplane, cq.Shape, cq.Sketch)):
            return {'type': type(value).__name__, 'feature_refs': refs}
        if isinstance(value, cq.Vector):
            return list(value.toTuple())
        if depth < 3 and isinstance(value, (list, tuple)) and len(value) <= 32:
            return [self.serialize(v, depth + 1) for v in value]
        if depth < 3 and isinstance(value, dict) and len(value) <= 32:
            return {str(k)[:100]: self.serialize(v, depth + 1) for k, v in value.items()}
        self.gap('opaque_parameter', 'An argument could not be represented completely as a JSON value or feature reference.')
        return {'type': type(value).__name__, 'opaque': True}

    def remember(self, value, feature_id):
        if isinstance(value, (cq.Workplane, cq.Shape, cq.Sketch)):
            self.keepalive.append(value)
            self.producers[id(value)] = feature_id
        if isinstance(value, cq.Workplane):
            for item in value.objects:
                if isinstance(item, cq.Shape):
                    self.keepalive.append(item)
                    self.producers[id(item)] = feature_id
            for item in [*value.ctx.pendingWires, *value.ctx.pendingEdges]:
                if id(item) not in self.producers:
                    self.keepalive.append(item)
                    self.producers[id(item)] = feature_id
        elif isinstance(value, (list, tuple)):
            for item in value[:128]:
                self.remember(item, feature_id)

    def profile(self, frame, event, returned):
        # A recorder bug must not silently produce a supposedly complete graph.
        try:
            if event == 'call':
                self.start(frame)
            elif event == 'return' and id(frame) in self.pending:
                self.finish(frame, returned)
        except Exception as exc:
            self.gap('recorder_error', f'Recording could not inspect an operation ({type(exc).__name__}).')

    def start(self, frame):
        caller = frame.f_back
        if caller is None or caller.f_code.co_filename != SOURCE_FILE:
            return
        method = frame.f_code.co_name
        receiver = frame.f_locals.get('self')
        native = frame.f_globals.get('__name__', '').startswith('cadquery.')
        # Capture a user-attached Workplane plugin as an opaque node with its
        # internal directly-authored operations; don't pretend to know its intent.
        plugin = (not native and isinstance(receiver, cq.Workplane)
                  and getattr(getattr(type(receiver), method, None), '__code__', None) is frame.f_code)
        if not native and not plugin:
            return
        if method.startswith('_') and method not in {'__init__', *OPERATORS}:
            self.gap('unobserved_private_call', 'An authored private/decorated CadQuery call is not classified.')
            return
        if not isinstance(receiver, (cq.Workplane, cq.Shape, cq.Sketch)):
            # Vector/Plane/Location/selector constructors are parameters, not geometry features.
            if method == '__init__' and frame.f_code.co_qualname.split('.')[0] in {'Vector', 'Plane', 'Location', 'Color'}:
                return
            self.gap('unclassified_call', f'Call {frame.f_code.co_qualname} requires a geometry adapter.')
            return
        if len(self.events) >= MAX_EVENTS:
            self.gap('capture_limit', f'Trace exceeded {MAX_EVENTS} events; the history is partial.')
            return
        operation = 'Workplane' if method == '__init__' and isinstance(receiver, cq.Workplane) else OPERATORS.get(method, method)
        position = inspect.getframeinfo(caller, context=0).positions
        key = (position.lineno, position.end_lineno, position.col_offset, position.end_col_offset)
        site, node = self.sites.get(key, (0, None))
        if not site:
            # CPython's CALL location for a multiline fluent chain can cover
            # only `.method(...)`; the AST Call includes the entire receiver.
            # Match its unique end and method name, never just its line number.
            matches = [(number, candidate) for number, candidate in self.sites.values()
                       if isinstance(candidate, ast.Call) and isinstance(candidate.func, ast.Attribute)
                       and candidate.func.attr == method
                       and (candidate.end_lineno, candidate.end_col_offset) == (position.end_lineno, position.end_col_offset)]
            if len(matches) == 1:
                site, node = matches[0]
        if not site:
            self.gap('unresolved_source', 'An executed call could not be mapped to an original source expression.')
        self.occurrences[(site, operation)] += 1
        self.operation_counts[operation] += 1
        occurrence = self.occurrences[(site, operation)]
        feature_id = f'{operation}-{site}-{occurrence}'
        names = list(frame.f_code.co_varnames[:frame.f_code.co_argcount + frame.f_code.co_kwonlyargcount])
        names = [n for n in names if n not in {'self', 'cls'}]
        arguments = {name: frame.f_locals[name] for name in names}
        dependencies = self.refs(receiver)
        if isinstance(receiver, cq.Workplane) and method != '__init__':
            dependencies += self.refs(receiver.ctx.pendingWires) + self.refs(receiver.ctx.pendingEdges)
        for value in arguments.values():
            dependencies += self.refs(value)
        expressions = {}
        if isinstance(node, ast.Call):
            expressions.update({name: ast.get_source_segment(self.source, arg) for name, arg in zip(names, node.args)})
            expressions.update({kw.arg: ast.get_source_segment(self.source, kw.value) for kw in node.keywords if kw.arg})
        parameters = {}
        for name, value in arguments.items():
            parameters[name] = {'value': self.serialize(value), 'editable': False}
            if name in expressions:
                parameters[name]['expression'] = expressions[name]
        recognized = operation in CATEGORIES and isinstance(receiver, cq.Workplane) and not plugin
        if not recognized:
            self.gap('opaque_operation', f'Operation {operation} was captured without a tested semantic adapter.')
        feature = {'id': feature_id, 'operation': operation, 'category': CATEGORIES.get(operation, 'opaque') if recognized else 'opaque',
                   'label': f'{LABELS.get(operation, operation)} {self.operation_counts[operation]}', 'recognized': recognized, 'editable': False,
                   'depends_on': list(dict.fromkeys(dependencies)),
                   'source': {'line': position.lineno, 'end_line': position.end_lineno,
                              'column_utf8': position.col_offset, 'end_column_utf8': position.end_col_offset,
                              'call_site': site, 'occurrence': occurrence},
                   'parameters': parameters, 'executed': False}
        if isinstance(node, ast.Call):
            self.bind_sources(feature, node, frame.f_code, arguments)
        self.events.append(feature)
        self.pending[id(frame)] = (feature, receiver, method)

    def bind_sources(self, feature, node, code, arguments):
        """Classify explicitly passed numeric arguments, bound to the executing function's signature."""
        explicit = self.index.arguments(node, code_signature(code))
        if explicit is None:
            return
        for name, value in arguments.items():
            parameter, argument = feature['parameters'][name], explicit.get(name)
            if not numeric(value):
                continue
            if argument is None:
                parameter['reason'] = 'Default value; add it to the source to edit it.'
                continue
            for used in self.index.mentions(argument):
                self.used_by.setdefault(used, {})[feature['id']] = None
            parameter.update(self.index.classify(argument, value))
            limits = 'binding' in parameter and limits_for(feature['operation'], name, value)
            if limits:
                parameter['limits'] = limits

    def finish_bindings(self, verified):
        """Decide edit safety once every executed occurrence is known; returns design parameters."""
        blocked = not verified or bool(self.gaps & BLOCKING)
        unavailable = 'This capture is not verified for source edits. Regenerate, or edit the source.'
        design = {name: {'name': name, 'value': value, 'source': location(node),
                         'used_by': list(self.used_by.get(name, {})), 'references': self.index.references[name],
                         'editable': not blocked, **({'reason': unavailable} if blocked else {})}
                  for name, (value, node) in self.index.parameters.items()}
        runs = Counter(feature['source']['call_site'] for feature in self.events)
        for feature in self.events:
            for parameter in feature['parameters'].values():
                binding = parameter.get('binding')
                if not binding:
                    continue
                name, count = binding.get('name'), runs[feature['source']['call_site']]
                target = f'edit the design parameter {name}' if name else 'edit the source'
                # Never let one feature-level edit silently change several consumers.
                if not feature['recognized']:
                    reason = 'No tested adapter for this operation; edit the source.'
                elif count > 1:
                    reason = f'Used by {count} repeated calls (loop or helper); {target}.'
                elif name and self.index.references[name] > 1:
                    users = len(design[name]['used_by'])
                    reason = (f'Shared by {users} features — {target}.' if users > 1
                              else f'Used {self.index.references[name]} times in the source — {target}.')
                else:
                    reason = unavailable if blocked else None
                parameter['editable'], parameter['reason'] = reason is None, reason
                if name and parameter.get('limits'):
                    design[name]['limits'] = merge_limits(design[name].get('limits'), parameter['limits'])
            feature['editable'] = any(p['editable'] for p in feature['parameters'].values())
        return list(design.values())

    def finish(self, frame, returned):
        feature, receiver, method = self.pending.pop(id(frame))
        value = receiver if method == '__init__' else returned
        if value is None:
            self.gap('incomplete_operation', 'A call returned no geometry, possibly after a caught exception.')
            feature['execution'] = {'status': 'no_result'}
            return
        feature['executed'] = True
        witness = {'result_type': type(value).__name__}
        if isinstance(value, cq.Workplane):
            witness['selected_objects'] = len(value.objects)
        # Geometry verification here verifies execution, not a semantic inverse or stable face identity.
        if feature['category'] in {'solid', 'transform'} and isinstance(value, cq.Workplane):
            try:
                witness['geometry'] = metrics(value.findSolid())
            except ValueError:
                self.gap('no_solid_witness', 'A modeling operation did not produce a measurable solid.')
        feature['execution'] = witness
        if feature['category'] == 'opaque':
            # A plugin may return geometry produced by separately observed calls
            # in its body. Preserve those dependencies, without inventing intent.
            feature['depends_on'] = list(dict.fromkeys([*feature['depends_on'], *self.refs(value)]))
        self.remember(value, feature['id'])

    def public(self, result, equivalence):
        import json
        roots = self.refs(result)
        if not roots:
            self.gap('untracked_result', 'The final result has no recorded producer.')
        if self.pending:
            self.gap('incomplete_operation', 'An operation did not finish during the observed execution.')
        verified = bool(equivalence.get('passed'))
        design = self.finish_bindings(verified)
        editable = verified and not self.gaps & BLOCKING and (any(f['editable'] for f in self.events) or any(d['editable'] for d in design))
        self.diagnostics[0] = dict(SOURCE_EDITS if editable else READ_ONLY)
        tree = {'schema_version': SCHEMA, 'source_sha256': source_hash(self.source),
                'status': 'partial' if self.gaps else 'captured', 'editable': editable,
                'execution_verified': verified,
                'root_feature_id': roots[-1] if roots else None,
                'features': self.events, 'design_parameters': design, 'diagnostics': self.diagnostics, 'equivalence': equivalence,
                'coverage': {'scope': 'Public CadQuery calls directly invoked by the submitted source on the executed path. Not a proof of universal completeness.',
                             'observed_calls': len(self.events), 'recognized_calls': sum(f['recognized'] for f in self.events),
                             'operations': dict(Counter(f['operation'] for f in self.events)),
                             'categories': dict(Counter(f['category'] for f in self.events)),
                             'control_flow': dict(Counter(type(n).__name__ for n in ast.walk(self.tree) if isinstance(n, (ast.For, ast.While, ast.If, ast.FunctionDef))))}}
        if len(json.dumps(tree).encode()) > MAX_TREE_BYTES:
            # Read-only hints are optional; bindings and graph structure are not.
            for feature in self.events:
                for parameter in feature['parameters'].values():
                    if not parameter.get('binding'):
                        parameter.pop('reason', None)
        if len(json.dumps(tree).encode()) > MAX_TREE_BYTES:
            self.gap('metadata_limit', 'Detailed trace exceeds the inline metadata budget; no truncated tree is exposed.')
            self.diagnostics[0] = dict(READ_ONLY)
            tree.update(status='partial', features=[], root_feature_id=None, design_parameters=[], editable=False)
        return tree
