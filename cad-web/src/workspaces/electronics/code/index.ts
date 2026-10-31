/**
 * The circuit code engine: an index of a TSX circuit's JSX elements, and edits that rewrite it the way a person
 * would. Pure TypeScript (no React), for the browser and Node. Call `ensureParser()` once before parsing or editing.
 */
export { ensureParser, parserReady } from './parser';
export { parse, lineColumn, slice } from './source';
export { EditError } from './types';
export type { Attr, AttrKind, EditErrorCode, EditResult, Element, ElementScope, ParseError, SourceIndex, Span, StringPiece, Target } from './types';
export {
  addTrace, findElement, indexFor, insertElement, moveBy, removeElement, removeProp, renameElement, repairSupplierPartNumbers, resolveTarget, rotate,
  setBoard, setLayer, setPosition, setProp, setProps, supplierStringForms,
} from './edits';
export type { InsertSpec, SetPropOptions, View } from './edits';
export { CircuitLookup, isValidName, netSelector, parseSelector, portSelector, referencesName, renameReferences } from './selectors';
export type { Selector } from './selectors';
export { NAME_PREFIX, nextName, prefixFor } from './naming';
export { angleDeg, formatAttr, formatAttrValue, formatJs, lengthMm, staticValue, supplierPartsArrayForm } from './values';
export { applyPcbEditEvent, applySchematicEditEvent, elementForComponent, pcbAnchor } from './viewEdits';
export type { ViewEditEvent } from './viewEdits';
export { FAB_READY_BOARD, FIXABLE_RULES, STOCK_PARTS, addCrystalLoadCaps, addDecoupling, addLedResistor, addRegulatorCaps, addUsbCcResistors, applyFabReadyBoard, isGroundNet, isPowerNet, setNetTraceWidth } from './fixes';
