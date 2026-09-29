export interface TerminalUI {
  readonly section: (title: string) => void;
  readonly note: (message: string) => void;
  readonly success: (message: string) => void;
  readonly failure: (message: string) => void;
  readonly run: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
}

type Writer = { write: (text: string) => unknown };

export function createTerminalUI(writer: Writer = process.stdout, isTTY = Boolean(process.stdout.isTTY)): TerminalUI {
  return {
    section(title) {
      writer.write(`\n${title}\n${"─".repeat(title.length)}\n`);
    },
    note(message) {
      writer.write(`  ${message}\n`);
    },
    success(message) {
      writer.write(`  ✓ ${message}\n`);
    },
    failure(message) {
      writer.write(`  ! ${message}\n`);
    },
    async run(label, operation) {
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
      let frame = 0;
      const draw = () => writer.write(`\r\x1b[2K  ${frames[frame++ % frames.length]} ${label}`);
      if (isTTY) draw();
      else writer.write(`  ... ${label}\n`);
      const timer = isTTY ? setInterval(draw, 80) : undefined;
      try {
        const result = await operation();
        if (timer) clearInterval(timer);
        writer.write(`${isTTY ? "\r\x1b[2K" : ""}  ✓ ${label}\n`);
        return result;
      } catch (error) {
        if (timer) clearInterval(timer);
        writer.write(`${isTTY ? "\r\x1b[2K" : ""}  ! ${label} failed\n`);
        throw error;
      }
    },
  };
}
