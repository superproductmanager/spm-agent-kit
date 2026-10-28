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

From the session's log files under ~/.claude/projects/, the kit reads only these fields: type, subtype, sessionId, uuid, timestamp, message.id, message.model, the numbers in message.usage, and compactMetadata.preTokens. It never reads or keeps any text from those files, and it sends SPM only totals per session, model and price tier.

## Supported versions

Only the latest release tag receives security fixes.
