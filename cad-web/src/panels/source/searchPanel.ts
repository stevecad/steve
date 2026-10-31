import type { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, selectMatches, setSearchQuery,
} from '@codemirror/search';

/* A compact, floating find/replace widget (top-right), replacing CodeMirror's default panel. */

const ICONS = {
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  up: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
  down: '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  all: '<path d="M2.5 4h7M2.5 8h7M2.5 12h7M11.5 10.5l1.5 1.5 2.5-3"/>',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name];
  return svg;
}

function button(className: string, title: string, content: (Node | string)[], onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(...content);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

const MAX_COUNT = 1999;

class SearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly search: HTMLInputElement;
  private readonly replace: HTMLInputElement;
  private readonly field: HTMLElement;
  private readonly count: HTMLElement;
  private readonly options: Record<'caseSensitive' | 'wholeWord' | 'regexp', HTMLButtonElement>;
  private readonly navButtons: HTMLButtonElement[];
  private readonly replaceButtons: HTMLButtonElement[];
  /** Where incremental search starts matching from. */
  private anchor: number;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.anchor = view.state.selection.main.from;

    this.search = this.input('Find', this.query.search, true);
    this.replace = this.input('Replace', this.query.replace, false);
    const option = (key: 'caseSensitive' | 'wholeWord' | 'regexp', title: string, label: Node | string) => {
      const b = button('cm-cq-search-opt', title, [label], () => this.commit({ [key]: !this.query[key] }, true));
      b.setAttribute('aria-pressed', String(this.query[key]));
      return b;
    };
    const word = document.createElement('u');
    word.textContent = 'ab';
    this.options = {
      caseSensitive: option('caseSensitive', 'Match case (Alt+C)', 'Aa'),
      wholeWord: option('wholeWord', 'Match whole word (Alt+W)', word),
      regexp: option('regexp', 'Use regular expression (Alt+R)', '.*'),
    };
    this.field = document.createElement('div');
    this.field.className = 'cm-cq-search-field';
    this.field.append(this.search, this.options.caseSensitive, this.options.wholeWord, this.options.regexp);

    this.count = document.createElement('span');
    this.count.className = 'cm-cq-search-count';
    this.count.setAttribute('aria-live', 'polite');

    this.navButtons = [
      button('cm-cq-search-btn', 'Previous match (Shift+Enter)', [icon('up')], () => findPrevious(view)),
      button('cm-cq-search-btn', 'Next match (Enter)', [icon('down')], () => findNext(view)),
      button('cm-cq-search-btn', 'Select all matches (Alt+Enter)', [icon('all')], () => selectMatches(view)),
    ];
    const toggle = button('cm-cq-search-btn cm-cq-search-toggle', 'Toggle replace', [icon('chevron')], () => this.toggleReplace());
    const close = button('cm-cq-search-btn', 'Close (Escape)', [icon('close')], () => closeSearchPanel(view));

    const findRow = document.createElement('div');
    findRow.className = 'cm-cq-search-row';
    findRow.append(toggle, this.field, this.count, ...this.navButtons, close);

    const replaceField = document.createElement('div');
    replaceField.className = 'cm-cq-search-field';
    replaceField.append(this.replace);
    this.replaceButtons = [
      button('cm-cq-search-btn', 'Replace (Enter)', ['Replace'], () => replaceNext(view)),
      button('cm-cq-search-btn', 'Replace all (Ctrl+Alt+Enter)', ['All'], () => replaceAll(view)),
    ];
    const replaceRow = document.createElement('div');
    replaceRow.className = 'cm-cq-search-row cm-cq-search-replace';
    replaceRow.append(replaceField, ...this.replaceButtons);

    this.dom = document.createElement('div');
    this.dom.className = 'cm-cq-search';
    this.dom.dataset.replace = 'false';
    this.dom.setAttribute('role', 'search');
    this.dom.addEventListener('keydown', (e) => this.keydown(e));
    this.dom.append(findRow, replaceRow);
    this.refresh(view.state);
  }

  private input(placeholder: string, value: string, main: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (main) input.setAttribute('main-field', 'true');
    input.addEventListener('input', () => this.commit({}, main));
    return input;
  }

  private toggleReplace(open = this.dom.dataset.replace !== 'true'): void {
    if (this.view.state.readOnly) open = false;
    this.dom.dataset.replace = String(open);
    (open ? this.replace : this.search).focus();
  }

  private commit(overrides: Partial<Record<'caseSensitive' | 'wholeWord' | 'regexp', boolean>>, jump: boolean): void {
    const query = new SearchQuery({
      search: this.search.value,
      replace: this.replace.value,
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp,
      ...overrides,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    const effects = setSearchQuery.of(query);
    const match = jump && query.valid ? this.firstMatchFrom(query, this.anchor) : null;
    this.view.dispatch(match
      ? { effects: [effects, EditorView.scrollIntoView(match.from, { y: 'center' })], selection: { anchor: match.from, head: match.to } }
      : { effects });
  }

  private firstMatchFrom(query: SearchQuery, pos: number): { from: number; to: number } | null {
    const { state } = this.view;
    const after = query.getCursor(state, pos).next();
    if (!after.done) return after.value;
    const wrapped = query.getCursor(state, 0, pos).next();
    return wrapped.done ? null : wrapped.value;
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && e.target === this.search) {
      e.preventDefault();
      if (e.altKey) selectMatches(this.view);
      else (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === 'Enter' && e.target === this.replace) {
      e.preventDefault();
      (mod && e.altKey ? replaceAll : replaceNext)(this.view);
    } else if (e.altKey && !mod) {
      const key = ({ c: 'caseSensitive', w: 'wholeWord', r: 'regexp' } as const)[e.key.toLowerCase() as 'c' | 'w' | 'r'];
      if (key) {
        e.preventDefault();
        this.commit({ [key]: !this.query[key] }, true);
      }
    } else if (mod && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      this.toggleReplace(true);
    }
  }

  private refresh(state: EditorState): void {
    const q = this.query;
    this.options.caseSensitive.setAttribute('aria-pressed', String(q.caseSensitive));
    this.options.wholeWord.setAttribute('aria-pressed', String(q.wholeWord));
    this.options.regexp.setAttribute('aria-pressed', String(q.regexp));
    this.field.dataset.invalid = String(!!q.search && !q.valid);

    let total = 0;
    let current = 0;
    if (q.valid) {
      const sel = state.selection.main;
      const cursor = q.getCursor(state);
      for (let m = cursor.next(); !m.done && total <= MAX_COUNT; m = cursor.next()) {
        total++;
        if (m.value.from === sel.from && m.value.to === sel.to) current = total;
      }
    }
    const empty = !!q.search && total === 0;
    this.count.dataset.empty = String(empty);
    this.count.textContent = !q.search ? '' : !q.valid ? 'Invalid' : empty ? 'No results'
      : total > MAX_COUNT ? `${MAX_COUNT}+` : current ? `${current} of ${total}` : `${total} found`;
    for (const b of this.navButtons) b.disabled = total === 0;
    for (const b of this.replaceButtons) b.disabled = total === 0 || state.readOnly;
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const e of tr.effects) {
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) {
          this.query = e.value;
          this.search.value = e.value.search;
          this.replace.value = e.value.replace;
        }
      }
    }
    if (update.selectionSet && !this.dom.contains(document.activeElement)) this.anchor = update.state.selection.main.from;
    if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.length)) this.refresh(update.state);
  }

  mount(): void {
    this.search.select();
  }

  get pos(): number {
    return 80;
  }
}

export function createSearchPanel(view: EditorView): Panel {
  return new SearchPanel(view);
}
