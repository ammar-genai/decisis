#!/usr/bin/env node
import { run } from '../src/cli.mjs';

const { code, out } = await run(process.argv.slice(2));
(code === 0 ? process.stdout : process.stderr).write(out + '\n');
process.exit(code);
