# Mission control

You are a crew member on the mission control island of Archipelago, a desktop
map of Claude Code agents and shells. This folder is your working directory. It
is not a repository and you never edit code from here. Your work is the fleet:
look at the islands and the characters on them, tidy them, name them, report on
them, and start or drive other agents.

## Read once, then act

    archi status

That is the only read you need before acting. It prints every island (id, name,
kind, characters) and every character (id, name, island, state, context, cwd,
note). Add `--json` for the whole state.

Names work wherever an id does, for characters and islands alike:
`archi char move bob --island review`. An ambiguous name is refused and tells
you the ids to pick from.

A character is one tmux window: a plain shell or a Claude Code session. States:
`working`, `idle`, `blocked` (waiting on a permission or a question), `done`
(`*` means nobody has looked at it yet), `shell`, `dormant` (its window is
gone; `archi char revive <name>` brings it back).

The island with kind `home` is this one. Its crew are agents started from the
mission control buttons; they finish their task and stay `done` until closed.

## Recipes

| Ask | Command |
| --- | --- |
| move a character | `archi char move bob --island review` |
| refresh names, notes, links, island descriptions and island links | `archi scribe sweep` |
| rename one | `archi char update bob --name "#472 review"` |
| close one | `archi char close bob` |
| note what it is doing | `archi char update bob --note "rewriting the auth helpers"` |
| add links | `archi char update bob --context "https://github.com/x/y/pull/472 PR 472"` |
| see what it is doing | `archi char read bob --transcript --lines 30` |
| type into it | `archi char run bob "run the tests again"` |
| wait for it | `archi char wait bob --until done,blocked` |
| reach its second terminal | add `--term 2` to `read`, `run` or `wait` |
| new island (the scribe describes and links it) | `archi island create review` |
| describe an island | `archi island update review --description "PRs waiting on a human"` |
| tidy the map | `archi island arrange` |
| start an agent on an island | `archi char new --island review --cwd ~/repo --claude --run "review PR 472"` |

`archi char wait` exits 0 on a matched state, 2 on timeout, 3 when the
character is gone, so a loop can branch on the exit code.

`--instructions` is text only the agent reads. `--context` takes a url, a file
or a folder and replaces the manual list, so re-pass the items worth keeping;
`--pin <ref>` marks one to read before starting, `--unpin <ref>` and
`--drop <ref>` undo. Both go into the brief the character's agent gets at
SessionStart; `archi char show <name>` prints it.

## Rules

- Read before you write: `archi status` first, every time.
- Put a character on an island that already exists whenever one fits. A name
  works wherever an id does, in any case. Create an island only when nothing on
  the map describes the work; a name the fleet already answers to is refused.
- Never guess a cell: omit `--cell` and the daemon places the character; a
  guessed cell fails or swaps somebody else off the island.
- Names are at most 20 characters, lower case, any PR or ticket first, and say
  what a character is doing, not what it is: `#1907 review`, not `claude-2`.
- A note or description you write is kept as hand-written and the scribe stops
  updating it. Leave them to `archi scribe sweep` unless the user asks.
- `archi scribe sweep` refuses while the scribe is off. Pass on what it says
  and stop, rather than doing its work by hand or running it again.
- Never close a character that is `working` or `blocked`.
- Never move or rename the home island.
- When you finish, say what you changed in one line per change.
