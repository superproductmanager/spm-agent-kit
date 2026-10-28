# SPM agent kit

Status: preview for review. No release is tagged yet; do not install it in production.

The SPM agent kit lets a Claude Code cloud session listen for tags of an SPM agent.
When someone writes `@` and the agent's name in an SPM comment, the agent in your session
reads the comment and replies as that agent.

The kit is a small set of scripts. It does not hold any product data.

## What is in the kit

- Listener and reply scripts that talk to the SPM API.
- A settings file for each agent, so one kit can serve many agents.
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
- `agent.email` must end in `@agents.invalid`.
- `app_id` is the public SPM app id, not a secret. Setup writes it from `--app-id`. If `FIREBASE_API_KEY` is set in the environment, it wins over `app_id`.
- `key_file` is the agent's key file. Keep it outside the kit folder. Without `key_file` the scripts run in network-secret mode (see "The agent key").
- `ignore_agents` lists other agents whose comments are not tags for this agent. It is optional.
- `transport` chooses how the listener talks to Firestore: `"node"` (the default, the way the kit has always worked) or `"webchannel"`. Use `"webchannel"` only when the listener never hears a comment through a cloud proxy. It uses the browser build of the Firebase SDK with long polling, which some proxies allow where the Node build's connection is reset. Node 22.21 or newer is required for the listener in both transports: `start.sh` refuses to run on an older Node. `start.sh` sets `NODE_USE_ENV_PROXY=1` for you. Running the listener yourself with `webchannel` and a proxy needs that variable set too. Any other value is refused.


## Two values you get from SPM

- The agent key. Keep it in the key file named in the settings file.
- The public SPM app id. SPM gives it to you together with the agent key. Setup takes it as `--app-id`; the `FIREBASE_API_KEY` environment variable still works and wins when it is set.

## Setup (one line)

An organisation installs one fixed release, not the latest code. The admin pastes one line into the
Claude environment's Setup script. SPM writes the exact line for each release into the setup doc, with the
full commit sha, the version, the checksum, and the agent's name, address and app id. The shape is:

```sh
f=$(mktemp) && curl --proto '=https' -fsSL https://raw.githubusercontent.com/superproductmanager/spm-agent-kit/<full 40-character commit sha>/install/install-kit.sh -o "$f" && echo "<installer sha256>  $f" | sha256sum -c --quiet - && bash "$f" <version> <sha256> && bash "$HOME/spm-agent-kit/setup-env.sh" --name "<agent name>" --email <agent address> --app-id <SPM app id>
```

- The setup script runs once per environment snapshot (first session start, and again when the script or allowed hosts change), so editing the version in the line is how a new release reaches sessions.
- The installer is fetched by the full commit sha, so the line always runs the same file. `<sha256>` is the SHA-256 of the release archive, from the release's `SHA256SUMS` file.
- Optional, once, by the admin: verify the release's attestation before you paste its line (the command is under Releases).
- The installer downloads the release archive for `<version>`, checks its SHA-256 against `<sha256>`, and stops with exit code 3 if they differ. It unpacks the kit into `$SPM_AGENT_KIT_DIR` (default `$HOME/spm-agent-kit`) and writes a `VERSION` file and a kit marker file, `.spm-agent-kit`, holding one line: `spm-agent-kit <version>`. Running it again for the same version does nothing.
- `setup-env.sh` then writes what Claude needs into the user's own Claude folder, which every session reads:
  - `~/.spm-agent-state/config.json` (folder 0700, file 0600): the agent's name and address, `app_id`, plus `ignore_agents` and `transport` when you give them. No key and no session id. Rewritten on every run.
  - `~/.claude/skills/spm-agent/SKILL.md`: copied from the kit's `skill/spm-agent/SKILL.md`, with the kit folder filled in. Replaced on every run.
  - `~/.claude/settings.json`: the seven allow rules under "Allow rules" below are merged in. Other keys and rules are kept. A file that is a symbolic link, is not valid JSON, or is not a JSON object is refused with exit code 2 and left untouched.
  - the Firebase SDK, unless you pass `--no-sdk`.
- On success it prints one line: `spm-agent-kit <version>: set up for <agent name>`.

Setup flags: `--app-id <value>` (required), `--ignore-agent <name>` (repeatable), `--transport node|webchannel`, `--autostart on|off`, `--no-sdk`, `--help`.

The name may use 1 to 60 letters, digits, spaces, dots, brackets and hyphens.

`--autostart off` writes no CLAUDE.md block, and removes the kit's block if one is there; the agent then starts only when someone asks for it.

**The marker rule.** The installer replaces an existing folder only when that folder carries
`.spm-agent-kit`. An empty folder is installed into. Any other folder is refused with exit
code 2 and nothing is deleted, including a folder that only has a `VERSION` file, and a
symlink is refused too. The check runs before any download, and again just before the old
kit is removed. The installer stages the new kit in a hidden folder beside the install folder, so the final move is a rename.

Its own file is at `install/install-kit.sh`.

## Releases

Release archives are built by GitHub Actions from the tag (`v<version>`), never on a laptop.
The release workflow runs the tests, builds the archive and checksums with `scripts/release.sh`,
attaches a build provenance attestation to the archive, and publishes the release. To check a
downloaded archive:

```sh
gh attestation verify spm-agent-kit-<version>.tar.gz --repo superproductmanager/spm-agent-kit
```

## Allow rules

Setup adds these seven `permissions.allow` rules to `~/.claude/settings.json`, so the agent runs its own scripts without a prompt for each call. The kit never sets the permission mode. Each rule is built from the kit folder that `setup-env.sh` ran from (`<kit>` below), so the rules are absolute:

- `Bash(node <kit>/agent-reply.cjs *)`
- `Bash(node <kit>/agent-ack.cjs *)`
- `Bash(node <kit>/agent-resolve.cjs *)`
- `Bash(node <kit>/agent-relay.cjs *)`
- `Bash(node <kit>/agent-selfcheck.cjs *)`
- `Bash(bash <kit>/start.sh *)`
- `Bash(node <kit>/agent-health.cjs *)`

A command matches a rule only when it starts with that same absolute path, unquoted (for example `node /root/spm-agent-kit/agent-reply.cjs --config ...`). A variable or a quoted path does not match, and Claude will ask for approval. The skill is written with the kit path already filled in, so its commands match these rules.

## Scripts

| File | What it does |
|---|---|
| `agent-listen.cjs` | Watches the agent's notice inbox and reports new tags. |
| `agent-reply.cjs` | Posts a reply in a comment thread as the agent. |
| `agent-ack.cjs` | Posts a short "seen" note in a thread, so people know the request arrived. |
| `agent-resolve.cjs` | Marks a notice as resolved, so the listener stops raising it again. |
| `agent-selfcheck.cjs` | Runs checks on the settings file, the key and the server. Prints one cause and one fix for each failure. |
| `start.sh` | Runs the selfcheck, then the listener in the foreground with restarts (see "Start the listener"). |
| `agent-relay.cjs` | Keeps a record of which notices were handed over, so none is dropped or repeated. |
| `agent-keepalive.sh` | Restarts a command when it exits, and appends its output to a log file. |
| `cloud-agent-setup.sh` | Installs the Firebase SDK the listener needs into a fixed folder for cloud sessions. |
| `install/install-kit.sh` | Installs one pinned release, checked by SHA-256. |
| `setup-env.sh` | The one-line setup: writes the agent's config, the skill and the allow rules, then installs the Firebase SDK. |
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

## Start the listener

In a cloud session, after the kit is installed:

```sh
bash start.sh --config <absolute path to the settings file> [--state-dir <absolute path>]
```

- `start.sh` runs the selfcheck first. On a failure it prints the FAIL line, exits 1, and starts nothing.
- On success it prints one JSON line, `{"kind":"start","log":"<state>/listener.log","version":"<version>"}`, then runs the listener in the foreground. Run it in the background (for example `bash start.sh ... &`).
- The state dir defaults to `$SPM_AGENT_STATE_DIR`, else `$HOME/.spm-agent-state`. It is created with mode 700 and is refused if it is inside a git work tree.
- The listener log is `<state>/listener.log`. A second start while one runs exits 0 with one line and starts nothing.

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
