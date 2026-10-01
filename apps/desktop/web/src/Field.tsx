import { useEffect, useRef, type ComponentProps } from 'react';

// a fleet name is lowercase only, so macOS may not capitalise, correct or complete it
export const AS_TYPED = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, autoComplete: 'off' } as const;

// onSave returns false to decline an edit, which puts the fleet's value back
type Follow = { value: string; onSave(value: string): boolean | void };

// an uncontrolled field that shows the fleet's value as it changes, except while someone is editing it;
// onSave hears only an edit made in the field, and one the fleet has not taken stays there for the next blur to send again
function useFollow<T extends HTMLInputElement | HTMLTextAreaElement>({ value, onSave }: Follow) {
  const ref = useRef<T>(null);
  const latest = useRef(value);
  const start = useRef(value);
  const sent = useRef<string>(undefined);
  latest.current = value;
  useEffect(() => {
    if (value === sent.current) sent.current = undefined;
    const el = ref.current;
    if (el && el !== document.activeElement) el.value = value;
  }, [value]);
  return {
    ref, defaultValue: value,
    onFocus: () => { const v = ref.current!.value; start.current = v === sent.current ? latest.current : v; },
    onBlur: () => {
      const el = ref.current!;
      if (el.value === start.current || onSave(el.value) === false) el.value = latest.current;
      else if (el.value !== latest.current) sent.current = el.value;
    },
  };
}

// a field saves on blur, which WebKit never sends to a removed field or past a press that calls preventDefault;
// map presses and the chords that move the selection or close a card or the shelf call this first
export const commitFocused = (): void => {
  const el = globalThis.document?.activeElement;
  if (el?.matches('input, textarea')) (el as HTMLElement).blur();
};

type Props<E extends 'input' | 'textarea'> = Omit<ComponentProps<E>, 'value' | 'defaultValue' | 'ref' | 'onFocus' | 'onBlur'> & Follow;

export function FollowTextarea({ value, onSave, ...rest }: Props<'textarea'>) {
  return <textarea {...rest} {...useFollow<HTMLTextAreaElement>({ value, onSave })} />;
}

// a one-line value that wraps instead of clipping: the box grows to its text, and Enter finishes the edit
export function FollowLine({ value, onSave, ...rest }: Props<'textarea'>) {
  const follow = useFollow<HTMLTextAreaElement>({ value, onSave: (v) => onSave(v.replace(/\s*\n\s*/g, ' ')) });
  const fit = () => { const el = follow.ref.current; if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(fit, [value]);
  return (
    <textarea rows={1} {...rest} {...follow} onInput={fit} onBlur={() => { follow.onBlur(); fit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
  );
}
