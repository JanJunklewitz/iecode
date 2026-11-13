// The LogFs of core/logRead.ts over Node fs: regular *.log files of one directory, read through a verified handle.

import { promises as fsp } from 'fs';
import { basename, join } from 'path';
import type { LogFile, LogFs } from '../core/logRead';

export function nodeLogFs(dir: string): LogFs {
  const list = async (): Promise<LogFile[]> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out: LogFile[] = [];
    for (const e of entries) {
      // Dirent.isFile() is false for symbolic links, so a link named *.log is never listed
      if (!e.isFile() || !/\.log$/i.test(e.name)) continue;
      out.push({ name: e.name, size: (await fsp.stat(join(dir, e.name))).size });
    }
    return out;
  };
  return {
    list,
    async read(name, from, length) {
      // a plain *.log name of this folder that is a regular file (lstat does not follow links)
      if (basename(name) !== name || !/\.log$/i.test(name) || !(await fsp.lstat(join(dir, name))).isFile()) throw new Error(`not a log file: ${name}`);
      const handle = await fsp.open(join(dir, name), 'r');
      try {
        if (!(await handle.stat()).isFile()) throw new Error(`not a log file: ${name}`);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, from);
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
