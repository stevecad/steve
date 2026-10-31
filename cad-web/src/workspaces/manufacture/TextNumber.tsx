/**
 * The shared NumberField (scrub, arithmetic, arrow steps) over a form's text draft: the forms that keep a number as
 * the text typed (blank meaning "not given") check it on save as before. Each typed value reaches the draft as it reads
 * (their buttons and results follow the typing); a scrub reaches it once, on release.
 */
import { NumberField } from '@/ui';

type Options = Omit<React.ComponentProps<typeof NumberField>, 'value' | 'onChange' | 'optional' | 'eager'>;

export const draftNumber = (text: string): number | undefined => {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) ? undefined : value;
};

export default function TextNumber({ value, onChange, unit = '', ...options }: Options & { value: string; onChange: (text: string) => void }) {
  return <NumberField {...options} unit={unit} optional eager value={draftNumber(value)} onChange={(next) => onChange(next === undefined ? '' : String(next))} />;
}
