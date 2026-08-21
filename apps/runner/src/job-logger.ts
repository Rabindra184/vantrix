import { mkdir } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';

export class JobLogger {
  readonly path: string;
  readonly stream: WriteStream;
  #failed: Error | null = null;

  private constructor(logPath: string, stream: WriteStream) {
    this.path = logPath;
    this.stream = stream;
  }

  static async create(logDir: string, jobId: string): Promise<JobLogger> {
    await mkdir(logDir, { recursive: true });
    const logPath = path.resolve(logDir, `${jobId}.log`);
    const stream = createWriteStream(logPath, { flags: 'a' });
    const logger = new JobLogger(logPath, stream);
    stream.on('error', (err) => {
      logger.#failed = err;
      console.error(`runner job log stream failed for ${jobId}`, err);
    });
    return logger;
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

  close(timeoutMs = 5000): Promise<void> {
    if (this.stream.destroyed || this.stream.closed) return Promise.resolve();
    if (this.#failed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.stream.off('finish', onFinish);
        this.stream.off('close', onClose);
        this.stream.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onFinish = () => finish();
      const onClose = () => finish();
      const onError = (err: Error) => finish(err);
      const timer = setTimeout(() => finish(), timeoutMs);
      timer.unref();
      this.stream.once('finish', onFinish);
      this.stream.once('close', onClose);
      this.stream.once('error', onError);
      this.stream.end();
    });
  }

  #write(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `[${new Date().toISOString()}] [runner] [${level}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (!this.stream.destroyed && !this.#failed) this.stream.write(`${line}\n`);
  }
}
