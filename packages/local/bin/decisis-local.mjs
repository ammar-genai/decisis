#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serve } from '../src/server.mjs';
import { DEFAULT_MODEL } from '../src/decider.mjs';

const { values: v } = parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (v.help) {
  console.log(`decisis-local - typed decisions from a model on this machine, behind a Decisions-shaped endpoint

  decisis-local [--port 8088] [--host 127.0.0.1] [--model <hugging face id>]

Point any decisis client at it:
  jevDecider({ url: 'http://127.0.0.1:8088/decisions', key: 'unused' })

The model (about 350 MB) downloads once on the first decision, then runs offline.
Default: ${DEFAULT_MODEL}`);
  process.exit(0);
}
const port = Number(v.port ?? 8088);
const host = v.host ?? '127.0.0.1';
await serve({ port, host, ...(v.model ? { model: v.model } : {}) });
console.log(`decisis-local listening on http://${host}:${port}  (model ${v.model ?? DEFAULT_MODEL})`);
