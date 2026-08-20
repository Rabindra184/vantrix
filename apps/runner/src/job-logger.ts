import { mkdir } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';

export class JobLogger {
  readonly path: string;
  readonly stream: WriteStream;

  private constructor(logPath: string, stream: WriteStream) {
    this.path = logPath;
    this.stream = stream;
  }

  static async create(logDir: string, jobId: string): Promise<JobLogger> {
    await mkdir(logDir, { recursive: true });
    const logPath = path.resolve(logDir, `${jobId}.log`);
    const stream = createWriteStream(logPath, { flags: 'a' });
    stream.on('error', (err) => {
      console.error(`runner job log stream failed for ${jobId}`, err);
    });
    return new JobLogger(logPath, stream);
  }

  info(message: string): void {
    this.#write('info', message);
  }

  warn(message: string): void {
    this.#write('warn', message);
  }

  error(message: string): void {
    this.#write('error', message);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.once('finish', resolve);
      this.stream.once('error', reject);
      this.stream.end();
    });
  }

  #write(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `[${new Date().toISOString()}] [runner] [${level}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.stream.write(`${line}\n`);
  }
}
