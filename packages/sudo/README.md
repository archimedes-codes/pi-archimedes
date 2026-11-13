# @pi-archimedes/sudo

**A little more care with root access.**

Interactive `sudo` inside an agent session is a mistake waiting to happen — it can deadlock the terminal and drag root credentials into the LLM's context. Sudo puts a deliberate step between the model and the password: the exact command and its reason for your eyes first, a masked prompt (never the chat) for the credential, and a guard that keeps the ordinary `bash` tool from driving interactive `sudo` at all.

## Install

Standalone:

```bash
pi install npm:@pi-archimedes/sudo
```

Or the full suite instead:

```bash
pi install npm:pi-archimedes
```

New to Pi? Pi itself is a one-time global install and needs Node.js ≥ 22.19.0:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

After installing Pi, choose one installation command above, then `cd` into your project and run `pi`. Inside the session, `/login` signs you in and `/model` picks a model — the [setup section](https://github.com/archimedes-codes/pi-archimedes#setup) covers the first run. `/reload` picks the extension up in a running session.

## What you get

- **`sudo_exec` tool** — runs a privileged command via `sudo -S`, showing the exact command and a human-readable **reason** for confirmation before any credential prompt appears. A declined confirmation means nothing runs and no password is requested.
- **Optional quieter confirmation** — `confirmWhenCached: false` skips the per-command confirmation while a credential is already cached, so an approved credential window is not interrupted by one dialog per privileged step. Off by default, and a skipped run says so in its own output — the first line of the tool result is `[sudo] confirmation skipped …`, so the terminal, the transcript and the model all see that nobody confirmed it ([ADR 0033](https://github.com/archimedes-codes/pi-archimedes/blob/main/docs/decisions/0033-sudo-confirmation-while-cached.md)).
- **Masked password prompt** — the password is typed into a masked UI and passed to sudo via stdin only. It is never in argv, environment variables, command logs, or the LLM context.
- **Defensive output scrubbing** — command output lines that contain the password are redacted before they reach the tool result. That is a literal-substring scrub: it catches common cases, and it is **not** universal leak protection.
- **Credential cache** — a single in-memory cache with a TTL (15 minutes by default, `ttlMs`); cleared on authentication failure, at `session_start`/`session_shutdown`, and by `/sudo forget`.
- **Timeout/abort cleanup** — on timeout or abort, the tool attempts to kill the command's entire process group, falling back to the direct sudo process, so root children, not just the direct sudo process, are the target of the cleanup. Deliberately detached descendants (`setsid`, daemonising) leave the process group and are outside its scope — use a flag to keep the child a process in the group (e.g. `--foreground`).
- **Headless sessions refused** — `sudo_exec` requires an interactive (TUI) session; subagent and headless sessions get a clear error instead of a prompt. The masked prompt only ever appears in front of a human.
- **Active bash guard** — a `tool_call` veto on the built-in `bash` tool (per [ADR 0010](https://github.com/archimedes-codes/pi-archimedes/blob/main/docs/decisions/0010-archimedes-sudo-security.md)) blocks interactive `sudo`, funneling privileged execution toward `sudo_exec`.

## Usage

### The `sudo_exec` tool

```jsonc
{
  "command": "apt install ripgrep",                    // exact argv string — no leading 'sudo'; no shell syntax (pipes, &&, redirects, env assignments)
  "reason": "ripgrep is needed for the search tooling", // required — shown before execution
  "timeoutMs": 120000                                   // optional override of config.defaultTimeoutMs
}
```

### The bash guard

The scanned `bash` commands:

- **Blocked:** `sudo` in command position without a no-prompt flag — including through runner wrappers (`env`, `nohup`, `timeout`, `xargs`, …), nested shells (`bash -c`, `su -c`), `eval`, compound keywords, and heredoc bodies.
- **Allowed:** sudo occurrences that carry a no-prompt flag (`-n`, `-l`, `-v`, `-K`, `-k`, `--non-interactive`, or merged short flags composed solely of those) — the scanner's allow-list exception, mirroring the typical non-interactive usage.

The guard is a **heuristic with accepted residual bypasses** documented in the [ADR 0010 design notes](https://github.com/archimedes-codes/pi-archimedes/blob/main/docs/decisions/0010-archimedes-sudo-security.md) — for example cross-token variable indirection, and `sudo` inside `$(...)`/backtick interpolation the word-position model cannot see. Over-blocking is the safe direction; the tested no-prompt flag set is a stable contract of the scanner, **not** a guarantee that no prompt can occur.

## Commands

- `/sudo` — report whether a credential is currently cached in memory.
- `/sudo forget` — flush the cached credential immediately.

## Settings

`~/.pi/agent/settings.json`, under `archimedes.sudo` — **JSON only**, no settings-panel UI in v1:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ttlMs` | number | `900000` | Password cache TTL in milliseconds (default 15 minutes) |
| `defaultTimeoutMs` | number | `120000` | `sudo_exec` default command timeout in milliseconds (default 120 seconds) |
| `confirmWhenCached` | boolean | `true` | Ask for confirmation before every `sudo_exec`, even with a cached credential. Set to `false` to confirm only when a password will be requested — that is, whenever the credential cache is empty — and skip it for a cached credential; the skipped run then starts its output with the `[sudo] confirmation skipped` marker and sets `confirmationSkipped: true` in the details. Keep `ttlMs` short if you enable this: the cache, not the session, is what bounds unattended privileged runs ([ADR 0033](https://github.com/archimedes-codes/pi-archimedes/blob/main/docs/decisions/0033-sudo-confirmation-while-cached.md)) |

### When the confirmation is skipped

With `confirmWhenCached: false`, a privileged command whose credential is already cached runs without a confirmation dialog. What stays true:

- A **cache miss** still confirms first and then asks for the password, so the run that creates the credential always has both a human click and a human password entry.
- The **command and reason** stay in the tool call, so the transcript still records exactly what was run and why.
- The run's own output starts with a line saying the confirmation was skipped, so a quiet run is visibly different from one you approved — in the terminal, in the transcript, and to the model. `details.confirmationSkipped` is the same fact for anything reading the session file.
- `/sudo forget`, `session_shutdown`, `ttlMs`, and an authentication failure all close the cache and bring the confirmation back.
- The window is per **process**, not per session: run more than one session in the same process — or a subordinate session inside it — and they share the cached credential, so that is the case to keep `ttlMs` short for ([ADR 0033](https://github.com/archimedes-codes/pi-archimedes/blob/main/docs/decisions/0033-sudo-confirmation-while-cached.md)).

### Credential handling when sudo retains no verifiable ticket

An authenticated but failed command is indistinguishable from an authentication failure unless the credential can be verified independently, so the tool runs two probes after a command-level failure:

1. **`sudo -n -v` (ticket probe)** — validates sudo's ticket, executes no program, needs no password.
2. **`sudo -S -v` (password probe)** — validates the **cached password** via stdin, executes no program. It runs **only when the ticket probe is non-terminal**, which is exactly the case it answers: hosts where no ticket is ever replayable — `timestamp_timeout=0` / no-reuse `Defaults`, or a tty-keyed timestamp (`timestamp_type=tty`, Ubuntu's default) against a spawn with no controlling terminal. On those hosts the ticket probe fails **even for a correct password**, so without stage 2 every command-level failure would read as an unverifiable credential.

Then:

- A **recognized wrong password** (sudo's `incorrect password` output alongside its prompt) clears the credential **immediately**, on that failure.
- **Either probe succeeding** means the credential is fine and the command itself failed: the run is reported as an ordinary non-zero exit and any carried strike is reset.
- The **two-strike rule** applies to **ambiguous** failures, i.e. both probes non-terminal: the first strike keeps the cached password (with a visible one-more-attempt warning), the second consecutive strike clears it and re-prompts. Success resets the streak, and transport failures don't count as strikes. A failed password probe is never treated as proof of a wrong password — only success is terminal — so a transient hiccup cannot discard a good credential.

## Part of the suite

In [pi-archimedes](https://github.com/archimedes-codes/pi-archimedes), the package is registered by the plugin manifest; the bash guard and `sudo_exec` are loaded in the main session and in subagent children — the guard still vetoes there, while `sudo_exec` itself refuses to run in headless mode. Standalone works independently. On/off is managed by the suite: toggle via `/plugins` (`archimedes.sudo.enabled`, default on).

← [Back to pi-archimedes](https://github.com/archimedes-codes/pi-archimedes)
