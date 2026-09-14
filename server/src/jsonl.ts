/**
 * Strict JSONL framing for pi's RPC stream.
 *
 * pi's RPC mode uses LF as the *only* record delimiter, so Node's `readline` is
 * not protocol-compliant: it also splits on U+2028/U+2029, which are legal
 * inside JSON strings and would corrupt records. This splitter works on raw
 * bytes and only ever breaks on 0x0A, tolerating an optional trailing CR.
 */
// Value import (not `import type`): Buffer.alloc/concat are used at runtime.
import { Buffer } from "node:buffer";

export class JsonlSplitter {
  private pending: Buffer = Buffer.alloc(0);

  /** Feed a stdout chunk, returning the complete lines it produced. */
  push(chunk: Buffer): string[] {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const lf = this.pending.indexOf(0x0a, start);
      if (lf === -1) break;
      let end = lf;
      if (end > start && this.pending[end - 1] === 0x0d) end -= 1;
      if (end > start)
        lines.push(this.pending.subarray(start, end).toString("utf8"));
      start = lf + 1;
    }

    this.pending = start === 0 ? this.pending : this.pending.subarray(start);
    return lines;
  }

  /** Any trailing bytes not terminated by a newline (e.g. at process exit). */
  flush(): string | null {
    if (this.pending.length === 0) return null;
    const text = this.pending.toString("utf8").replace(/\r$/, "");
    this.pending = Buffer.alloc(0);
    return text.length > 0 ? text : null;
  }
}

/** Serialize one record with the delimiter pi expects. */
export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
