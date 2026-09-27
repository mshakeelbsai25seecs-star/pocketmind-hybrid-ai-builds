const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const SHA256 = /\b[a-fA-F0-9]{64}\b/g;
const MD5 = /\b[a-fA-F0-9]{32}\b/g;
const URL = /\bhttps?:\/\/[^\s"'<>]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function extractIocsFromText(text: string): string[] {
  if (!text.trim()) return [];
  const found = new Set<string>();
  for (const re of [IPV4, SHA256, MD5, URL, EMAIL]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) found.add(m[0]!);
  }
  return [...found].slice(0, 80);
}
