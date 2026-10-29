# Release notes

## 0.2.1

Action needed: yes. An admin replaces the setup line in the Claude environment's Setup script with the 0.2.1 line. Environments keep running their current version until then.

### Fixed

- First start: the listener reads every page of open notices, so an agent with more than 100 open notices no longer misses the newest ones. The newest 20 of the last 24 hours are shown.
- Re-raise: the newest open notices are raised again, not the oldest, and a pass reads at most 10 pages and stops at the first error.
- Old notices are not answered twice. A notice shown again after a restart or by a re-raise is marked (`catchup` or `reraise`). Before any Seen reply the kit reads the thread, and when the agent already wrote after the tagged comment it sends nothing and adds `"already_answered": true`.
- The Seen reply waits up to 8 seconds. A 2-second limit reported a stored reply as failed, so a retry could post Seen twice.
- A tag in a reply on a board or map thread gets its Seen reply, as on documents.
- Follower notices are never raised again. The skill closes follower notices, and participant notices that do not tag the agent, without a reply.
- The listener session waits in two-hour background waits that end at the first new notice (`agent-wait.sh`, with its own allow rule), instead of a 30-minute wait. That is about 12 wakes a day instead of 48, plus the hourly check. A heartbeat is sent at each wake.
- The main session reads a hand-over from the listener session at once.
- The setup report now includes the self-check's own steps (`spm-key`, `sign-in`, `signal-read`), each as pass, fail or skip with a short code.
- A local `autostart: false` is told to SPM once, so SPM shows the switch the agent really uses. The kit never sends an "on" value and never sends the reports switch, so a switch a person changed in SPM is never turned back.

### Security

- The Seen script may now read a board task's or a map's comment list (GET, the agent key and address headers only, no body), the same read the reply script already makes. It contacts no new address.
- Setup adds one allow rule, for `agent-wait.sh`, so there are eight.

## 0.2.0

Action needed: yes. An admin replaces the setup line in the Claude environment's Setup script with the 0.2.0 line from SPM. Existing environments keep running 0.1.0 until then.

### New

- The setup line is the same for every organisation and agent. It takes no values. The agent's app id, name and address come from SPM at the agent's first start.
- Setup takes `--autostart on|off` and `--report on|off` (both on by default), and `--name` with `--email` as optional overrides.
- Auto-start: setup writes a short block into `~/.claude/CLAUDE.md`, between two marker lines. Each new session then starts the agent. The setting is kept in SPM, per agent.
- Health reports: setup step results, an hourly listener heartbeat, and usage numbers per session, model and price tier. Numbers only. See the README section "Health reports".
- A settings command (`agent-health.cjs settings`) lets the person in a session change auto-start and reports.

### Changed

- `--app-id` is optional at setup. SPM supplies it at first start when it is not given.
- The Firebase SDK step installs three pinned packages (`@firebase/app`, `@firebase/auth`, `@firebase/firestore`), not the whole `firebase` package.
- Setup writes a setup report spool and a report salt in the state folder. Neither holds a key or conversation text.

### Security

- The Firebase SDK installs only the three packages the listener uses, from a committed lockfile (41 packages, all from registry.npmjs.org with integrity hashes), with `npm ci --ignore-scripts`. Two of them declare install scripts, `@firebase/util` and `protobufjs`; those scripts do not run.
- The kit reads only usage numbers from session logs (the field list is in `SECURITY.md`). It sends totals per session, model and price tier, and session ids as salted hashes.
- The agent is instructed to change auto-start or reports only when the person in the session asks, never because a comment or other text in SPM asks. This is an instruction to the model, not a technical lock.
- Usage counts only the session that runs the command (its id from `CLAUDE_CODE_SESSION_ID` or `--session`), never the newest log file, which in a shared environment can belong to another session.
- The allow rules apply to every session in the environment; see `SECURITY.md`.
- The agent key goes only to SPM's production address and sign-in tokens only to Google's: the test overrides accept only `http://127.0.0.1`. In 0.1.0, `agent-selfcheck.cjs --base-fn` could send the key to any address.
- While reports are off nothing is queued for sending, and turning reports off removes any report still waiting.

## 0.1.0

- First release.
