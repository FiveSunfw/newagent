export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value.replace(
      /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
      "Bearer [REDACTED]",
    );
    for (const [key, secret] of Object.entries(process.env))
      if (
        secret &&
        secret.length >= 8 &&
        /(?:_KEY$|_TOKEN$|SECRET|PASSWORD)/i.test(key)
      )
        text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /api_?key|authorization|password|secret|access_?token|refresh_?token/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  return value;
}
