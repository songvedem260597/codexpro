export function preparePowerShellCommand(command) {
  const raw = String(command ?? '');
  const trimmed = raw.trimStart();
  const quotedExecutable = /^(?:"[^"\r\n]+\.(?:exe|cmd|bat|com)"|'[^'\r\n]+\.(?:exe|cmd|bat|com)')(?:\s|$)/i;
  if (!quotedExecutable.test(trimmed)) return raw;
  const leadingWhitespace = raw.slice(0, raw.length - trimmed.length);
  return `${leadingWhitespace}& ${trimmed}`;
}
