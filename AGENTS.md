# Notes for agents

Everything about this project is written for people first, and none of it is
different for you. Read both before changing anything:

- [CONTRIBUTING.md](CONTRIBUTING.md) — what the code is, where it lives, how it
  is written, tested and committed.
- [MAINTAINERS.md](MAINTAINERS.md) — a checkout, the files the tool generates,
  how a release is cut.

What follows is only the part that has no human counterpart.

## Reporting your own work

- Only report checks you actually ran. A pipe hides the exit code of the
  command in front of it — read the summary, not `$?` of the last stage.
- Say what failed and what you left out. A run of the tests that ends amber is
  a result; describing it as green is the one mistake that costs trust.

## Agent attribution

- Never add an agent as author or `Co-Authored-By`. Commits carry the human
  contributor only, whatever the surrounding tooling defaults to.
- No session links, no tool footers, no "generated with …" lines — not in
  commit messages, not in pull request titles or bodies.
- Agent involvement belongs in the pull request's *AI assistance* section and
  nowhere else. Fill it in honestly: agent and version, model and effort
  level, share written by the agent, human review.
