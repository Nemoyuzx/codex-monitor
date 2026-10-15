#!/usr/bin/env node
import { commandArgs } from '../monitor-options.mjs';

// Resolve imports relative to this entry, so launching never depends on cwd.
process.argv.splice(2, process.argv.length - 2, ...commandArgs(process.argv.slice(2)));
await import('../codex-status.mjs');
