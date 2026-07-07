# Agentic QoL Canonicalization Plan

This document fixes the package boundaries for Ben's personal Pi hooks that are being promoted into reusable Pi packages and shared with Aria Local Runtime (ALR). The goal is behavior parity first: move code out of copied/ad-hoc locations without changing what users or models observe.

## Scope

Canonicalize these four personal Pi hooks:

- `bash-backgrounding.ts`
- `monitor.ts`
- `codex-usage-info.ts`
- `fractal-compact.ts`

Leave these personal-only hooks ad-hoc for this pass:

- `auto-prerender.ts`
- `auto-rename.ts`

## Chosen package split

### 1. `@ryan_nookpi/pi-extension-agentic-processes`

Owns:

- Bash background task lifecycle tools: `bash`, `bash_output`, `bash_tasks`, `kill_bash`
- Monitor lifecycle tools: `monitor_start`, `monitor_status`, `monitor_list`, `monitor_stop`
- Shared headless management core for background tasks and monitors
- Optional event publishing adapters used by ALR and future TUI management UI

Why this boundary exists:

- Bash backgrounding and monitor are one lifecycle/evidence problem: start long-running local work, preserve full output, expose bounded context, list/status/read/stop it later, and emit updates without coupling to UI.
- A single core prevents copied process-group, log-spooling, output-cap, and task-registry semantics from drifting between personal Pi and ALR.
- The simpler alternative — two unrelated packages/files — would duplicate the management API and make UI integration call two incompatible surfaces for the same kind of live local work.

Headless API requirement:

- Core APIs must be usable without Pi TUI or ALR UI objects.
- The LLM tools should be thin wrappers over the core.
- ALR live-task events and future Pi TUI controls should subscribe to/core-call the same task/monitor manager instead of reimplementing lifecycle logic.

Parity obligations:

- Preserve all existing tool names, schemas, prompt snippets/guidelines, output details, completion behavior, log paths, guardrails, status/list caps, and process-group stop behavior.
- Preserve ALR event emissions currently added by copied builtins:
  - `aria-local:background-task-update`
  - `aria-local:monitor-update`
- Normalize monitor prompt guidance to Ben's approved contract: bash owns real long-running processes; monitor is for sparse filtered signal watching.

### 2. `@ryan_nookpi/pi-extension-codex-usage-info`

Owns:

- Codex/OpenAI usage and rate-limit statusline behavior
- Existing hooks: `session_start`, `session_tree`, `model_select`, `session_shutdown`

Why this boundary exists:

- Codex usage is provider/account-specific status UI. It does not share execution lifecycle state with bash tasks or monitors.
- Keeping it separate avoids forcing ALR or non-Codex Pi users to load ChatGPT/Codex usage polling just to get process-management tools.
- The simpler alternative — bundle it into an all-in-one QoL package — couples unrelated credentials/network behavior to core process management.

Parity obligations:

- Preserve current personal Pi status key, refresh/caching/error behavior, rendering text, and clear-on-shutdown behavior.
- ALR has no current copied `codex-usage-info` implementation, so ALR wiring is optional unless a later consumer is explicitly introduced.

### 3. `@ryan_nookpi/pi-extension-fractal-compact`

Owns:

- Ben/Fractal custom compaction policy and prompt
- Goal-continuation compaction handling
- Optional ALR compaction-status event adapter

Why this boundary exists:

- Fractal compact is a policy/model-call extension, not a process-management extension.
- Its main dependency surface is `completeSimple`, conversation serialization, selected model/reasoning, and compaction lifecycle hooks.
- ALR currently has only a tiny status-event stub for this name; the canonical package must support that event behavior while preserving the real personal Pi compaction implementation.

Parity obligations:

- Preserve the personal Pi `session_before_compact` replacement behavior and prompt semantics.
- Preserve ALR's `aria-local:compaction-update` running/completed event behavior when ALR enables that adapter.

## Git/npm distribution rule

Prefer git-based consumption so no npm publish is needed for this migration. If npm publishing turns out to be required for either personal Pi or ALR to consume these packages cleanly, stop and ask Ben because publish credentials/approval are required.

Implementation should keep the packages in this `pi-extension` monorepo following the existing package format:

```text
packages/<name>/
  package.json
  index.ts
  README.md
  tests as needed
```

If consuming workspace packages directly from a git ref is not viable for ALR, add deliberate root-package exports or a root Pi manifest strategy rather than silently falling back to copied source.

## Non-goals

- Do not migrate `auto-prerender.ts` or `auto-rename.ts` in this pass.
- Do not build ALR UI or Pi TUI management UI in this pass.
- Do not change model/provider behavior unrelated to these extensions.
- Do not introduce a taxonomy of task types beyond what a live management API actually needs.
