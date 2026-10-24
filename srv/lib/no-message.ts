const sentinel = 'NO_MESSAGE';
const prefixes = Array.from({ length: sentinel.length }, (_, i) =>
  sentinel.slice(0, i + 1),
).join('|');
const leadingCandidate = new RegExp(`^\\s*(?:${prefixes})?$`);
const trailingCandidate = new RegExp(
  `\\s+(?:NO_MESSAGE\\s+)*(?:${prefixes})?$`,
);

/** Remove standalone boundary sentinels, preserving mentions within text. */
export function stripNoMessage(text: string): string {
  return text
    .replace(/^(?:\s*NO_MESSAGE(?=\s|$))+\s*/, '')
    .replace(/(?:\s+NO_MESSAGE)+\s*$/, '');
}

/** Buffer only boundaries that could still turn into a sentinel. */
export class NoMessageFilter {
  private pending = '';
  private leading = true;

  push(delta: string): string {
    this.pending += delta;
    if (this.leading) {
      this.pending = this.pending.replace(/^(?:\s*NO_MESSAGE(?=\s))+\s*/, '');
      if (leadingCandidate.test(this.pending)) return '';
      this.leading = false;
    }
    const suffix = trailingCandidate.exec(this.pending);
    const end = suffix?.index ?? this.pending.length;
    const content = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    return content;
  }

  finish(): string {
    const content = stripNoMessage(this.pending);
    this.pending = '';
    return content;
  }
}
