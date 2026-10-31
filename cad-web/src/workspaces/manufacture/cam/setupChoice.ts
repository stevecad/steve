/**
 * The Setup tool's machine and tool setup: pick a machine, pick a tool setup, done. A new setup takes the only one
 * there is; between several it never guesses. Pure (tests/shop_ui_test.mjs).
 */

/** The id of the only choice, or null when there are none or several. */
export const soleChoice = (choices: readonly { id: string }[]): string | null => (choices.length === 1 ? choices[0].id : null);
