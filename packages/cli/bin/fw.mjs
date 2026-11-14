#!/usr/bin/env node
// The workspace runs from TypeScript source, so the CLI loads through tsx.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv.slice(2));
