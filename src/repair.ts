import { readFile } from "node:fs/promises";

import { VisReceiptError } from "./errors.js";

export function repairTail(text: string): { text: string; truncated: boolean; last_seq: number } {
  if (text.includes("\r")) {
    throw new VisReceiptError("VRC1003", { detail: "crlf" });
  }
  if (text.length === 0) {
    return { text: "", truncated: false, last_seq: 0 };
  }
  const hadTrailingNl = text.endsWith("\n");
  const lines = (hadTrailingNl ? text.slice(0, -1) : text).split("\n");
  const kept: string[] = [];
  let lastSeq = 0;
  let truncated = !hadTrailingNl;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      const parsed = JSON.parse(line) as { seq?: number };
      kept.push(line);
      if (typeof parsed.seq === "number") {
        lastSeq = parsed.seq;
      }
    } catch {
      truncated = true;
      break;
    }
  }
  const out = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
  return { text: out, truncated, last_seq: lastSeq };
}

export async function readLedgerFile(path: string): Promise<string> {
  const buf = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new VisReceiptError("VRC1003", { detail: "invalid_utf8" });
  }
  if (text.includes("\r")) {
    throw new VisReceiptError("VRC1003", { detail: "crlf" });
  }
  return text;
}
