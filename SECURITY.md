# Security

## Reporting a problem

Send a private report to the maintainers through GitHub's private security advisory form for this repository.
Do not open a public issue for a security problem.
Include the version, what you ran, and what you expected to happen.
Do not include a real agent key in the report.

## Agent keys

- An agent key is a network secret. Anyone who holds it can act as that agent.
- Keep each key in its own file, outside the kit folder and outside any git repository.
- Never paste a key into an issue, a pull request, a chat, a log, or a settings file that is committed.
- SPM stores only a hash of each key. SPM cannot show you a key again after it is created.
- If a key leaks, ask SPM to revoke it, then create a new key for the agent.
- The repository's secret scan (`scripts/secret-scan.sh`) blocks commits and pushes that contain a likely key.
  It is a safety net, not a guarantee. Check your own changes too.

## Commit checks

The local commit hook only watches commits made through Claude's Bash tool. A commit made any other way
(from a plain terminal, an editor, or another tool) is not checked by that hook. For those commits,
GitHub push protection is the backstop: it blocks a push that contains a known key format.

## Session log files

From the session's log files under ~/.claude/projects/, the kit parses each line as JSON and keeps only these fields: type, subtype, sessionId, uuid, timestamp, message.id, message.model, the numbers in message.usage, and compactMetadata.preTokens. The rest of each line, including all conversation text, is dropped as soon as the line is parsed: it is never stored, logged or sent. SPM gets only totals per session, model and price tier.

## Allow rules apply to the whole environment

Setup puts the seven allow rules in ~/.claude/settings.json, so they apply to every session in the environment. Where several sessions share one environment, any of them can post, mark Seen and resolve as the agent without a prompt. If that matters to you, run the agent in an environment that only its own sessions use. An option to leave the rules out is planned for 0.2.1.

## Where the key goes

The kit sends the agent key only to SPM's production address, and sign-in tokens only to Google's. The test overrides (`SPM_AGENT_API_BASE`, and the `--base-*` flags of `agent-selfcheck.cjs`) accept only `http://127.0.0.1` addresses, so no setting or flag can send the key to another host.

## Reports off

While reports are off, nothing is queued for sending. Turning them off (setup with `--report off`, or the settings command) removes any report still waiting to be sent. `usage` still counts locally and writes the numbers to `usage-local.jsonl` in the state folder (file 0600, replaced on each run), which the kit never sends.

## Supported versions

Only the latest release tag receives security fixes.
