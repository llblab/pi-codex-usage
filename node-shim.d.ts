declare module "node:child_process" {
  type WritablePipe = {
    writable: boolean;
    write(chunk: string): void;
    end(): void;
  };
  type ReadablePipe = {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
  };
  export type ChildProcessWithoutNullStreams = {
    stdin: WritablePipe;
    stdout: unknown;
    stderr: ReadablePipe;
    killed: boolean;
    kill(): void;
    once(event: "spawn", listener: () => void): void;
    once(event: "error", listener: (error: Error) => void): void;
    once(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  };
  export function spawn(command: string, args?: readonly string[], options?: unknown): ChildProcessWithoutNullStreams;
}

declare module "node:readline" {
  export function createInterface(options: { input: unknown }): { on(event: "line", listener: (line: string) => void): void };
}
