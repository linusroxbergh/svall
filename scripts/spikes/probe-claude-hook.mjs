#!/usr/bin/env node
// Manual: an M0 spike probe (docs/fleet-handover/spike-results.md), run by hand; no build or CI runs it.

// Records only session identity and transcript location from a disposable hook run.
import fs from 'node:fs';

const output = process.env.SVALL_CLAUDE_HOOK_PROBE;
if (!output) process.exit(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
fs.appendFileSync(output, `${JSON.stringify({
  hookEventName: payload.hook_event_name,
  sessionId: payload.session_id,
  transcriptPath: payload.transcript_path,
})}\n`, { mode: 0o600 });
