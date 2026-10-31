import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import {
  CONSTRAINT_KINDS, PLANE_NAMES, cadqueryClass, guessMember, memberOf, selectorDoc, type MemberDoc,
} from './cadqueryDocs';
import { displayType, resolverFor } from './cadqueryResolve';
import { renderMemberDoc, renderSignature, renderValueDoc, renderValueHint } from './docRender';
import {
  PY_KEYWORDS, callSiteBefore, chainBefore, isOp, lastTokenBefore, skipSoft, startsStatement, statementEnd,
  tokenizeDoc, type CallSite,
} from './pythonContext';

const SELECTOR_METHODS = new Set(['faces', 'edges', 'vertices', 'solids', 'wires', 'shells']);

function hoverDom(state: EditorState, pos: number): { from: number; to: number; dom: HTMLElement } | null {
  const tz = tokenizeDoc(state.doc);
  const { tokens, source } = tz;
  const i = lastTokenBefore(tokens, pos + 1);
  const t = tokens[i];
  if (!t || pos >= t.to) return null;
  const r = resolverFor(state);

  if (t.type === 'string' && t.closed) {
    const value = source.slice(t.contentFrom, t.contentTo);
    const call = callSiteBefore(tokens, i - 1);
    const callee = call ? r.callee(call.callee) : null;
    if (!callee) return null;
    let doc: string | undefined;
    if (SELECTOR_METHODS.has(callee.member.name)) {
      const entity = callee.member.name as 'faces';
      doc = value.split(/\s+(?:and|or|exc)\s+/).map((part) => selectorDoc(part.replace(/^not\s*/, ''), entity)).filter(Boolean).join(' · ') || undefined;
    } else {
      doc = [...PLANE_NAMES, ...CONSTRAINT_KINDS].find((d) => d.value === value)?.doc;
    }
    return doc ? { from: t.from, to: t.to, dom: renderValueHint(value, doc) } : null;
  }
  if (t.type !== 'name' || PY_KEYWORDS.has(t.text)) return null;

  const prev = skipSoft(tokens, i - 1);
  if (isOp(tokens[prev], '.')) {
    const owner = r.resolveChain(chainBefore(tokens, skipSoft(tokens, prev - 1)));
    const member = owner?.kind === 'type' ? memberOf(owner.type, t.text) : owner ? undefined : guessMember(t.text)?.member;
    return member ? { from: t.from, to: t.to, dom: renderMemberDoc(member) } : null;
  }

  // Resolve assignment targets as of the end of their own statement.
  const at = isOp(tokens[i + 1], '=') && startsStatement(tokens, i) ? tokens[statementEnd(tokens, i)].to : t.from;
  const resolved = r.resolveName(t.text, at);
  if (!resolved) return null;
  let dom: HTMLElement | null = null;
  if (resolved.kind === 'callable') dom = renderMemberDoc(resolved.member);
  else if (resolved.type === 'module:cq') dom = renderValueDoc('module', t.text, 'cadquery', 'CadQuery — parametric CAD on OpenCASCADE.');
  else if (resolved.type.startsWith('class:')) {
    const cls = cadqueryClass(resolved.type.slice(6));
    if (cls) dom = renderMemberDoc(cls);
  } else if (resolved.type === 'part') {
    dom = renderValueDoc('part', t.text, 'linked document', `Place it with design.add(${t.text}()); ${t.text}.result is its default geometry.`);
  } else {
    dom = renderValueDoc('variable', t.text, displayType(resolved.type));
  }
  return dom ? { from: t.from, to: t.to, dom } : null;
}

export const cadqueryHover = hoverTooltip((view, pos) => {
  const found = hoverDom(view.state, pos);
  if (!found) return null;
  return { pos: found.from, end: found.to, above: true, create: () => ({ dom: found.dom }) };
}, { hoverTime: 350 });

// ---------------------------------------------------------------------------
// Signature help

interface SignatureHelp {
  readonly member: MemberDoc;
  readonly overload: number;
  readonly active: number;
  readonly tooltip: Tooltip;
}

const closeSignatureHelp = StateEffect.define<null>();
const triggerSignatureHelp = StateEffect.define<null>();

function pickOverload(member: MemberDoc, call: CallSite): { overload: number; active: number } {
  const sigs = member.signatures;
  for (let overload = 0; overload < sigs.length; overload++) {
    const sig = sigs[overload];
    const active = call.keyword
      ? sig.findIndex((p) => p.name === call.keyword)
      : call.argIndex < sig.length ? call.argIndex : sig.findIndex((p) => p.star === '*');
    if (active >= 0 || (!call.keyword && sig.length === 0 && call.argIndex === 0 && overload === sigs.length - 1)) {
      return { overload, active };
    }
  }
  return { overload: 0, active: -1 };
}

function computeHelp(state: EditorState, previous: SignatureHelp | null): SignatureHelp | null {
  const pos = state.selection.main.head;
  const tz = tokenizeDoc(state.doc);
  const call = callSiteBefore(tz.tokens, lastTokenBefore(tz.tokens, pos));
  if (!call) return null;
  const callee = resolverFor(state).callee(call.callee);
  if (!callee || !callee.member.signatures.length) return null;
  const { overload, active } = pickOverload(callee.member, call);
  const open = tz.tokens[call.open].from;
  const anchor = state.doc.lineAt(open).number === state.doc.lineAt(pos).number ? open : pos;
  if (previous && previous.member === callee.member && previous.overload === overload && previous.active === active && previous.tooltip.pos === anchor) {
    return previous;
  }
  const { member } = callee;
  return {
    member,
    overload,
    active,
    tooltip: {
      pos: anchor,
      above: true,
      strictSide: false,
      arrow: false,
      create: () => ({ dom: renderSignatureHelp(member, overload, active) }),
    },
  };
}

function renderSignatureHelp(member: MemberDoc, overload: number, active: number): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-cq-sighelp';
  const head = document.createElement('div');
  head.className = 'cm-cq-sighelp-head';
  head.append(renderSignature(member, member.signatures[overload] ?? [], active, true));
  if (member.signatures.length > 1) {
    const count = document.createElement('span');
    count.className = 'cm-cq-sighelp-count';
    count.textContent = `${overload + 1}/${member.signatures.length}`;
    head.append(count);
  }
  const doc = document.createElement('div');
  doc.className = 'cm-cq-sighelp-doc';
  doc.textContent = member.doc;
  dom.append(head, doc);
  return dom;
}

const signatureHelpField = StateField.define<SignatureHelp | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some((e) => e.is(closeSignatureHelp))) return null;
    const trigger = tr.effects.some((e) => e.is(triggerSignatureHelp));
    if (!value && !trigger) {
      if (!tr.docChanged) return null;
      let opened = tr.isUserEvent('input.complete');
      if (tr.isUserEvent('input.type')) {
        tr.changes.iterChanges((_fa, _ta, _fb, _tb, text) => { if (/[(,]/.test(text.toString())) opened = true; });
      }
      if (!opened) return null;
    } else if (!trigger && !tr.docChanged && !tr.selection) {
      return value;
    }
    return computeHelp(tr.state, value);
  },
  provide: (field) => showTooltip.from(field, (help) => help?.tooltip ?? null),
});

export function signatureHelp(): Extension {
  return [
    signatureHelpField,
    EditorView.focusChangeEffect.of((_state, focusing) => (focusing ? null : closeSignatureHelp.of(null))),
    keymap.of([
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(signatureHelpField)) return false;
          view.dispatch({ effects: closeSignatureHelp.of(null) });
          return true;
        },
      },
      {
        key: 'Mod-Shift-Space',
        run: (view) => {
          view.dispatch({ effects: triggerSignatureHelp.of(null) });
          return true;
        },
      },
    ]),
  ];
}
