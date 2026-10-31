/** The Electronics parts catalog: palette entries, footprint suggestions, and property forms from tscircuit's schemas. */
export { CATEGORIES, PARTS, partFor, searchParts, withDerived } from './catalog';
export type { Category, PartSpec } from './catalog';
export { FOOTPRINT_FAMILIES, footprintFamily, footprintsFor } from './footprints';
export { FIELD_GROUPS, allParts, loadSchemas, schemaFor, schemasReady } from './schema';
export type { ElementSchema, Field, FieldGroup, FieldKind, JsonSchema } from './schema';
export { PART_DRAG_TYPE, placePart } from './place';
export type { PlaceOptions } from './place';
export { capacitanceOf, colorOf, elementForJlcPart, formatPrice, formatStock, frequencyOf, inductanceOf, jlcQueryFor, plainQuery, rankJlcParts, resistanceOf } from './jlcpcb';
export type { JlcElement, JlcPart, JlcSearch } from './jlcpcb';
