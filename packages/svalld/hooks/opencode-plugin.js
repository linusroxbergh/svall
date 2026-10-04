// Svall's plugin for OpenCode, which svalld writes into OpenCode's plugins folder and OpenCode loads into every session.
// Inside a Svall character it reports the session to svalld as hook events, gives the agent its brief as system text,
// and logs the session for Svall to read.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the release's svall.js and Svall Dev's svall-dev.js both load, so each acts only for its own build's homes;
// a home named like neither is a test fleet's, which Svall Dev answers
const VARIANT = path.basename(fileURLToPath(import.meta.url)) === 'svall.js' ? 'release' : 'dev';
const variantOf = (h) => {
  const b = path.basename(h);
  return /^\.svall(-[a-z][a-z0-9-]*)?$/.test(b) && !/^\.svall-dev(-|$)/.test(b) ? 'release' : 'dev';
};

const WAIT_MS = 1500;
const SHOW_MS = 500;
const MAX_PROMPT = 4000;
const MAX_TOOL = 2000;
const clip = (v, n) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, n);

// Svall resumes a dormant character with `opencode -s <id>`. The TUI runs plugins in a worker whose argv is the
// worker's own, so the command line is read from ps, where a prompt's words pass for flags
const resumedFrom = (argv) => {
  const end = argv.indexOf('--prompt');
  const i = argv.findIndex((a, j) => /^(-s|--session)(=|$)/.test(a) && (end === -1 || j < end));
  const id = i === -1 ? undefined : argv[i].split('=')[1] ?? argv[i + 1];
  return /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id ?? '') ? id : undefined;
};
const commandLine = () => {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/); } catch { return []; }
};

export const SvallPlugin = async ({ client, directory }) => {
  const charId = process.env.SVALL_CHAR_ID;
  const home = process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
  if (!charId || variantOf(home) !== VARIANT) return {};
  const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
  const logDir = path.join(home, 'transcripts', 'opencode');
  const logOf = (id) => path.join(logDir, `${id}.jsonl`);
  const log = (id, entry) => { try { fs.appendFileSync(logOf(id), JSON.stringify(entry) + '\n'); } catch {} };

  // one connection carries every line in order; svalld answers SessionStart and UserPromptSubmit on it, in turn
  let conn;
  const replies = [];
  const connect = () => {
    if (conn) return conn;
    const s = net.createConnection(path.join(home, 'hooks.sock'));
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        let text = '';
        try { text = JSON.parse(buf.slice(0, nl)).additionalContext ?? ''; } catch {}
        buf = buf.slice(nl + 1);
        replies.shift()?.(text);
      }
    });
    // a restarting daemon drops the connection; the next line opens another
    const drop = () => { if (conn === s) conn = undefined; for (const r of replies.splice(0)) r(''); };
    s.on('error', drop);
    s.on('close', drop);
    s.unref();
    return (conn = s);
  };
  const send = (line, wait) => new Promise((resolve) => {
    const s = connect();
    if (!wait) { s.write(JSON.stringify(line) + '\n', () => resolve('')); return; }
    // an answer that never comes, as for a line svalld refused, would pair every later answer with the wrong line,
    // so the connection starts over
    const timer = setTimeout(() => s.destroy(), WAIT_MS);
    replies.push((text) => { clearTimeout(timer); resolve(text); });
    s.write(JSON.stringify(line) + '\n');
  });

  // bash runs where its call says, so the newest directory one names is where the agent works
  let workdir;
  const hook = (name, session, fields = {}) => send({
    charId, term, backend: 'opencode', pid: process.pid,
    hook: { hook_event_name: name, session_id: session, transcript_path: logOf(session), cwd: workdir ?? directory, ...fields },
  }, name === 'SessionStart' || name === 'UserPromptSubmit');

  // a subagent works in a child session; its parent is looked up once, '' for a top-level session
  const parents = new Map();
  const parentOf = async (id) => {
    if (!parents.has(id)) parents.set(id, (await client.session.get({ path: { id } }).catch(() => undefined))?.data?.parentID ?? '');
    return parents.get(id);
  };
  const rootOf = async (id) => { for (let p = await parentOf(id); p; p = await parentOf(id)) id = p; return id; };

  const brief = new Map();
  const started = new Map();
  const limits = new Map();
  const busy = new Set();
  const ending = new Map();
  const replying = new Set();
  const logged = new Set();
  // questions open anywhere in the session tree, each with what it asks; a tool another subagent runs meanwhile does not
  // answer them
  const asking = new Map();
  // the TUI shows one, permissions before questions, each by session and then by when it was asked, and Enter answers it
  const rank = ([id, a]) => `${a.question ? 1 : 0} ${a.session} ${id}`;
  // the card shows the same one a moment late, so a question the TUI answers by itself, as with --auto, never blocks it
  let shown;
  let showing;
  const show = () => {
    clearTimeout(showing);
    showing = setTimeout(async () => {
      const [id, a] = [...asking].sort((x, y) => (rank(x) < rank(y) ? -1 : 1))[0] ?? [];
      if (id === shown?.id) return;
      const last = shown;
      shown = id && { id, session: a.session };
      // the last answer sets the agent going again: the tool runs, or a refusal ends the turn
      if (id) void hook('PermissionRequest', await rootOf(a.session), a.fields);
      else void hook('PreToolUse', await rootOf(last.session));
    }, SHOW_MS);
  };
  const ask = (id, session, fields, question = false) => { asking.set(id, { session, fields, question }); show(); };

  // a top-level session reports in once per process, and its log exists from then on
  const start = (id, model) => {
    if (!started.has(id)) {
      parents.set(id, '');
      started.set(id, (async () => {
        try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(logOf(id), ''); } catch {}
        const text = await hook('SessionStart', id, model ? { model } : {});
        if (text) brief.set(id, text);
      })());
    }
    return started.get(id);
  };

  // OpenCode takes no prompt on a resume, so a wake prompt waits in svalld's prompt file
  const resumed = resumedFrom(process.argv) ?? resumedFrom(commandLine());
  if (resumed) void start(resumed).then(() => {
    if (term) return;
    const file = path.join(home, `${charId}.prompt`);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); fs.rmSync(file); } catch { return; }
    if (text.trim()) void wake(resumed, text);
  });

  // a /command runs as the TUI runs one typed; sent as a prompt, the model would read it as text
  const wake = async (id, text) => {
    const [, command, args = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim()) ?? [];
    const known = command && (await client.command.list().catch(() => undefined))?.data?.some((c) => c.name === command);
    const sent = known ? client.session.command({ path: { id }, body: { command, arguments: args } })
      : client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }] } });
    await sent.catch(() => {});
  };

  // the TUI's own reading: the newest reply's tokens over the model's context window
  const context = (m) => {
    if (m?.role !== 'assistant') return;
    replying.add(m.id);
    const t = m.tokens;
    const max = limits.get(m.sessionID);
    if (!started.has(m.sessionID) || !max || !t?.output) return;
    const used = t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    void send({ charId, term, status: { sessionId: m.sessionID, contextPct: Math.round((used / max) * 100), model: m.modelID } });
  };
  const said = (part) => {
    if (part?.type !== 'text' || part.synthetic || !part.time?.end || !replying.has(part.messageID) || !started.has(part.sessionID) || logged.has(part.id)) return;
    logged.add(part.id);
    if (part.text?.trim()) log(part.sessionID, { kind: 'agent', text: part.text.trim() });
  };

  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      switch (event.type) {
        case 'session.created':
          if (!p.info?.id) return;
          parents.set(p.info.id, p.info.parentID ?? '');
          if (!p.info.parentID) await start(p.info.id, p.info.model?.id);
          return;
        case 'message.updated':
          return context(p.info);
        case 'message.part.updated':
          return said(p.part);
        case 'permission.asked': {
          const why = p.metadata?.command ?? p.metadata?.filepath ?? p.patterns?.join(' ') ?? p.permission;
          return ask(p.id, p.sessionID, { tool_name: p.permission, message: clip(why, 500) });
        }
        case 'question.asked':
          return ask(p.id, p.sessionID, { message: clip(p.questions?.[0]?.question ?? 'a question', 500) }, true);
        case 'permission.replied':
        case 'question.replied':
        case 'question.rejected':
          if (asking.delete(p.requestID)) show();
          return;
        case 'session.error':
          if (busy.has(p.sessionID)) {
            ending.set(p.sessionID, p.error?.name === 'MessageAbortedError' ? ['Interrupt']
              : ['StopFailure', { message: clip(p.error?.data?.message ?? p.error?.name ?? 'error', 500) }]);
          }
          return;
        case 'session.status': {
          // a turn that errs and goes on, as one does once an overflowed context is compacted, has not failed
          if (p.status?.type === 'busy') ending.delete(p.sessionID);
          if (p.status?.type !== 'idle' || !busy.delete(p.sessionID)) return;
          asking.clear();
          clearTimeout(showing);
          shown = undefined;
          const [name, fields] = ending.get(p.sessionID) ?? ['Stop'];
          ending.delete(p.sessionID);
          return void hook(name, p.sessionID, fields);
        }
      }
    },
    'chat.message': async (input, output) => {
      const id = input.sessionID;
      if (await parentOf(id)) return;
      const model = input.model?.modelID;
      await start(id, model);
      busy.add(id);
      const text = (output.parts ?? []).filter((x) => x.type === 'text' && !x.synthetic).map((x) => x.text).join('\n').trim();
      if (text) log(id, { kind: 'user', text });
      const reply = await hook('UserPromptSubmit', id, { prompt: text.slice(0, MAX_PROMPT), prompt_id: input.messageID ?? output.message?.id, ...(model && { model }) });
      if (reply) brief.set(id, reply);
    },
    'tool.execute.before': async (input, output) => {
      const root = await rootOf(input.sessionID);
      if (root === input.sessionID && input.tool === 'bash' && typeof output.args?.workdir === 'string') workdir = path.resolve(directory, output.args.workdir);
      if (!asking.size) void hook('PreToolUse', root, { tool_name: input.tool });
    },
    'tool.execute.after': async (input, output) => {
      const root = await rootOf(input.sessionID);
      if (root === input.sessionID) {
        log(root, { kind: 'tool', name: input.tool, given: clip(input.args, MAX_TOOL) });
        log(root, { kind: 'output', printed: clip(output?.output, MAX_TOOL) });
      }
      if (!asking.size) void hook('PostToolUse', root, { tool_name: input.tool });
    },
    // the same brief rides on every request of the session, so the prompt cache holds until it changes
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return;
      if (input.model?.limit?.context) limits.set(input.sessionID, input.model.limit.context);
      const text = brief.get(input.sessionID);
      if (text) output.system.push(text);
    },
    // OpenCode disposes of the plugin on a reload too, so svalld learns the agent has gone from the pane's shell
    dispose: async () => { clearTimeout(showing); conn?.end(); },
  };
};
