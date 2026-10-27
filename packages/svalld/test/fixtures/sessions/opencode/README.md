# OpenCode session exports

`2.1.1/` holds a real `opencode session export --standalone <id>` from OpenCode 2.1.1 on macOS. The
session ran as `opencode run --standalone -m vercel/openai/gpt-6-luna --auto` in a disposable
`work/demo`, asked to remember a code word, run `pwd` and change `alpha` to `beta` in `notes.txt`, and
was deleted afterwards with `opencode session delete --standalone <id>`. On that build, an export of
the deleted id printed `Session not found: <id>` and exited 1; `session import --standalone
--directory <dir>` of the export printed `Imported session: <id>`, and the same import again printed
`Session already exists` to stderr and exited 0.

It was sanitized by replacing the home and probe paths with `/Users/source`, emails with
`user@example.invalid`, encrypted reasoning with a placeholder, and any string over 600 characters
with its first 200. Keys and structure are as OpenCode wrote them. `test/sessions/adapters.test.ts`
runs the session adapter's reads of an export against it: the message ids, `info.revert` and
`info.location.directory`.
