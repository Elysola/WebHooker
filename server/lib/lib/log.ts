/** An Error as JSON keeps its message, stack and cause (it would print as `{}`). */
function plain(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined && depth < 3 ? { cause: plain(value.cause, depth + 1) } : {}),
    };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v, depth + 1)]),
    );
  }
  return value;
}

/**
 * One JSON line: `log.x("text")`, or `log.x({ ...fields }, "text")` — the
 * fields (errors included, with their message and stack) beside the text.
 */
function line(level: string, first: string | object, args: unknown[]): string {
  if (typeof first === "string") return JSON.stringify({ level, msg: first, ...args });
  const [text, ...rest] = args;
  return JSON.stringify({
    level,
    msg: typeof text === "string" ? text : undefined,
    ...(plain(first) as Record<string, unknown>),
    ...(typeof text === "string" ? rest : args),
  });
}

export const log = {
  info: (msg: string | object, ...args: unknown[]): void => console.log(line("info", msg, args)),
  warn: (msg: string | object, ...args: unknown[]): void => console.warn(line("warn", msg, args)),
  error: (msg: string | object, ...args: unknown[]): void =>
    console.error(line("error", msg, args)),
  fatal: (msg: string | object, ...args: unknown[]): void =>
    console.error(line("fatal", msg, args)),
};
