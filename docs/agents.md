# Agents

What Svall changes in how Claude Code, Codex and OpenCode run inside a robot.
[What setup changes](../README.md#what-setup-changes) lists the files it writes
for each.

## Claude Code

Robot shells start Claude Code in its fullscreen renderer
(`CLAUDE_CODE_NO_FLICKER=1`), which keeps its own scrollback through a resize,
even where Claude Code turned fullscreen off after failed starts. A `tui` key
in your Claude Code `settings.json`, such as `"tui": "default"`, keeps the
renderer it names.

## Codex

A Codex robot gets the same status, context gauge, revive, brief and scribe
as a Claude Code one. Codex runs only hooks you trust: choose "Trust all and
continue" on its startup dialog, or trust the hook later with `/hooks`, and do
so again whenever it changes. Until then the robot stays a plain shell with
a warning. `svall doctor` says whether the hook is trusted.

A plain `codex` runs on Codex's shared background server, whose hooks carry the
terminal that started that server, so Svall ignores them. A robot's zsh
starts from `~/.svall/zsh`, which hands startup back to your own files and makes
`codex` mean `codex --no-daemon`; the agents Svall starts and revives get the
flag too. In bash, fish, or a zsh started inside the robot, type
`codex --no-daemon` yourself, or the card asks for it.

## OpenCode

An OpenCode robot gets the same status, context gauge, revive, brief and
scribe as a Claude Code one. OpenCode has no hooks; Svall's plugin in
`~/.config/opencode/plugins` reports to it, needs no trust step, and does
nothing outside a robot. The brief rides along as system text. OpenCode
reports no plan limits, so the Usage panel shows none for it.

A robot's terminals run OpenCode with `OPENCODE_CONFIG_DIR` set to
`~/.svall/opencode-config`: links to your config beside a `service.json` that
turns OpenCode's shared background server off, so a plain `opencode` reports
too. A setting OpenCode saves there moves to `~/.config/opencode` when the next
robot window opens, and the copy it replaces, or the older one when yours
is newer, is kept in `~/.svall/opencode-config-replaced`. Run `opencode service`
and `opencode pair` outside a robot. Session tabs are off in a robot,
since every OpenCode in a folder shares one tab strip; `/sessions` still
switches. Change the tab mode outside a robot: set in one, it is saved but
has no effect there.
