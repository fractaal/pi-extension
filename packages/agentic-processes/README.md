# @ryan_nookpi/pi-extension-agentic-processes

Agentic process lifecycle tools for Pi.

This package canonicalizes Ben's personal `bash-backgrounding.ts` and
`monitor.ts` hooks into one reusable extension package. It preserves the public
LLM tool surface while the implementation grows a headless management core that
ALR and future Pi TUI controls can call.

Registered tools:

- `bash`
- `bash_output`
- `bash_tasks`
- `kill_bash`
- `monitor_start`
- `monitor_status`
- `monitor_list`
- `monitor_stop`

Current behavior is intentionally parity-first: process execution, output logs,
foreground/background timing, monitor guardrails, and stop semantics should stay
compatible with the original personal Pi hooks.
