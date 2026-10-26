// Svall's plugin for OpenCode, which svalld writes into OpenCode's plugins folder and OpenCode loads into every server.
// Inside a Svall robot it reports the session to svalld as hook events, gives the agent its brief as system text,
// and logs the session for Svall to read.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
const IDLE_MS = 1000;
// the TUI kills its server 3 s after asking it to stop
const LEAVE_MS = 2000;
const MAX_PROMPT = 4000;
const MAX_TOOL = 2000;
const clip = (v, n) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, n);

// Svall resumes a dormant robot with `opencode --standalone -s <id>`, and its private server runs plugins as a
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

// OpenCode has no Monitor tool, so a shell sent to the background is how an agent watches; each running one by its
// top-level session. A moved session's two instances run in one process, and one can start a shell whose turn the other ends
const monitors = new Map();
// a command that ends at once can exit before its tool call has returned
const exited = new Set();

// the top-level sessions the shared service has had a prompt for; OpenCode imports the plugin again for each location
// and after each change to it, so the set is kept on the process
const prompted = (globalThis[Symbol.for(`svall.prompted.${VARIANT}`)] ??= new Set());

// the shared service, as it starts, resumes every turn a server's end cut short, a robot's included, and wakes a session
// whose background job it recovers; a robot's session it runs unprompted is running outside Svall, so it is interrupted
async function serve(ctx) {
  const roots = new Map();
  const rootOf = async (id) => {
    if (!roots.has(id)) {
      const parent = (await ctx.session.get({ sessionID: id }).catch(() => undefined))?.parentID;
      roots.set(id, parent ? await rootOf(parent) : id);
    }
    return roots.get(id);
  };
  // a robot's session is one this build's plugin logged in a fleet home
  const robots = (id) => {
    let homes = [];
    try { homes = fs.readdirSync(os.homedir()).filter((f) => /^\.svall(-[a-z][a-z0-9-]*)?$/.test(f) && variantOf(f) === VARIANT); } catch {}
    return homes.some((h) => fs.existsSync(path.join(os.homedir(), h, 'transcripts', 'opencode', `${id}.jsonl`)));
  };
  const guard = async (e) => {
    const root = await rootOf(e.sessionID);
    if (prompted.has(root) || !robots(root)) return;
    process.stderr.write(`svall: interrupted ${e.sessionID}, a Svall robot's session that OpenCode's service ran unprompted\n`);
    await ctx.session.interrupt({ sessionID: e.sessionID }).catch(() => {});
  };
  await ctx.session.hook('prompt', async (e) => { prompted.add(await rootOf(e.sessionID)); });
  // a compaction due at a run's first step asks the model before the context hook runs
  await ctx.session.hook('compaction', guard);
  await ctx.session.hook('context', guard);
}

async function setup(ctx) {
  // the shared background service serves every session of the user, whatever pane started it
  if (process.argv.includes('--service')) return serve(ctx);
  // a session an older svalld started carries SVALL_CHAR_ID
  const robotId = process.env.SVALL_ROBOT_ID ?? process.env.SVALL_CHAR_ID;
  const home = process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
  if (!robotId || variantOf(home) !== VARIANT) return;
  // worktree_create puts a worktree in OpenCode's data folder, away from the repository; without it the agent makes
  // one inside the main checkout, as its brief says. An OpenCode that refuses keeps the tool, and the hooks below still go on
  try {
    await ctx.tool.transform((t) => t.remove('opencode_worktree_create'));
  } catch (e) {
    process.stderr.write(`svall: OpenCode kept opencode_worktree_create for this robot's agent: ${e?.message ?? e}\n`);
  }
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
  // shell runs where its call says and a session goes where a move takes it, so the newest directory either names is
  // where the agent works
  let workdir;
  const hook = (name, session, fields = {}) => send({
    robotId, term, backend: 'opencode', pid,
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
  // top-level sessions whose turn svalld has heard start and not end, each with its prompt's number
  const turns = new Map();
  let prompts = 0;
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
  // OpenCode forgets the questions of a run that stops before they are answered, and says nothing of it
  const drop = (session) => { for (const [id, a] of asking) if (a.session === session && asking.delete(id)) show(); };

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
    const file = path.join(home, `${robotId}.prompt`);
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
    void send({ robotId, term, status: { sessionId: id, contextPct: Math.round((used / max) * 100), model: model.id } });
  };

  const watching = (root) => ({ background_tasks: [...monitors].flatMap(([shell, r]) => (r === root ? [{ type: 'shell', id: shell }] : [])) });
  // a child session's runs report as a subagent's under the top-level session; one can run again and outlive its parent's turn.
  // A shell wakes the session that started it, so a subagent's run ends with the shells listed too
  const subagent = async (id, name) => {
    if (!(await parentOf(id))) return;
    const root = await rootOf(id);
    void hook(name, root, { agent_id: id, ...(name === 'SubagentStop' && watching(root)) });
  };
  const end = async (id, name, fields) => {
    if (await parentOf(id)) {
      drop(id);
      return subagent(id, 'SubagentStop');
    }
    turns.delete(id);
    asking.clear();
    clearTimeout(showing);
    shown = undefined;
    void hook(name, id, { ...fields, ...watching(id) });
  };
  const on = (type, p) => {
    if (type === 'permission.asked' || type === 'permission.replied') heard?.add(p.id ?? p.requestID);
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
      case 'session.execution.started':
        return subagent(p.sessionID, 'SubagentStart');
      case 'session.text.ended':
        if (started.has(p.sessionID) && p.text?.trim()) log(p.sessionID, { kind: 'agent', text: p.text.trim() });
        return;
      case 'permission.asked':
        return ask(p.id, p.sessionID, { tool_name: p.action, message: clip(p.resources?.join(' ') || p.action, 500) });
      case 'form.created':
        // an MCP server's form belongs to no session
        if (p.form?.metadata?.kind !== 'question' && p.form?.metadata?.kind !== 'websearch.provider') return;
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
      case 'session.deleted':
        return drop(p.sessionID);
      case 'shell.exited':
      case 'shell.deleted':
        exited.add(p.id);
        monitors.delete(p.id);
        return;
      // the moved session runs on in its new folder's own instance of this plugin, but this one still ends its turn
      case 'session.moved':
        return parentOf(p.sessionID).then((parent) => { if (!parent && p.location?.directory) workdir = p.location.directory; });
    }
  };
  const quit = new AbortController();
  const later = (ms, value) => sleep(ms, value, { signal: quit.signal, ref: false });
  // a session's wait resolves once it is idle; one at a time, however many resyncs ask
  const waits = new Map();
  const idle = (id) => {
    if (!waits.has(id)) waits.set(id, ctx.session.wait({ sessionID: id }).then(() => true, () => false).finally(() => waits.delete(id)));
    return waits.get(id);
  };
  // permissions the stream asks or answers while a resync reads the list, which may predate them
  let heard;
  // what a new subscription can't hear, read once it has started: a turn that ended, and permissions asked or answered;
  // forms and shells have no list, so a shell that may have exited meanwhile is let go. A turn idle now ends a moment late,
  // unless the stream ends it or a new prompt starts first
  const resync = async () => {
    await later(0);
    monitors.clear();
    for (const [id, n] of turns) {
      void Promise.race([idle(id), later(IDLE_MS, false)]).then((now) => now && later(SHOW_MS, true))
        .then((now) => { if (now && turns.get(id) === n) return end(id, 'Stop'); }, () => {});
    }
    heard = new Set();
    const before = [...asking].filter(([, a]) => !a.question).map(([id]) => id);
    const open = (await Promise.all([...parents.keys()].map((id) => ctx.permission.list({ sessionID: id }).catch(() => [])))).flat();
    const since = heard;
    heard = undefined;
    if (quit.signal.aborted) return;
    for (const id of before) if (!since.has(id) && !open.some((p) => p.id === id)) asking.delete(id);
    for (const p of open) if (!since.has(p.id) && !asking.has(p.id)) on('permission.asked', p);
    show();
  };
  // OpenCode fails the stream of every plugin on one event it can't encode, as another plugin's malformed RPC event,
  // and the hooks go on
  void (async () => {
    for (let retry = 0; !quit.signal.aborted;) {
      if (retry) void resync().catch(() => {});
      try {
        for await (const e of ctx.event.subscribe({ signal: quit.signal })) {
          retry = 0;
          await Promise.resolve(on(e.type, e.data ?? {})).catch(() => {});
        }
      } catch {}
      retry = Math.min(retry * 2 || 1000, 30_000);
      await later(retry).catch(() => {});
    }
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
    // the turn starts once this hook returns; until then the session is idle
    turns.set(id, ++prompts);
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
    const { status, shellID } = e.result?.metadata ?? {};
    const watcher = e.tool === 'shell' && status === 'running' && typeof shellID === 'string' && !exited.has(shellID);
    if (watcher) monitors.set(shellID, root);
    if (!asking.size) void hook('PostToolUse', root, { tool_name: e.tool, ...(watcher && { task_id: shellID }) });
  });

  // the TUI stops its server with SIGTERM or by closing its stdin, where a reload only sets the plugin up again; the shared
  // service would resume a turn the stop cuts short, so each is interrupted first
  let left;
  const leave = () => { left ??= Date.now(); };
  process.on('SIGTERM', leave);
  process.stdin.once('end', leave);

  // a quit TUI takes its server with it, so svalld learns the agent has gone from the pane's shell
  return async () => {
    quit.abort(); clearTimeout(showing); conn?.end();
    process.off('SIGTERM', leave);
    process.stdin.off('end', leave);
    // OpenCode's teardown can begin inside the signal or EOF before this plugin's listener has run
    await null;
    if (process.stdin.readableEnded || process.stdin.destroyed) leave();
    if (left === undefined) return;
    const stop = (ids, by) => Promise.race([
      Promise.all(ids.map((id) => ctx.session.interrupt({ sessionID: id }).then(() => ctx.session.wait({ sessionID: id })).catch(() => {}))),
      sleep(Math.max(0, by - Date.now()), undefined, { ref: false }),
    ]);
    // a subagent's end wakes its parent, so subagents stop first, within half the time, and top-level sessions after
    const ids = [...parents.keys()];
    await stop(ids.filter((id) => parents.get(id)), left + LEAVE_MS / 2);
    await stop(ids.filter((id) => !parents.get(id)), left + LEAVE_MS);
  };
}

// OpenCode keeps only the first of two plugins with one id, so each build has its own
export default { id: VARIANT === 'release' ? 'svall' : 'svall-dev', setup };
