# concord-engine-mcp

The [Concord Engine](https://github.com/harsh-chandak/concord-engine) MCP
server, launchable with no arguments:

```
npx concord-engine-mcp
```

That is the whole point of this package. `concord-engine` itself declares two
bins — the CLI and the server — and the CLI is the one whose name matches the
package, so `npx concord-engine` starts the **CLI**: it prints help to stdout
and exits 0. To an MCP host over stdio that is garbage on the protocol channel
followed by a closed stream.

An MCP registry entry names an npm package, and a host runs the bin matching
that name. So the server needs a package whose name *is* the server's bin name.
This is that package: one file, which imports `concord-engine/mcp`.

It also declares `@modelcontextprotocol/sdk` as a real dependency.
`concord-engine` keeps it an optional peer, so running its server bin from a
bare install fails on the missing SDK — which is why the older launch command
had to pass `-p @modelcontextprotocol/sdk` by hand.

## Configuration

`CONCORD_ENGINE_DIR` — where the decision log lives. Defaults to
`.concord-engine` in the working directory. Commit it: the log is the shared
contract between your agents.

The server reports the absolute path it resolved on every answer. An empty
result is not proof that nothing was decided — if the path is not your
project's, the decisions you need are in another log.

## Everything else

Documentation, the CLI, and the skill live in the
[main repository](https://github.com/harsh-chandak/concord-engine). This
package is a launcher and carries no logic of its own.

## License

MIT
