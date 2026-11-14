import { resolve } from 'node:path';
import { check, format, type Io } from './commands.ts';

export interface MainOptions {
  /** The project folder. Defaults to the current directory. */
  cwd?: string;
  /** Where normal output goes. Defaults to stdout. */
  out?: (line: string) => void;
  /** Where problems go. Defaults to stderr. */
  err?: (line: string) => void;
}

const USAGE = `Usage: fw <command> [options]

Commands:
  check [paths]            Check forms, regenerate .form.gen.ts files, run tsc --noEmit
                           --no-tsc  skip the TypeScript check
  fmt [paths] [--check]    Rewrite forms in the standard layout. --check only lists differences
  dev [--port N] [--host]  Start the dev server (default port 5173)
  build                    Build static files into dist/

[paths] are form files or folders. The default is the current folder.`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--port']);

function parse(args: readonly string[]): Parsed {
  const [command, ...rest] = args;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) positional.push(arg);
    else if (VALUE_FLAGS.has(arg)) flags.set(arg, rest[++i] ?? '');
    else flags.set(arg, true);
  }
  return { command, positional, flags };
}

const KNOWN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  check: ['--no-tsc'],
  fmt: ['--check'],
  dev: ['--port', '--host'],
  build: [],
};

/** Runs `fw`. Returns the exit code: 0 for success, 1 for problems found, 2 for a command that can't run. */
export async function main(args: readonly string[], options: MainOptions = {}): Promise<number> {
  const io: Io = {
    cwd: resolve(options.cwd ?? process.cwd()),
    out: options.out ?? ((line) => console.log(line)),
    err: options.err ?? ((line) => console.error(line)),
  };
  const { command, positional, flags } = parse(args);

  if (command === undefined || command === 'help' || command === '--help') {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const known = KNOWN_FLAGS[command];
  if (!known) {
    io.err(`Unknown command "${command}"\n${USAGE}`);
    return 2;
  }
  const unknownFlag = [...flags.keys()].find((flag) => !known.includes(flag));
  if (unknownFlag) {
    io.err(`Unknown option ${unknownFlag} for fw ${command}`);
    return 2;
  }

  try {
    switch (command) {
      case 'check':
        return check(io, positional, { tsc: !flags.has('--no-tsc') });
      case 'fmt':
        return format(io, positional, flags.has('--check'));
      case 'dev': {
        const port = flags.has('--port') ? Number(flags.get('--port')) : undefined;
        if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
          io.err('--port needs a number from 1 to 65535');
          return 2;
        }
        return await (await import('./vite.ts')).dev(io, port, flags.has('--host'));
      }
      default:
        return await (await import('./vite.ts')).build(io);
    }
  } catch (failure) {
    io.err(`fw ${command}: ${(failure as Error).message}`);
    return 2;
  }
}
