import type { ContextItem, ContextKind } from '@svall/protocol';
import {
  siAsana, siClaude, siConfluence, siDatadog, siDiscord, siDropbox, siFigma, siGithub, siGitlab,
  siGoogledocs, siGoogledrive, siJira, siLinear, siLoom, siMiro, siNotion, siNpm, siSentry,
  siStackoverflow, siTrello, siVercel, siYoutube,
} from 'simple-icons';
import { linkText } from './tokenText.js';

// simple-icons has no slack mark, so this is a plain slanted hash
const SLACK = 'M9.2 3h2.4l-2 18H7.2zM15.6 3H18l-2 18h-2.4zM3 8.4h18v2.4H3zM3 13.2h18v2.4H3z';
// nor a mentimeter mark: the logo's disc, wedge and steps, told apart by tone since the chip has one colour
const MENTIMETER = (
  <>
    <path d="M0 9.51a14.39 14.39 0 0 1 14.39 14.39H0z" />
    <path opacity=".5" d="M0 0h4.97l4.67 9.5v3.72A14.39 14.39 0 0 0 0 9.51z" />
    <path opacity=".72" d="M9.64 9.5h4.75V4.75h4.83V0H24v23.9h-9.61A14.39 14.39 0 0 0 9.64 13.22z" />
  </>
);

// null is a kind that draws a letter instead, so a new kind has to say which it is
const PATHS: Record<ContextKind, React.ReactNode> = {
  pr: siGithub.path, issue: siGithub.path, github: siGithub.path, gitlab: siGitlab.path,
  linear: siLinear.path, jira: siJira.path, confluence: siConfluence.path, notion: siNotion.path,
  slack: SLACK, figma: siFigma.path, sentry: siSentry.path, datadog: siDatadog.path,
  vercel: siVercel.path, gdocs: siGoogledocs.path, gdrive: siGoogledrive.path, npm: siNpm.path,
  loom: siLoom.path, trello: siTrello.path, asana: siAsana.path, discord: siDiscord.path,
  youtube: siYoutube.path, stackoverflow: siStackoverflow.path, miro: siMiro.path,
  dropbox: siDropbox.path, mentimeter: MENTIMETER, claude: siClaude.path,
  other: null, file: null, folder: null,
};

// no logo: the first letter of the file name, or of the host
function letter(item: ContextItem): string {
  const from = item.kind === 'file' || item.kind === 'folder'
    ? linkText(item)
    : item.ref.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '');
  return (from[0] ?? '?').toUpperCase();
}

export function LinkIcon({ item }: { item: ContextItem }) {
  const path = PATHS[item.kind];
  if (!path) return <span>{letter(item)}</span>;
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{typeof path === 'string' ? <path d={path} /> : path}</svg>;
}
