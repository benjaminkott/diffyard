# Driving it from an agent

An agent that can run a shell can run diffyard, and that is the whole idea
behind the MCP server: it says where the tool is and how it is used, and then
gets out of the way. One tool, three resources, nothing that runs a comparison.
What follows is how to connect it and what a session with it looks like.

## Connecting it

In Claude Code, one line:

```bash
claude mcp add diffyard -s user -- diffyard-mcp
```

`-s user` registers it once for every project on the machine, which is what a
tool you reach for occasionally wants. `-s project` writes an `.mcp.json` into
the repository instead, so everyone who checks it out gets the same server —
worth it where comparing staging against production is part of how the team
works, rather than something one person does.

Other clients keep the same idea in a JSON file: a named entry with a command
to start. Where the file lives and what the block is called differs between
them; the command does not.

```json
{
  "mcpServers": {
    "diffyard": {
      "command": "diffyard-mcp"
    }
  }
}
```

That entry assumes `diffyard-mcp` is on the PATH, which it is after a global
install. From a checkout, name the file instead — `node` plus the path to
`bin/diffyard-mcp.mjs` — and the server is whatever branch is checked out:

```json
{
  "mcpServers": {
    "diffyard": {
      "command": "node",
      "args": ["/home/you/tools/diffyard/bin/diffyard-mcp.mjs"]
    }
  }
}
```

`claude mcp list` says whether it connected. The other way to check is to ask
the agent what diffyard is: a connected server answers with a path, a
disconnected one with a guess.

## What the agent gets

**`diffyard_usage`** is the one tool, and it takes no arguments. It answers
with the path the command was found at, every subcommand with its flags, and
the config in brief. An agent calls it once at the start and works from the
shell afterwards.

Three resources sit beside it, for when a draft has to be exact rather than
plausible:

| Resource | What it holds |
| --- | --- |
| `diffyard://reference/config` | A config with every option documented inline |
| `diffyard://reference/steps` | Every step a scenario can perform before the shot |
| `diffyard://reference/schema` | The JSON schema, for validating or generating one |

## A session

Point it at two addresses and say what you want:

> Compare our staging site against production — https://example.ddev.site/
> and https://example.com/ — and tell me what changed.

What the agent does with that is what you would do by hand. It calls
`diffyard_usage`, then explores the site it does not know yet:

```bash
diffyard explore https://example.ddev.site/ --compare-with https://example.com/
```

`explore` reports the consent banner, the elements that open menus, the
internal links worth comparing and the content that changes on its own — and
drafts a config from it. The agent edits that draft rather than inventing one,
checks it against the schema resource, and runs it:

```bash
diffyard run diffyard.yaml
```

The run prints a line per comparison as it goes, so the agent sees progress
rather than waiting on silence. It exits 0 when nothing differs, 1 on
differences, 2 on errors — which is the part an agent actually branches on.

Then it reads `results.json` from the run folder: ratios, thresholds, paths and
errors, per comparison, without parsing a report. The screenshots and the
markup patch sit next to it under `shots/`, so anything it wants to look at
more closely is a file it can open.

Working through what came back is the same loop as by hand — every finding
carries the line that runs it again:

```bash
diffyard run diffyard.yaml --case shop--checkout--desktop --into 2026-08-28_09-16-03-24f7ce
```

`--into` writes the result back into that report and leaves the other findings
standing, so the agent can fix one thing at a time against a report that stays
whole.

## Why nothing here runs a comparison

It would be easy to expose `run` as a tool, and it would be worse in three
ways. A run takes minutes, and a tool call that returns nothing for minutes
tells the agent nothing while it waits — where the command prints a line per
scenario. Screenshots would have to be squeezed through base64 to come back as
tool results, when they are already files on disk that an agent can open. And
the results would live inside a conversation instead of in the project, where a
second run can compare against them.

So the server answers one question — where is the tool and how is it used — and
the work happens where the results belong.
