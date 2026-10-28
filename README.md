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
- `key_file` is the agent's key file. Keep it outside the kit folder. Without `key_file` the scripts run in network-secret mode (see "The agent key").
- `ignore_agents` lists other agents whose comments are not tags for this agent. It is optional.
- `transport` chooses how the listener talks to Firestore: `"node"` (the default, the way the kit has always worked) or `"webchannel"`. Use `"webchannel"` only when the listener never hears a comment through a cloud proxy. It uses the browser build of the Firebase SDK with long polling, which some proxies allow where the Node build's connection is reset. Node 22.21 or newer is required for the listener in both transports: `start.sh` refuses to run on an older Node. `start.sh` sets `NODE_USE_ENV_PROXY=1` for you. Running the listener yourself with `webchannel` and a proxy needs that variable set too. Any other value is refused.

A template is in `templates/org-repo/spm-agent.config.example.json`.

## Two values you get from SPM

- The agent key. Keep it in the key file named in the settings file.
- `FIREBASE_API_KEY`. This is the public SPM app id, not a secret. SPM gives it to you together with the agent key.
  Set it as an environment variable in the session until the kit has it built in.

## Installing a pinned release

An organisation installs one fixed release, not the latest code.

Before you copy a release's checksum into the organisation's settings, verify that release's attestation once (the command is under Releases below). After that, the checksum pins that exact file.

**If the organisation has a repository:** copy `templates/org-repo/.claude/settings.json`
into that repository. Replace the checksum placeholder with the SHA-256 of the release
archive, from the release's `SHA256SUMS` file. A SessionStart hook then installs the kit
and the Firebase SDK each time a new cloud session starts. The hook is one command, so the
two installs run in order: the kit first, then the SDK.

**If the organisation has no repository:** run the installer from the environment's setup script:

```sh
bash install-kit.sh 0.1.0 <sha256 from SHA256SUMS>
```

The installer:

- downloads the release archive for the version you give it;
- checks its SHA-256 against the value you give it, and stops with exit code 3 if they differ;
- unpacks it into `$SPM_AGENT_KIT_DIR` (default `$HOME/spm-agent-kit`);
- writes a `VERSION` file and a kit marker file, `.spm-agent-kit`, holding one line: `spm-agent-kit <version>`. Running it again for the same version does nothing.

**The marker rule.** The installer replaces an existing folder only when that folder carries
`.spm-agent-kit`. An empty folder is installed into. Any other folder is refused with exit
code 2 and nothing is deleted, including a folder that only has a `VERSION` file, and a
symlink is refused too. The check runs before any download, and again just before the old
kit is removed.

Its own file is at `install/install-kit.sh`. The SessionStart hook runs the copy that is
inside the repository at `templates/org-repo/.claude/hooks/install-kit.sh`, which is
byte-identical to it.

## Releases

Release archives are built by GitHub Actions from the tag (`v<version>`), never on a laptop.
The release workflow runs the tests, builds the archive and checksums with `scripts/release.sh`,
attaches a build provenance attestation to the archive, and publishes the release. To check a
downloaded archive:

```sh
gh attestation verify spm-agent-kit-<version>.tar.gz --repo superproductmanager/spm-agent-kit
```

## Allow rules in the template

The template's `permissions.allow` lets the agent run its own scripts without a prompt for each call:

- `Bash(node */spm-agent-kit/agent-reply.cjs *)`
- `Bash(node */spm-agent-kit/agent-ack.cjs *)`
- `Bash(node */spm-agent-kit/agent-resolve.cjs *)`
- `Bash(node */spm-agent-kit/agent-relay.cjs *)`
- `Bash(bash */spm-agent-kit/start.sh *)`

The rules match only when the kit folder is named `spm-agent-kit`. Commands must use the
absolute path, unquoted (for example `node /root/spm-agent-kit/agent-reply.cjs --config ...`).
A variable or a quoted path does not match, and Claude will ask for approval.

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
| `install/install-kit.sh` | Installs one pinned release. |
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
