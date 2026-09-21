import { ParseError } from "./types.ts";

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

export function extractSubmitEnc(html: string): string {
  const tags = html.match(/<input\b[^>]*>/gi) ?? [];
  const tag = tags.find((candidate) => attribute(candidate, "id") === "submit_enc");
  const value = tag ? attribute(tag, "value") : null;
  if (value === null || value.length === 0) throw new ParseError("submit_enc input is missing or empty");
  return value;
}
