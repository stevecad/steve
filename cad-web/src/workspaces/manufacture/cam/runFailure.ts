/**
 * A run's failure as said to the person: the operation it stopped at goes first when the message doesn't already name
 * it ("The selected wall must be…" said nothing of which operation), by its name in `record` if it has one.
 */
export function namedFailure(error: { message?: string; operation?: string | null } | null | undefined, record: { compiled: { operations: unknown[] } } | null | undefined, fallback: string): string {
  const message = error?.message ?? fallback;
  const id = error?.operation;
  if (!id || message.includes(`'${id}'`) || message.includes(`"${id}"`)) return message;
  const op = (record?.compiled.operations as { id?: string; name?: string }[] | undefined)?.find((item) => item.id === id);
  const name = op?.name ?? id;
  return message.includes(name) ? message : `${name}: ${message}`;
}
