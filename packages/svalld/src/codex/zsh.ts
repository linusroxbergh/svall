import fs from 'node:fs';
import path from 'node:path';

// zsh reads $ZDOTDIR/.zshenv first: this one restores the user's ZDOTDIR, so the rest of startup is theirs, and gives the
// interactive shell a codex off Codex's shared server, which agents, queue, remote-control and --remote need
const ZSHENV = `# Svall: a robot's zsh reads this first
if (( \${+SVALL_ZDOTDIR} )); then ZDOTDIR=$SVALL_ZDOTDIR; else unset ZDOTDIR; fi
unset SVALL_ZDOTDIR
[[ -r \${ZDOTDIR:-$HOME}/.zshenv ]] && source \${ZDOTDIR:-$HOME}/.zshenv
if [[ -o interactive ]]; then
  function codex {
    local a
    case $1 in agents|queue|remote-control) command codex "$@"; return ;; esac
    for a in "$@"; do
      case $a in
        --) break ;;
        --no-daemon|--remote|--remote=*) command codex "$@"; return ;;
      esac
    done
    command codex --no-daemon "$@"
  }
fi
`;

/** Writes the ZDOTDIR `dir` a robot's zsh starts from, and answers the env that points zsh at it. */
export function codexZshEnv(dir: string, inherited: string | undefined = process.env.ZDOTDIR): Record<string, string> {
  const file = path.join(dir, '.zshenv');
  // checked on every window: without the file, zsh would skip the user's own startup files
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== ZSHENV) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, ZSHENV);
    fs.renameSync(`${file}.tmp`, file);
  }
  return { ZDOTDIR: dir, ...(inherited !== undefined && inherited !== dir ? { SVALL_ZDOTDIR: inherited } : {}) };
}
