#!/usr/bin/env node
// The whole package. Importing the subpath starts the server: dist/mcp.js ends
// in `await server.connect(new StdioServerTransport())`, so there is nothing to
// call and nothing to pass through — this process IS the server, and stdio is
// already wired to it.
//
// A child process would mean proxying stdin/stdout, and stdout is the protocol
// channel: anything that buffers, re-chunks or interleaves it corrupts framing.
import "concord-engine/mcp";
