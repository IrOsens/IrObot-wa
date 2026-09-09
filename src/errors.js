export class UserInputError extends Error {
  constructor(message) { super(message); this.name = 'UserInputError'; }
}
export class SetupRequiredError extends UserInputError {
  constructor(feature) {
    super(`Tujuan ${feature} belum siap. Ketik ,setup ${feature} untuk memilih tujuan.`);
    this.feature = feature;
  }
}
export function redactError(value) {
  return String(value ?? '').replace(/(bearer\s+)[\w.+/-]+/gi, '$1[REDACTED]')
    .replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s]+/g, (url) => { try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; return u.toString(); } catch { return '[URL]'; } });
}
