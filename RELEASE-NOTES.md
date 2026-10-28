# Release notes

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

- The Firebase SDK installs only the three packages the listener uses, from a committed lockfile, with `npm ci --ignore-scripts` (install scripts are off).
- The kit reads only usage numbers from session logs (the field list is in `SECURITY.md`). It sends totals per session, model and price tier, and session ids as salted hashes.
- A comment or other text in SPM cannot change auto-start or reports. Only the person in a session can.

## 0.1.0

- First release.
