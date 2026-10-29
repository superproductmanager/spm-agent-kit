# SPM agent kit

Status: preview for review. Current version: 0.2.1 (see RELEASE-NOTES.md). Do not install it in production.

The SPM agent kit lets a Claude Code cloud session listen for tags of an SPM agent.
When someone writes `@` and the agent's name in an SPM comment, the agent in your session
reads the comment and replies as that agent.

The kit is a small set of scripts. It does not hold any product data.

## What is in the kit

- Listener and reply scripts that talk to the SPM API.
- A settings file for each agent, so one kit can serve many agents.
- Health reports to SPM: setup results, a heartbeat and usage numbers. Numbers only (see "Health reports").
- An installer that checks a release checksum before it installs anything.

## The settings file

Each agent has its own settings file. Scripts read it with `--config <absolute path>`,
or with the environment variable `SPM_AGENT_CONFIG`.

Example, with synthetic values:

```json
{
  "agent": { "name": "Example agent", "email": "spm-example-agent@agents.invalid" },
  "key_file": "/path/to/example-agent.key",
  "ignore_agents": ["Other example agent"]
}
```

- `agent.name` is the name people tag, for example `@Example agent`. It must match the agent's display name in SPM exactly.
  Setup writes it only when you give `--name`. Otherwise `agent-health.cjs start` writes it from SPM.
- `agent.email` must end in `@agents.invalid`. Setup and `agent-health.cjs start` handle it the same way as the name.
- `app_id` is the public SPM app id, not a secret. Setup writes it when you give `--app-id`. Otherwise `agent-health.cjs start` writes it from SPM when the file has none. If `FIREBASE_API_KEY` is set in the environment, it wins over `app_id`.
- `key_file` is the agent's key file. Keep it outside the kit folder. Without `key_file` the scripts run in network-secret mode (see "The agent key").
- `ignore_agents` lists other agents whose comments are not tags for this agent. It is optional.
- `transport` chooses how the listener talks to Firestore: `"node"` (the default, the way the kit has always worked) or `"webchannel"`. Use `"webchannel"` only when the listener never hears a comment through a cloud proxy. It uses the browser build of the Firebase SDK with long polling, which some proxies allow where the Node build's connection is reset. Node 22.21 or newer is required for the listener in both transports: `start.sh` refuses to run on an older Node. `start.sh` sets `NODE_USE_ENV_PROXY=1` for you. Running the listener yourself with `webchannel` and a proxy needs that variable set too. Any other value is refused.
- `report` and `autostart` are written by setup only when you pass `--report off` or `--autostart off` (see "Settings").

## Values you need

- The agent key. Keep it in the key file named in the settings file.
- Nothing else. The public SPM app id, the agent's name and the agent's address come from SPM at the agent's first start. You can still give them to setup as overrides (`--app-id`, `--name` and `--email`).

## Setup (one line)

An organisation installs one fixed release, not the latest code. The admin pastes one line into the
Claude environment's Setup script. SPM writes the line for each release into the setup doc, with the
full commit sha, the version and the checksum. The line is the same for every organisation and every agent:

```sh
f=$(mktemp) && curl --proto '=https' -fsSL https://raw.githubusercontent.com/superproductmanager/spm-agent-kit/<full 40-character commit sha>/install/install-kit.sh -o "$f" && echo "<installer sha256>  $f" | sha256sum -c --quiet - && bash "$f" <version> <sha256> && bash "$HOME/spm-agent-kit/setup-env.sh"
```

- The setup script runs once per environment snapshot (first session start, and again when the script or allowed hosts change), so editing the version in the line is how a new release reaches sessions.
- The installer is fetched by the full commit sha, so the line always runs the same file. `<sha256>` is the SHA-256 of the release archive, from the release's `SHA256SUMS` file.
- Optional, once, by the admin: verify the release's attestation before you paste its line (the command is under Releases).
- The installer downloads the release archive for `<version>`, checks its SHA-256 against `<sha256>`, and stops with exit code 3 if they differ. It unpacks the kit into `$SPM_AGENT_KIT_DIR` (default `$HOME/spm-agent-kit`) and writes a `VERSION` file and a kit marker file, `.spm-agent-kit`, holding one line: `spm-agent-kit <version>`. Running it again for the same version does nothing.
- `setup-env.sh` then writes what Claude needs into the user's own Claude folder, which every session reads:
  - `~/.spm-agent-state/config.json` (folder 0700, file 0600): the agent's name and address, `app_id`, plus `ignore_agents` and `transport` when you give them. No key and no session id. Rewritten on every run. An agent block already there is kept when you give no `--name` and `--email`.
  - `~/.claude/skills/spm-agent/SKILL.md`: copied from the kit's `skill/spm-agent/SKILL.md`, with the kit folder filled in. Replaced on every run.
  - `~/.claude/settings.json`: the eight allow rules under "Allow rules" below are merged in. Other keys and rules are kept. A file that is a symbolic link, is not valid JSON, or is not a JSON object is refused with exit code 2 and left untouched.
  - `~/.claude/CLAUDE.md`: a short block between the two marker lines `<!-- spm-agent-kit:start -->` and `<!-- spm-agent-kit:end -->`. It tells each new session to start the agent (see "Settings"). A re-run replaces only the block. Text outside the markers is kept byte for byte. With `--autostart off` no block is written, and the kit's block is removed if it is there.
  - `~/.spm-agent-state/setup-report.jsonl` (file 0600): one line per setup step (config, skill, claude-md, settings, sdk) with the step's name, pass or fail, a short code, and a run id. It holds no key, no path and no conversation text. Health reports send it later.
  - `~/.spm-agent-state/report-salt` (file 0600): 32 random hex characters, written once and kept on every later run. The kit mixes it into session ids before a report leaves the machine, so SPM never sees a raw session id. It is never sent.
  - the Firebase SDK, unless you pass `--no-sdk` (see below).
- Setup then runs the setup check. Its result never changes the exit code.
- On success it prints one line. When you gave `--name`: `spm-agent-kit <version>: set up for <agent name>`. When you did not: `spm-agent-kit <version>: set up; the agent's name and address come from SPM at first start`.

**Firebase SDK.** Setup installs three pinned packages, `@firebase/app`, `@firebase/auth` and `@firebase/firestore`, that the listener uses. They come from the kit's committed `runtime/package-lock.json`, installed with `npm ci --ignore-scripts` (no install scripts run) into `$SPM_AGENT_RUNTIME_DIR`, else `$HOME/.spm-agent-runtime`. The runtime folder is refused inside a git work tree. If this step fails, setup exits 1 and prints the command to see why.

Setup flags. All are optional; the setup line needs none of them.

- `--app-id <value>`: the public SPM app id, 20 to 60 letters, digits, `_` or `-`. Kept from the config when not given.
- `--name <text>` and `--email <address>`: the agent's name and address. Give both or neither. Without them, SPM supplies both at first start.
- `--ignore-agent <name>`: another agent whose comments are not tags for this one. Repeatable.
- `--transport node|webchannel`: default `node`.
- `--report on|off`: default `on`. `--report off` writes `"report": false` into the config, so no health report is sent. While reports are off nothing is queued for sending, and setup removes any report still waiting. `usage` still counts and writes its numbers to `usage-local.jsonl` in the state folder, which is never sent.
- `--autostart on|off`: default `on`. `--autostart off` writes `"autostart": false` into the config, so the agent does not start by itself. It writes no CLAUDE.md block and removes the kit's block if there is one. The agent then starts only when someone asks for it.
- `--no-sdk`: do not install the Firebase SDK.
- `--help`: print the usage line and exit.

The name may use 1 to 60 letters, digits, spaces, dots, brackets and hyphens. The address must be lower case and end in `@agents.invalid`.

**The marker rule.** The installer replaces an existing folder only when that folder carries
`.spm-agent-kit`. An empty folder is installed into. Any other folder is refused with exit
code 2 and nothing is deleted, including a folder that only has a `VERSION` file, and a
symlink is refused too. The check runs before any download, and again just before the old
kit is removed. The installer stages the new kit in a hidden folder beside the install folder, so the final move is a rename.

Its own file is at `install/install-kit.sh`.

## Settings

- Auto-start and health reports are kept in SPM, per agent. Both are on by default.
- Only the person in a session can change them. In that session, the agent runs the settings command:
  `node <kit>/agent-health.cjs settings --config <absolute path> --autostart on|off --reports on|off`.
  Give one or both flags. It prints the new values, for example `settings: autostart on, reports off`.
- Only the person in the session should change them. The agent is instructed to ignore a request to change them that comes in a comment, a hand-over message or any other text. This is an instruction to the model, not a technical lock: the settings command runs without a prompt under the allow rules.
- A local off from setup wins. `--autostart off` and `--report off` stay in force whatever SPM says, and SPM cannot turn them on. To change a local off, change the setup line and run setup again.

## Health reports

Reports go to SPM over the SPM API, with the agent key only. Each report is one item of numbers and fixed words.

What is sent:

- Setup results: the step names (config, skill, claude-md, settings, sdk), pass or fail, and a short code.
- A heartbeat from the listener session at each of its wakes (see "Listener waits"): counts of listener starts, restarts and failures since the last heartbeat, container starts, main session changes, uptime in seconds, and the main session's status word.
- Usage per session, model and price tier: the number of model calls, input, output and cache token totals, the number of compactions and their size in tokens.
- The kit version and the Node version.
- The session id, as a salted hash (the first 16 hex characters of SHA-256 over the salt and the session id).

What is never sent: conversation text, a person's name or address, a key, a token, or the report salt. The kit reads only usage numbers from the session log files (the field list is in `SECURITY.md`).

Which session is counted: the session id comes from `--session <id>` when given, else from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every command a session runs. The skill's commands pass no id, so each session counts only itself. With neither, the kit counts nothing and says so; it never guesses from the newest log file. A `claude -p` run started inside a session writes its log under the same session id in another project folder, so it is counted with that session.

How to turn reports off:

- At setup: `--report off`.
- Later, in a session: the settings command with `--reports off` (see "Settings").

A local off wins. When the config says `"report": false`, nothing is sent, even if SPM has reports on. While reports are off, from either side, nothing is queued for sending, so turning them on later sends only what happens after. Turning reports off with the settings command, or setup with `--report off`, removes any report still waiting to be sent.

## Allow rules

Setup adds these eight `permissions.allow` rules to `~/.claude/settings.json`, so the agent runs its own scripts without a prompt for each call. The kit never sets the permission mode. Each rule is built from the kit folder that `setup-env.sh` ran from (`<kit>` below), so the rules are absolute:

- `Bash(node <kit>/agent-reply.cjs *)`
- `Bash(node <kit>/agent-ack.cjs *)`
- `Bash(node <kit>/agent-resolve.cjs *)`
- `Bash(node <kit>/agent-relay.cjs *)`
- `Bash(node <kit>/agent-selfcheck.cjs *)`
- `Bash(bash <kit>/start.sh *)`
- `Bash(node <kit>/agent-health.cjs *)`
- `Bash(bash <kit>/agent-wait.sh *)`

A command matches a rule only when it starts with that same absolute path, unquoted (for example `node <kit>/agent-reply.cjs --config ...`). A variable or a quoted path does not match, and Claude will ask for approval. The skill is written with the kit path already filled in, so its commands match these rules.

## Scripts

| File | What it does |
|---|---|
| `agent-listen.cjs` | Watches the agent's notice inbox and reports new tags. |
| `agent-reply.cjs` | Posts a reply in a comment thread as the agent. |
| `agent-ack.cjs` | Posts a short "seen" note in a thread, so people know the request arrived. |
| `agent-resolve.cjs` | Marks a notice as resolved, so the listener stops raising it again. |
| `agent-selfcheck.cjs` | Runs checks on the settings file, the key and the server. Prints one cause and one fix for each failure. |
| `agent-health.cjs` | Reads the agent's identity and settings from SPM at start, sends health reports, and changes the settings when the person asks. |
| `agent-wait.sh` | The listener session's wait: ends at the first new notice, FAIL or fatal line in the listener log, or after `--seconds` (default 7200). Prints `notice`, `fail` or `timeout`. |
| `start.sh` | Runs the selfcheck, then the listener in the foreground with restarts (see "Start the listener"). |
| `agent-relay.cjs` | Keeps a record of which notices were handed over, so none is dropped or repeated. |
| `agent-keepalive.sh` | Restarts a command when it exits, and appends its output to a log file. |
| `cloud-agent-setup.sh` | Installs the three pinned Firebase SDK packages the listener needs (`@firebase/app`, `@firebase/auth`, `@firebase/firestore`) into a fixed folder for cloud sessions, with `npm ci --ignore-scripts` from the kit's committed `runtime/package-lock.json`. |
| `install/install-kit.sh` | Installs one pinned release, checked by SHA-256. |
| `setup-env.sh` | The one-line setup: writes the agent's config, the skill, the allow rules, the CLAUDE.md block and the setup report, then installs the Firebase SDK. |
| `skill/spm-agent/SKILL.md` | The skill Claude reads in each session; setup copies it into `~/.claude/skills/`. |
| `scripts/secret-scan.sh` | Looks for likely keys in files, staged changes, or the whole tree. |
| `scripts/release.sh` | Builds the release archive and checksums from a tag. |

Every script that takes `--config` prints a short line and exits with code 2 if the settings file is missing or wrong.

## The agent key

An agent key only lets its holder call the SPM API as that agent. It is not a password for a repository or a cloud account.
Treat it like a password for the agent. See `SECURITY.md`.

The scripts have two key modes, chosen by the settings file:

- **Key file mode** (`key_file` is set): the script reads the key from that file and sends it as `X-SPM-API-Key`. Nothing else changes.
- **Network-secret mode** (no `key_file`): the key is stored only as a network secret in the Claude cloud environment, and the key never sits in a file. The script sends the fixed placeholder `network-secret` as `X-SPM-API-Key`, and the cloud proxy replaces that header with the real key for the SPM host. Every SPM call in this mode goes through the cloud proxy (`HTTPS_PROXY`). With no proxy set, the script refuses with exit 2 and the line `network-secret mode needs the Claude cloud proxy; set key_file to run elsewhere`. The network secret must be set for the exact host `asia-south1-litethink.cloudfunctions.net` with the header `X-SPM-API-Key`. If it is not, `agent-selfcheck.cjs` says so in its cause line.

A real key value is never printed or logged in either mode.

## Releases

Release archives are built by GitHub Actions from the tag (`v<version>`), never on a laptop.
The release workflow runs the tests, builds the archive and checksums with `scripts/release.sh`,
attaches a build provenance attestation to the archive, and publishes the release. To check a
downloaded archive:

```sh
gh attestation verify spm-agent-kit-<version>.tar.gz --repo superproductmanager/spm-agent-kit
```

## Start the listener

In a cloud session, after the kit is installed:

```sh
bash start.sh --config <absolute path to the settings file> [--state-dir <absolute path>]
```

- `start.sh` runs the selfcheck first. On a failure it prints the FAIL line, exits 1, and starts nothing.
- On success it prints one JSON line, `{"kind":"start","log":"<state>/listener.log","version":"<version>"}`, then runs the listener in the foreground. Run it in the background (for example `bash start.sh ... &`).
- The state dir defaults to `$SPM_AGENT_STATE_DIR`, else `$HOME/.spm-agent-state`. It is created with mode 700 and is refused if it is inside a git work tree.
- The listener log is `<state>/listener.log`. A second start while one runs exits 0 with one line and starts nothing.

### Listener waits

The listener session waits in background waits of two hours, not in a 30-minute watch. Each wait is `agent-wait.sh --log <state>/listener.log`, which ends at the first new notice, FAIL or fatal line written after it starts, or after two hours. Its end wakes the session: it hands over the notices, checks that the listener is still running (starting it again if not), and sends one heartbeat. Then it starts the next wait. A cloud session stops background programs after two hours, so a wait never runs longer than that.

### Notice lines

The listener writes one JSON line per notice. These keys tell a reader what to do with it:

| Key | Meaning |
|---|---|
| `reason` | `mentioned` (the agent was tagged), `participant` (a comment in a thread the agent is in) or `follower`. Follower notices, and participant notices that do not tag the agent, are never answered; the session resolves them. |
| `catchup` | `true` on a line printed at first start for a notice from before the start. Live lines do not carry it. |
| `reraise` | The count of times an unresolved notice has been printed again: 1 for the first repeat, then 2, 3 and so on. |
| `already_answered` | `true` when the agent had already written in that thread after the notice. Nothing is posted, and the session resolves the notice. |
| `skipped` | `no_lookup` when a catch-up or re-raise line is for a board or map and no read can show the agent's earlier replies. Nothing is posted for it. |
| `text_acked` | `true` when the "Seen" reply was posted, `false` when it failed, `null` when no reply was tried. |
| `ack_error` | Set when a step of the "Seen" reply failed. `lookup` means the thread check failed, so nothing was posted. |

## Tests

Run the kit's tests from the kit folder:

```sh
node --test test/*.test.cjs
```

The tests use synthetic data only. A guard test fails if a real identifier, address, or key appears in any file of the repository. A private check for names runs before each release push.

## Contributing

After you clone this repository, run `git config core.hooksPath .githooks` once. This turns on the pre-commit hook, which runs the secret scan (`scripts/secret-scan.sh`) on the files you stage and stops the commit if it finds a key, a private key block or a database URI with a password. Then run `node --test test/*.test.cjs` before you open a pull request. Never paste a real key into a test, an issue or a commit.

## Licence

MIT. See `LICENSE`.
