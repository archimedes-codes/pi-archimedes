---
status: accepted
date: 2026-11-11
superseded-by:
---

# Verify the cached password, not only sudo's ticket, before calling a credential unverifiable

`sudo_exec` disambiguates a command-level failure with a credential probe: it runs `sudo -n -v`, and when that fails it counts a strike against the cached credential (two consecutive strikes clear the cache and re-prompt the user). The probe was chosen because it takes no password. That property is also why it is wrong as the *only* check: on hosts where no ticket is ever replayable, `sudo -n -v` fails **even for a correct password**.

Two host configurations reach that state, and one of them is Ubuntu's default:

- **`timestamp_type=tty` with no controlling terminal.** Debian/Ubuntu compile sudo with `timestamp_type=tty`; `sudo_exec` uses `spawn(..., { detached: true })` with piped stdio, so no terminal exists to key the ticket to. The ticket is created and then unreachable for every later invocation.
- **No-reuse policies.** `timestamp_timeout=0`, `!timestamp`, or a `Defaults` set that forbids ticket reuse: the ticket is gone the moment the command ends.

The reported consequence (issue #157) is a tool that lies about the credential: any failing command — a typo, a missing file, a shell metacharacter passed as an argv word — is annotated `the cached credential could not be verified`, and the second such failure in a session wipes a perfectly good password and prompts again. On the reporter's machine 43 occurrences across a month were all command-level failures, none an actual wrong password.

We decided to add a **second probe stage** that asks the credential itself: `sudo -S -v -p ''` — `-v` validates without executing a program, `-S` reads the password from stdin, so ADR 0010's rule (password over stdin only, never argv/env/logs/files) holds unchanged. It runs **only when the ticket probe is non-terminal**, so the cheap, password-free check keeps first refusal and a host with reusable tickets never spends a password on diagnostics. Stage 2 costs one short sudo invocation per ambiguous failure.

Only **success** is terminal. A failed password probe is not proof of a wrong password — it may be the same policy that made stage 1 fail, a transport error, or a sudoers rule that denies `-v` — so a failure falls through to the existing strike bookkeeping; the two-strike margin is unchanged. The English `incorrect password` fast path still clears immediately, and it is still checked first.

No `-k`: when a ticket *is* reusable, the probe returns immediately and reports an otherwise-usable credential. Revoking the user's own timestamp as a side effect of a diagnostic would be rude, and `-k` would make a failing probe *more* likely, not less — the point is to validate the password, not to destroy tickets.

**Considered Options**

- **Drop the ticket probe; always validate the password.** Simpler shape, one code path — rejected: it spends a credential on every failing command (including the common "ticket is fine, the command itself failed" case) and lengthens the failure path for hosts that already work. Stage 1 is free and answers most failures.
- **Clear the cache immediately when the password probe fails.** This would make a localized wrong password clear on the FIRST failure instead of the second — rejected for now: the probe cannot distinguish a wrong password from a policy or transport failure without a second signature to recognize, and wrongly clearing forces a fresh masked prompt mid-task. The two-strike rule keeps that decision conservative; a follow-up can tighten it if sudo ever reports the distinction reliably in every locale.
- **Make the cached password the *ticket* (i.e. re-authenticate eagerly after every successful run).** That converts a diagnostic into a background credential write on every command; rejected as more privileged traffic for the same answer.
- **Skip the ambiguity entirely — report every non-zero exit as a plain command failure.** Removes the false warnings but also removes the only signal that the cached password went bad after `/etc/shadow` changed, leaving the user to hit a re-prompt on a privileged command they thought would run. Rejected: the cache must eventually notice.

**Consequences**

The warning and the two-strike rule now mean what their text says — both probes non-terminal — and the "cached credential issue" class of false report disappears on tty-keyed and no-reuse hosts. `createSudoExecTool` gains a `passwordProbe` test seam beside `authProbe`, and the default wiring is covered end-to-end against fake processes (run → `-n -v` → `-S -v`). The remaining risk is the same class as before: the tool's judgement now depends on two external commands, so the tests pin both argv shapes, the stdin-only password path, and the rule that a stage-2 transport error is a strike, not a clear.
