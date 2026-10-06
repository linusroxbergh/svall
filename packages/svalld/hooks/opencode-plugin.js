// Svall's plugin for OpenCode, which svalld writes into OpenCode's plugins folder and OpenCode loads into every server.
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

// Svall resumes a dormant character with `opencode --standalone -s <id>`, and its private server runs plugins as a
// child process, so the TUI's command line is read from ps, where a prompt's words pass for flags
const resumedFrom = (argv) => {
  const end = argv.indexOf('--prompt');
  const i = argv.findIndex((a, j) => /^(-s|--session)(=|$)/.test(a) && (end === -1 || j < end));
  const id = i === -1 ? undefined : argv[i].split('=')[1] ?? argv[i + 1];
  return /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id ?? '') ? id : undefined;
};
const commandLine = () => {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/); } catch { return []; }
};

async function setup(ctx) {
  const charId = process.env.SVALL_CHAR_ID;
  const home = process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
  // the shared background service serves every session of the user, whatever pane started it
  if (!charId || variantOf(home) !== VARIANT || process.argv.includes('--service')) return;
  const directory = ctx.location.directory;
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
    const drop = () => { if (conn === s) conn = undefined; for (const r of replies.splice(0)) r(undefined); };
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

  // the agent is the TUI, whose private server this is
  const pid = process.ppid;
  // shell runs where its call says, so the newest directory one names is where the agent works
  let workdir;
  const hook = (name, session, fields = {}) => send({
    charId, term, backend: 'opencode', pid,
    hook: { hook_event_name: name, session_id: session, transcript_path: logOf(session), cwd: workdir ?? directory, ...fields },
  }, name === 'SessionStart' || name === 'UserPromptSubmit');

  // a subagent works in a child session; its parent is looked up once, '' for a top-level session
  const parents = new Map();
  const parentOf = async (id) => {
    if (!parents.has(id)) parents.set(id, (await ctx.session.get({ sessionID: id }).catch(() => undefined))?.parentID ?? '');
    return parents.get(id);
  };
  const rootOf = async (id) => { for (let p = await parentOf(id); p; p = await parentOf(id)) id = p; return id; };

  const brief = new Map();
  const started = new Map();
  const models = new Map();
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
  const start = (id) => {
    if (!started.has(id)) {
      parents.set(id, '');
      started.set(id, (async () => {
        try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(logOf(id), ''); } catch {}
        const model = models.get(id)?.id;
        const text = await hook('SessionStart', id, model ? { model } : {});
        if (text) brief.set(id, text);
      })());
    }
    return started.get(id);
  };

  // a /command runs as the TUI runs one typed; sent as a prompt, the model would read it as text
  const wake = async (id, text) => {
    const [, command, args = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim()) ?? [];
    const known = command && (await ctx.command.list().catch(() => undefined))?.data?.some((c) => c.name === command);
    const sent = known ? ctx.session.command({ sessionID: id, name: command, text: args }) : ctx.session.prompt({ sessionID: id, text });
    await sent.catch(() => {});
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

  // the TUI's own reading: the last step's tokens over the model's context window; a model the list lacks, as one from
  // a provider signed in to since, has the list read again
  let limits;
  const limitOf = async (m) => {
    limits ??= ctx.model.list().then((r) => new Map((r?.data ?? []).map((x) => [`${x.providerID}/${x.id}`, x.limit?.context])), () => undefined);
    const max = (await limits)?.get(`${m.providerID}/${m.id}`);
    if (!max) limits = undefined;
    return max;
  };
  const context = async (id, t) => {
    const model = models.get(id);
    if (!started.has(id) || !model || !t?.output) return;
    const max = await limitOf(model);
    if (!max) return;
    const used = t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    void send({ charId, term, status: { sessionId: id, contextPct: Math.round((used / max) * 100), model: model.id } });
  };

  // a subagent's run ends inside its parent's turn
  const end = async (id, name, fields) => {
    if (await parentOf(id)) return;
    asking.clear();
    clearTimeout(showing);
    shown = undefined;
    void hook(name, id, fields);
  };
  const on = (type, p) => {
    switch (type) {
      case 'session.created':
        parents.set(p.sessionID, p.parentID ?? '');
        if (p.model) models.set(p.sessionID, p.model);
        if (!p.parentID) return start(p.sessionID);
        return;
      case 'session.model.selected':
      case 'session.step.started':
        if (p.model) models.set(p.sessionID, p.model);
        return;
      case 'session.step.ended':
        return context(p.sessionID, p.tokens);
      case 'session.text.ended':
        if (started.has(p.sessionID) && p.text?.trim()) log(p.sessionID, { kind: 'agent', text: p.text.trim() });
        return;
      case 'permission.asked':
        return ask(p.id, p.sessionID, { tool_name: p.action, message: clip(p.resources?.join(' ') || p.action, 500) });
      case 'form.created':
        if (p.form?.metadata?.kind !== 'question') return;
        return ask(p.form.id, p.form.sessionID, { message: clip(p.form.fields?.[0]?.description ?? 'a question', 500) }, true);
      case 'permission.replied':
        if (asking.delete(p.requestID)) show();
        return;
      case 'form.replied':
      case 'form.cancelled':
        if (asking.delete(p.id)) show();
        return;
      case 'session.execution.succeeded':
        return end(p.sessionID, 'Stop');
      case 'session.execution.failed':
        return end(p.sessionID, 'StopFailure', { message: clip(p.error?.message ?? p.error?.type ?? 'error', 500) });
      // an Esc, a refused permission and a quit all interrupt
      case 'session.execution.interrupted':
        return end(p.sessionID, 'Interrupt');
    }
  };
  const quit = new AbortController();
  void (async () => {
    try { for await (const e of ctx.event.subscribe({ signal: quit.signal })) await Promise.resolve(on(e.type, e.data ?? {})).catch(() => {}); } catch {}
  })();

  await ctx.session.hook('prompt', async (e) => {
    const id = e.sessionID;
    if (await parentOf(id)) return;
    await start(id);
    const text = e.prompt?.text?.trim() ?? '';
    if (text) log(id, { kind: 'user', text });
    const model = models.get(id)?.id;
    const reply = await hook('UserPromptSubmit', id, { prompt: text.slice(0, MAX_PROMPT), prompt_id: e.messageID, ...(model && { model }) });
    // svalld answers each prompt with the brief there is, an empty one included; a lost answer changes nothing
    if (reply !== undefined) brief.set(id, reply);
  });
  // the same brief rides on every request of the session, so the prompt cache holds until it changes. A session this
  // instance has not seen, as after OpenCode reloads the plugin, reports in first
  await ctx.session.hook('context', async (e) => {
    if (!started.has(e.sessionID) && !(await parentOf(e.sessionID))) await start(e.sessionID);
    const text = brief.get(e.sessionID);
    if (text) e.system.push({ type: 'text', text });
  });
  await ctx.tool.hook('execute.before', async (e) => {
    const root = await rootOf(e.sessionID);
    if (root === e.sessionID && e.tool === 'shell' && typeof e.input?.workdir === 'string') workdir = path.resolve(directory, e.input.workdir);
    if (!asking.size) void hook('PreToolUse', root, { tool_name: e.tool });
  });
  await ctx.tool.hook('execute.after', async (e) => {
    const root = await rootOf(e.sessionID);
    if (root === e.sessionID) {
      log(root, { kind: 'tool', name: e.tool, given: clip(e.input, MAX_TOOL) });
      log(root, { kind: 'output', printed: clip(e.result?.content?.map((c) => c.text ?? '').join('\n') ?? e.error?.message, MAX_TOOL) });
    }
    if (!asking.size) void hook('PostToolUse', root, { tool_name: e.tool });
  });

  // a quit TUI takes its server with it, so svalld learns the agent has gone from the pane's shell
  return () => { quit.abort(); clearTimeout(showing); conn?.end(); };
}

// OpenCode keeps only the first of two plugins with one id, so each build has its own
export default { id: VARIANT === 'release' ? 'svall' : 'svall-dev', setup };
