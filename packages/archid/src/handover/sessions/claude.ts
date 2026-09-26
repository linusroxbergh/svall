import path from 'node:path';
import { compile, filesUnder, inRange, transcriptFile, walkJson, walkJsonl, type RecordCheck } from './records.js';
import { SessionError, type PathMap, type SessionAdapter, type SessionFs } from './types.js';

const VERSIONS = { min: '2.1.251', max: '2.1.280' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// every record and attachment type these releases wrote across about a million records of real sessions
const TYPES = new Set([
  'agent-name', 'ai-title', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'assistant', 'atis-latch', 'attachment',
  'bridge-session', 'continued-in', 'cost-state', 'file-history-delta', 'file-history-snapshot', 'frame-link', 'history-suppression',
  'last-prompt', 'mode', 'permission-mode', 'pr-link', 'queue-operation', 'relocated', 'system', 'user', 'worktree-state',
]);
const ATTACHMENTS = new Set([
  'agent_listing_delta', 'auto_mode', 'auto_mode_exit', 'bash_output_audience_note', 'batching_reminder_sent', 'command_permissions',
  'compact_file_reference', 'date', 'date_change', 'deferred_tools_delta', 'deferred_tools_record', 'diagnostics', 'dynamic_skill',
  'edited_text_file', 'environment', 'file', 'hook_additional_context', 'hook_cancelled', 'hook_non_blocking_error', 'hook_success',
  'hook_system_message', 'instructions', 'invoked_skills', 'mcp_instructions_delta', 'model', 'nested_memory', 'plan_mode', 'plan_mode_exit',
  'prompt_snapshot', 'queued_command', 'read_truncation_notice', 'remote_session_change', 'session_context', 'silent_turn_reminder',
  'skill_listing', 'structured_output', 'task_reminder', 'thinking_drop', 'total_tokens_reminder',
]);

// Where the session stands and where worktrees point moves with it. What the conversation said, the tools it ran
// and what it was shown, the environment snapshot among them, is kept as the source wrote it: Claude Code tells the
// resumed model how its environment changed.
const RECORD = {
  paths: ['cwd', 'relocatedCwd', 'worktreeSession.originalCwd', 'worktreeSession.preEnterOriginalCwd', 'worktreeSession.worktreePath'],
  evidence: [
    'message', 'toolUseResult', 'content', 'rendered', 'wireToolInputs', 'wireIngestContext', 'attachment', 'lastPrompt', 'prompt',
    'hookInfos', 'hookErrors', 'hookAdditionalContext', 'stopReason', 'error', 'errorDetails', 'mcpMeta', 'serverClassifierContext',
  ],
};
const SPEC = compile(RECORD);
const FRAME_LINK = compile(RECORD, { paths: ['path'] });
// the backups stay on the source, so what file history tracked keeps naming the files there
const FILE_HISTORY = compile(RECORD, { evidence: ['snapshot', 'trackingPath', 'backup'] });
const META = compile({ paths: ['cwd', 'worktreePath'], evidence: ['description'] });

type Kind = 'records' | 'meta' | 'verbatim';
// what a session keeps in its own folder beside the transcript
const SIDECARS: [RegExp, Kind][] = [
  [/^subagents\/[^/]+\.meta\.json$/, 'meta'],
  [/^subagents\/[^/]+\.jsonl$/, 'records'],
  // tool output too long to show inline, which the transcript names by its path on the source
  [/^tool-results\/[^/]+$/, 'verbatim'],
];
const TRANSCRIPT = /^projects\/[^/]+\/([^/]+)\.jsonl$/;
const SIDECAR = /^projects\/[^/]+\/[^/]+\/(.+)$/;

/** What a file under the config folder is to a session, if it is part of one. */
function kindOf(file: string): Kind | undefined {
  if (TRANSCRIPT.test(file)) return 'records';
  const inner = SIDECAR.exec(file)?.[1];
  return inner === undefined ? undefined : SIDECARS.find(([re]) => re.test(inner))?.[1];
}

/** Whether `file` is session `sessionId`'s, whose transcript sits at `transcript`: that transcript, or a sidecar in its folder. */
function carries(file: string, transcript: string, sessionId: string): boolean {
  if (!UUID.test(sessionId) || TRANSCRIPT.exec(transcript)?.[1] !== sessionId) return false;
  const folder = `${transcript.slice(0, -'.jsonl'.length)}/`;
  return file === transcript || (file.startsWith(folder) && kindOf(file) !== undefined);
}

function transcriptRecords(): { check: (r: Record<string, unknown>) => RecordCheck; versions: Set<string> } {
  const versions = new Set<string>();
  const range = `Claude Code ${VERSIONS.min} to ${VERSIONS.max}`;
  const check = (r: Record<string, unknown>): RecordCheck => {
    if (typeof r.type !== 'string' || !TYPES.has(r.type)) return { issue: `a ${JSON.stringify(r.type)} record, which ${range} does not write` };
    if (r.type === 'attachment') {
      const kind = (r.attachment as { type?: unknown } | undefined)?.type;
      if (typeof kind !== 'string' || !ATTACHMENTS.has(kind)) return { issue: `an attachment of type ${JSON.stringify(kind)}, which ${range} does not write` };
    }
    if (typeof r.version === 'string') {
      if (!inRange(r.version, VERSIONS)) return { issue: `records written by Claude Code ${r.version}, outside ${VERSIONS.min} to ${VERSIONS.max}` };
      versions.add(r.version);
    }
    return { spec: r.type === 'frame-link' ? FRAME_LINK : r.type.startsWith('file-history-') ? FILE_HISTORY : SPEC };
  };
  return { check, versions };
}

function transform(file: string, data: Buffer, map: PathMap): { data: Buffer; issues: string[] } {
  const kind = kindOf(file);
  if (kind === 'records') {
    const { check, versions } = transcriptRecords();
    const out = walkJsonl(data, map, check);
    if (versions.size === 0 && data.length > 0 && out.issues.length === 0) out.issues.push('no record names the Claude Code release that wrote it');
    return out;
  }
  if (kind === 'meta') return walkJson(data, map, META);
  if (kind === 'verbatim') return { data, issues: [] };
  return { data, issues: ['it is a kind of file Claude Code session adapter 1 does not carry'] };
}

export const claudeAdapter: SessionAdapter = {
  kind: 'claude',
  adapter: 1,
  versions: VERSIONS,
  sessionStartOnResume: true,
  supports: (version) => inRange(version, VERSIONS),

  // <config>/projects/<slug>/<id>.jsonl, with the session's own folder beside it
  async discover(transcriptPath: string, sessionId: string, fs: SessionFs) {
    const file = path.posix.normalize(transcriptPath);
    if (!UUID.test(sessionId) || path.posix.basename(file) !== `${sessionId}.jsonl`) {
      throw new SessionError('transcript_missing', `${transcriptPath} is not the transcript of session ${sessionId}`);
    }
    const project = path.posix.dirname(file);
    const projects = path.posix.dirname(project);
    if (!file.startsWith('/') || path.posix.basename(projects) !== 'projects') {
      throw new SessionError('incompatible_adapter', `${transcriptPath} is not in a Claude Code projects folder`);
    }
    await transcriptFile(fs, file);
    const home = path.posix.dirname(projects);
    const transcript = path.posix.relative(home, file);
    // file history stays, since its backups name machine-local files, and so does session-env, which can hold secrets
    const folder = path.posix.join(path.posix.dirname(transcript), sessionId);
    const sidecars = (await filesUnder(fs, home, folder)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const unknown = sidecars.filter((f) => !carries(f, transcript, sessionId)).map((f) => f.slice(folder.length + 1));
    if (unknown.length) {
      const named = `${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}`;
      throw new SessionError('incompatible_adapter', `${path.posix.join(home, folder)} holds ${named}, which Claude Code session adapter 1 does not carry`);
    }
    return { home, transcript, files: [transcript, ...sidecars] };
  },

  carries,

  rewrite(file, data, map) {
    const out = transform(file, data, map);
    if (out.issues.length) throw new SessionError('incompatible_adapter', `${file}: ${out.issues.join('; ')}`);
    return out.data;
  },

  validate: (file, data, map) => transform(file, data, map).issues,
};
