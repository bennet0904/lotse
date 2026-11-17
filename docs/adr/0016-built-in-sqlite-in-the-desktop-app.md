# 16. Built-in SQLite in the desktop app

Status: Accepted

## Context

A native module compiled for Node.js does not load in Electron, and rebuilding `better-sqlite3` for every Electron version complicates packaging.

## Decision

The server supports two SQLite drivers: `better-sqlite3` by default under Node.js, and the SQLite built into Node.js (`node:sqlite`) through Drizzle's proxy driver. Inside Electron the built-in one is used automatically. The desktop app's main process is bundled into a single file without native modules.

## Consequences

The desktop app needs no native rebuild and no `node_modules` folder. Both drivers run the same database tests.
