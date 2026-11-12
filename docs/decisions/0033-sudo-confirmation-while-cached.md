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

Nothing else moves. A cache miss still confirms **and** prompts, in that order, so the first privileged command of a session always has a human click and a human password entry. The exact command and reason remain in the tool call, which is in the transcript and in the session audit. The bridge path (a user-paced Client modal) follows the same rule rather than keeping a second policy.

`confirmationSkipped` exists because a skipped gate must be distinguishable from a passed one after the fact: without it, the transcript of a quiet run looks identical to a run the user approved line by line.

**Considered Options**

- **Skip the confirmation whenever a credential is cached, unconditionally.** This is what the setting does when enabled, and it is the behaviour a few users asked for — rejected as the default: it silently removes the last human gate for every existing user, and a password typed for one command would authorize an open-ended series of others. Opt-in keeps the decision with the person who bears the risk.
- **A time-based rule (confirm the first N minutes, then stop).** Rejected: unobservable, hard to explain, and it turns "how long ago did I type that" into the policy instead of "am I comfortable with unattended root commands". `ttlMs` already bounds the window; the confirmation policy should not silently vary inside it.
- **Skip only for a repeated identical command.** Rejected: the agent rarely repeats byte-identical commands (paths and package names change), so the improvement would be near zero, while accumulating hidden per-command allow-list state.
- **Drop `confirmationSkipped` and infer it from "no confirm happened".** Rejected: the tool cannot see whether a human approved it, and a consumer of `details` needs a positive statement, not an absence.
- **Make it a per-run tool parameter.** Rejected: it would let the model choose to skip the human gate for itself, which is exactly the boundary this gate exists to hold. Configuration is the user's, not the model's.

**Consequences**

Users who opt out get an uninterrupted privileged sequence inside one credential window, and accept that an agent can run root commands unattended until the cache is cleared (`ttlMs`, `/sudo forget`, `session_shutdown`, or an auth failure). The setting is a single boolean under the existing `archimedes.sudo` namespace, so it needs no settings-panel work and no migration; absent means "confirm", which keeps every existing configuration exactly as it was. The README now pairs the setting with the advice to keep `ttlMs` short when it is enabled. Coverage: the default path, the skip path (success and failure), the cache-miss path that must still confirm, and the bridge path are pinned in `packages/sudo/src/tool.test.ts`; the default value is pinned in `config.test.ts`.
