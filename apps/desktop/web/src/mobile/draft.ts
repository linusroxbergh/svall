// the page reloads itself when svalld moves to a newer protocol, so a prompt not yet sent is kept for the tab
const DRAFT = 'svall.mobile.draft.';

// a browser with site data switched off throws rather than returning nothing
export const readDraft = (id: string): string => { try { return sessionStorage.getItem(DRAFT + id) ?? ''; } catch { return ''; } };

export const writeDraft = (id: string, text: string): void => {
  try { if (text) sessionStorage.setItem(DRAFT + id, text); else sessionStorage.removeItem(DRAFT + id); } catch { /* site data switched off */ }
};
