#!/usr/bin/env node
import { quietOnEpipe, run } from './run.js';

quietOnEpipe(process.stdout);
process.exitCode = await run(process.argv.slice(2));
