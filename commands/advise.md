---
description: Ask a non-Claude advisor for decisive guidance at a decision point. Returns a plan, a correction, or a stop signal.
---

Ask the `cursed:cursed-worker` subagent to forward this advise request. (The agent is plugin-namespaced — use the exact id `cursed:cursed-worker` with the Agent tool.)

Usage:
  /cursed:advise "<question text>"
  /cursed:advise "<question>" --context-file <path>
  /cursed:advise "<question>" --models <model-name>
  /cursed:advise "<question>" --resume-last        # continue prior session

Dispatch to `cursed:cursed-worker`. The subagent returns a SoloRunResult (advise is solo-only):

- If `run.status === "completed"`: print `run.text`, then a footer with model used + duration.
- If `run.status === "failed"`: print `run.error.code` + `run.error.message`; mention `run.transcript_path`; suggest remediation from master design §14.
