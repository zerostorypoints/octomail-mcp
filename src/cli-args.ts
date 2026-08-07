// Shared flag-parsing for the CLI entry points (auth.ts, setup.ts). Both
// scripts read the same `--account`/`--label` style flags; keeping the
// parsing in one place means they cannot silently drift out of sync the way
// they did before (auth.ts accepted `--account --label x` as an account
// literally named "--label").

/**
 * Reads a single `--key value` or `--key=value` flag out of argv.
 *
 * A bare `--key` immediately followed by another flag (e.g.
 * `--account --label x`) is treated as missing rather than consuming the
 * next flag as its value.
 */
export function readFlagValue(argv: string[], key: string): string | undefined {
  const flagIndex = argv.indexOf(`--${key}`);
  if (flagIndex >= 0 && argv[flagIndex + 1] && !argv[flagIndex + 1].startsWith("--")) {
    return argv[flagIndex + 1];
  }

  const inline = argv.find((arg) => arg.startsWith(`--${key}=`));
  return inline ? inline.slice(`--${key}=`.length) : undefined;
}
