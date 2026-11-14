---
status: accepted
date: 2026-11-12
superseded-by:
---

# Let a user opt out of per-command confirmation while a credential is cached

`sudo_exec` confirms every command (ADR 0010): the exact argv and the model's stated reason are shown, and a declined confirmation means nothing runs and no password is requested. That gate is the human boundary between the model and root, and it survives caching on purpose — the password prompt disappears after the first successful entry, so the confirmation is the *only* thing left between an agent acting on its own and a privileged command.

The cost is visible in long unattended work. A task that legitimately needs several privileged steps — install a package, restart a unit, fix an ownership, run the resulting command — produces one dialog per step, all inside a credential window the user already opened by typing the password. In practice the run stalls at each dialog until the human notices, and the dialogs are indistinguishable to the user: same title, same shape, differing only in the command text. A user who cached a password for the session has already made a much larger grant than one more confirmation.

We decided to make the extra confirmations a **setting, defaulting to today's behaviour**:

```jsonc
// ~/.pi/agent/settings.json
{ "archimedes.sudo": { "confirmWhenCached": false } }
```

- `true` (default) — unchanged: confirm every `sudo_exec`.
- `false` — confirm only when the run would ask for a password. With a credential already cached, the gate is skipped and the result records `confirmationSkipped: true` in the tool details.

Nothing else moves. A cache miss still confirms **and** prompts, in that order, so the first privileged command **against a fresh cache** always has a human click and a human password entry — the first command of a session, unless an earlier session in the same process left a credential behind, which is the case the Consequences below spell out. The exact command and reason remain in the tool call, which is in the transcript and in the session audit. The bridge path (a user-paced Client modal) follows the same rule rather than keeping a second policy.

A skipped gate must be distinguishable from a passed one after the fact, and it has to be distinguishable where anyone actually looks. `details.confirmationSkipped` is the machine-readable record in the session file; the run's own output text carries the same fact, because that is the only channel a human at the terminal and the model both read — this tool registers no result renderer, so pi's tool-result fallback prints `content[].text` alone, and both provider transforms rebuild a tool result from `content`, dropping `details`. Without the text, a run nobody approved is word-for-word what an approved one looks like, and the model keeps phrasing later calls as if someone were still confirming them.

**Considered Options**

- **Skip the confirmation whenever a credential is cached, unconditionally.** This is what the setting does when enabled, and it is the behaviour a few users asked for — rejected as the default: it silently removes the last human gate for every existing user, and a password typed for one command would authorize an open-ended series of others. Opt-in keeps the decision with the person who bears the risk.
- **A time-based rule (confirm the first N minutes, then stop).** Rejected: unobservable, hard to explain, and it turns "how long ago did I type that" into the policy instead of "am I comfortable with unattended root commands". `ttlMs` already bounds the window; the confirmation policy should not silently vary inside it.
- **Skip only for a repeated identical command.** Rejected: the agent rarely repeats byte-identical commands (paths and package names change), so the improvement would be near zero, while accumulating hidden per-command allow-list state.
- **Drop `confirmationSkipped` and infer it from "no confirm happened".** Rejected: the tool cannot see whether a human approved it, and a consumer of `details` needs a positive statement, not an absence.
- **Make it a per-run tool parameter.** Rejected: it would let the model choose to skip the human gate for itself, which is exactly the boundary this gate exists to hold. Configuration is the user's, not the model's.

**Consequences**

Users who opt out get an uninterrupted privileged sequence inside one credential window, and accept that an agent can run root commands unattended until the cache is cleared (`ttlMs`, `/sudo forget`, `session_shutdown`, or an auth failure).

The window is per **process**, not per session, and this setting makes that visible in a way it was not before. `credentialCache` is a module-level singleton and pi caches an extension module per process, re-invoking the factory per session; the only thing separating two sessions is the unconditional `session_start`/`session_shutdown` clears. So in a process that hosts a subordinate in-process session, that session inherits the cached credential — and can now skip the gate on it, in a session whose human never typed that password. Before this setting the worst outcome of that sharing was mistiming a prompt, which is why the earlier research note classified it as harmless. The structural remedy is a session-keyed cache (`docs/features/session-state.md`), and it is deliberately **not** part of this change: it alters the cache's identity, not the confirmation policy. Until then, the honest advice is to keep `ttlMs` short when enabling `confirmWhenCached: false`, and the README says so. The setting is a single boolean under the existing `archimedes.sudo` namespace, so it needs no settings-panel work and no migration; absent means "confirm", which keeps every existing configuration exactly as it was. The README now pairs the setting with the advice to keep `ttlMs` short when it is enabled. Coverage pins every return that funnels through `gated()` rather than a sample of them: default path (text byte-identical, no marker, no flag), skip path (success, failed with no stdout, timed out, transport error, strike 1 with the unverified warning after the marker, strike 2 clearing the cache), the cache-miss path that must still confirm, and the bridge path in both channels; the default value is pinned in `config.test.ts`.
