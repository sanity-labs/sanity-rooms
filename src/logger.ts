/** Pluggable logger interface. Defaults to `console` when not provided. */
export interface Logger {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** Default logger that writes to the console. */
export const consoleLogger: Logger = console
