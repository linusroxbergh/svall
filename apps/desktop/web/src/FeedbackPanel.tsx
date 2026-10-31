import { useEffect, useRef, useState } from 'react';
import { FEEDBACK_TEXT_MAX, type FeedbackKind } from '@svall/protocol';
import { CloseX } from './CloseX.js';
import { sendFeedback } from './feedback.js';
import { Glide } from './Glide.js';
import { useApp } from './hooks.js';

const PLACEHOLDER: Record<FeedbackKind, string> = { bug: 'What happened, and what did you expect?', idea: 'What would you like Svall to do?' };

/** The feedback form: Bug or Idea, free text, and the diagnostics it can attach, shown before they go. */
export function FeedbackPanel({ diagnostics, hint = 'Version, health checks, last 200 log lines.' }: { diagnostics: () => Promise<string>; hint?: string }) {
  const { kind, text, tick } = useApp((s) => s.feedbackDraft);
  const setDraft = useApp((s) => s.setFeedbackDraft);
  const [diag, setDiag] = useState<string | null>();
  const [see, setSee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const sending = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    area.current?.focus();
    diagnostics().then(setDiag, () => setDiag(null));
    return () => { live.current = false; };
  }, []);

  const checked = typeof diag === 'string' && (tick ?? kind === 'bug');
  // the box stays unticked while the preview loads, so a Bug sent now would leave diagnostics out
  const gathering = diag === undefined && (tick ?? kind === 'bug');
  const submit = async () => {
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await sendFeedback({ kind, text, ...(checked ? { diagnostics: diag } : {}) });
      setDraft();
      if (!live.current) return;
      setSent(true);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      sending.current = false;
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="fb">
      <div className="seg" role="group" aria-label="Kind">
        <Glide at={kind} />
        {(['bug', 'idea'] as const).map((k) => (
          <button key={k} data-testid={`feedback-kind-${k}`} aria-pressed={kind === k} onClick={() => setDraft({ kind: k })}>{k === 'bug' ? 'Bug' : 'Idea'}</button>
        ))}
      </div>
      <textarea ref={area} className="fld" data-testid="feedback-text" value={text} maxLength={FEEDBACK_TEXT_MAX} placeholder={PLACEHOLDER[kind]}
        onChange={(e) => { setDraft({ text: e.target.value }); setSent(false); }} />
      <label className="fb-check">
        <input type="checkbox" data-testid="feedback-diagnostics" checked={checked} disabled={typeof diag !== 'string'} onChange={(e) => setDraft({ tick: e.target.checked })} />
        <span>
          Include diagnostics
          <small className="fb-hint">
            {diag === null ? 'Diagnostics unavailable' : diag === undefined ? 'Gathering diagnostics…' : <>{hint}{' '}
              <button type="button" className="fb-see" data-testid="feedback-see" onClick={(e) => { e.preventDefault(); setSee(!see); }}>See what's sent</button></>}
          </small>
        </span>
      </label>
      {see && typeof diag === 'string' && <pre className="mono fb-preview" data-testid="feedback-preview">{diag}</pre>}
      {error && <div className="fb-error" role="alert" data-testid="feedback-error">{error}</div>}
      {sent
        ? <div className="fb-sent" role="status" data-testid="feedback-sent">Sent, thanks</div>
        : <button className="btn pri fb-send" data-testid="feedback-send" disabled={busy || gathering || !text.trim()} onClick={submit}>Send</button>}
    </div>
  );
}

/** The form in a popover of its own, for the screens without the utility dock. */
export function FeedbackPopover({ onClose, ...form }: { onClose: () => void } & Parameters<typeof FeedbackPanel>[0]) {
  return (
    <div className="use">
      <div className="use-panel popover" data-testid="feedback-panel" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div className="use-panel-title"><span>Send feedback</span><CloseX onClose={onClose} testid="corner-panel-close" /></div>
        <FeedbackPanel {...form} />
      </div>
    </div>
  );
}
