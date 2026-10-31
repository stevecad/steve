import type { MemberDoc, Param } from './cadqueryDocs';

/* DOM builders for signature/doc cards shared by completion info, hover and signature help. */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

const KIND_LABEL: Record<MemberDoc['kind'], string> = {
  method: 'method',
  function: 'function',
  property: 'property',
  class: 'class',
  module: 'module',
  constant: 'constant',
};

function paramText(p: Param): string {
  return `${p.star ?? ''}${p.name}${p.type ? `: ${p.type}` : ''}${p.default !== undefined ? ` = ${p.default}` : ''}`;
}

export function signatureText(member: MemberDoc, params: readonly Param[]): string {
  return `${member.name}(${params.map(paramText).join(', ')})`;
}

/** A syntax-colored signature; long ones break one parameter per line. */
export function renderSignature(member: MemberDoc, params: readonly Param[], active = -1, inline = false): HTMLElement {
  const sig = el('div', 'cm-cq-sig');
  const nameClass = member.kind === 'class' ? 'cm-cq-sig-class' : 'cm-cq-sig-name';
  if (member.owner !== 'local' && member.owner !== 'cq' && member.kind !== 'property' && member.kind !== 'constant') {
    sig.append(el('span', 'cm-cq-sig-owner', `${member.owner}.`));
  }
  sig.append(el('span', nameClass, member.name));
  const returns = member.returns && member.returns !== 'None' && !member.returns.startsWith('module:') ? member.returns : null;

  if (member.kind === 'property' || member.kind === 'constant') {
    if (returns) sig.append(el('span', 'cm-cq-sig-punct', ': '), el('span', 'cm-cq-sig-type', returns));
    return sig;
  }
  if (member.kind === 'module') return sig;

  const multiline = !inline && signatureText(member, params).length > 58 && params.length > 1;
  sig.append(el('span', 'cm-cq-sig-punct', '('));
  params.forEach((p, i) => {
    const node = el('span', i === active ? 'cm-cq-sig-param cm-cq-sig-active' : 'cm-cq-sig-param');
    if (p.star || p.name) node.append(el('span', 'cm-cq-sig-pname', `${p.star ?? ''}${p.name}`));
    if (p.type) node.append(el('span', 'cm-cq-sig-punct', ': '), el('span', 'cm-cq-sig-type', p.type));
    if (p.default !== undefined) node.append(el('span', 'cm-cq-sig-punct', ' = '), el('span', 'cm-cq-sig-default', p.default));
    if (multiline) sig.append('\n    ');
    sig.append(node);
    if (i < params.length - 1) sig.append(el('span', 'cm-cq-sig-punct', multiline ? ',' : ', '));
  });
  if (multiline) sig.append('\n');
  sig.append(el('span', 'cm-cq-sig-punct', ')'));
  if (returns) sig.append(el('span', 'cm-cq-sig-arrow', ' → '), el('span', 'cm-cq-sig-type', returns));
  return sig;
}

export interface DocOptions {
  /** Highlight this parameter (signature help). */
  readonly active?: number;
  /** Only show this overload. */
  readonly overload?: number;
}

/** Full documentation card for a CadQuery member. */
export function renderMemberDoc(member: MemberDoc, options: DocOptions = {}): HTMLElement {
  const card = el('div', 'cm-cq-doc');
  const signatures = options.overload !== undefined
    ? [member.signatures[options.overload] ?? []]
    : member.signatures.length ? member.signatures : [[]];
  const sigs = el('div', 'cm-cq-doc-sigs');
  for (const params of signatures.slice(0, 7)) sigs.append(renderSignature(member, params, options.active));
  card.append(sigs);
  const body = el('div', 'cm-cq-doc-body', el('div', 'cm-cq-doc-text', member.doc));
  const meta = el('div', 'cm-cq-doc-meta', el('span', 'cm-cq-doc-kind', KIND_LABEL[member.kind]));
  const owner = member.owner === 'cq' ? 'cadquery' : member.owner === 'local' ? 'this file' : member.owner;
  meta.append(el('span', 'cm-cq-doc-chip', owner));
  if (member.group && member.group !== 'Class' && member.group !== 'Module' && member.group !== 'Local') {
    meta.append(el('span', 'cm-cq-doc-chip', member.group));
  }
  if (options.overload === undefined && member.signatures.length > 1) {
    meta.append(el('span', 'cm-cq-doc-chip', `${member.signatures.length} overloads`));
  }
  body.append(meta);
  card.append(body);
  return card;
}

/** Compact card for a plain value: `(variable) plate: Workplane`. */
export function renderValueDoc(label: string, name: string, type: string, doc?: string): HTMLElement {
  const card = el('div', 'cm-cq-doc');
  const sig = el('div', 'cm-cq-sig',
    el('span', 'cm-cq-sig-owner', `(${label}) `),
    el('span', 'cm-cq-sig-pname', name),
    el('span', 'cm-cq-sig-punct', ': '),
    el('span', 'cm-cq-sig-type', type),
  );
  card.append(el('div', 'cm-cq-doc-sigs', sig));
  if (doc) card.append(el('div', 'cm-cq-doc-body', el('div', 'cm-cq-doc-text', doc)));
  return card;
}

/** Card for a selector or literal value inside a string. */
export function renderValueHint(value: string, doc: string): HTMLElement {
  const card = el('div', 'cm-cq-doc cm-cq-doc-compact');
  card.append(el('div', 'cm-cq-doc-sigs', el('div', 'cm-cq-sig', el('span', 'cm-cq-sig-default', `"${value}"`))));
  card.append(el('div', 'cm-cq-doc-body', el('div', 'cm-cq-doc-text', doc)));
  return card;
}

/** Short parameter preview for completion rows: `(length, width, height, …)`. */
export function paramPreview(member: MemberDoc): string {
  if (member.kind === 'property' || member.kind === 'constant') return member.returns ?? '';
  if (member.kind === 'module') return 'module';
  const params = member.signatures[0] ?? [];
  if (member.kind === 'class' && !member.signatures.length) return 'class';
  const required = params.filter((p) => p.default === undefined && !p.star && p.name);
  const more = params.length > required.length;
  if (!required.length) return more ? '(…)' : '()';
  return `(${required.map((p) => p.name).join(', ')}${more ? ', …' : ''})`;
}
