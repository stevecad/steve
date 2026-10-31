/**
 * Whether the app offers the old record forms (create, edit, duplicate, archive, import, add examples, the tool
 * builders) that write manufacturing library records directly. Off: the tools people use only generate code, so the
 * library is written by the shop (shop/state.ts changeShop and addToShop) and a record is changed in its shop. The
 * backend routes stay (agents, imports through the API and the tests use them).
 */
export const RECORD_FORMS: boolean = false;
