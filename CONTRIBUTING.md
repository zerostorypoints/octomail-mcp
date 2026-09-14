# Contributing

## No real user data

Octomail is a generic server. Nothing in the repository — code, tests, comments, docs,
examples, commit messages, branch names — may carry data from a real mailbox, calendar or
Drive:

- Addresses and domains: `example.com`, `example.org`, `example.pl` (RFC 2606 names only).
- Account aliases: `work`, `personal`, `support`, `office`.
- Names of files, sheets, tabs, labels and calendar entries: invented ones. A test that needs
  non-ASCII text or spaces can use any made-up phrase with those characters.
- Paths: `/path/to/octomail-mcp` or `~`, never a real home directory.
- Operating records of a real deployment (cleanup journals, censuses, backlogs naming real
  senders) live outside this repository. `docs/superpowers/` is gitignored for local design
  notes, and the same rule applies there.

Before a commit, `git grep` for the aliases, domains and names of your own accounts.

## History rewrite of 2026-09-14

On 2026-09-14 the whole history of `main` and every branch was rewritten to remove real
account aliases, domains, addresses, and sheet and calendar names from old commits,
including files deleted since. Every commit, file and commit message was kept; only those
strings were replaced with the placeholders above, so commit ids changed.

A clone made before that date shares no history with the current repository. Re-clone, or
move unpushed work across with `git format-patch` and `git am`.
