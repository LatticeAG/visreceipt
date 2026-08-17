import { watch as fsWatch, readdirSync, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { sealFromSession, type AttachOptions } from "./attach.js";
import { sidecarPath } from "./paths.js";
import {
  DEFAULT_MAX_SESSION_EVENTS,
  DEFAULT_MAX_SESSION_FILE_BYTES,
  loadVrs
} from "./vrs.js";

export interface WatchOptions extends AttachOptions {
  debounceMs?: number;
  recursive?: boolean;
  maxFileBytes?: number;
  maxEvents?: number;
  stderr?: (text: string) => void;
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  seal?: (path: string) => Promise<{ seq: number; hash: string }>;
}

export interface WatchHandle {
  note(filename: string, dir?: string): void;
  flush(): Promise<void>;
  close(): void;
}

const TMP_VRS = /\.vrs\.[^/]*\.tmp$/;

export function shouldSkipWatchName(name: string): boolean {
  if (name.length === 0) {
    return true;
  }
  if (TMP_VRS.test(name) || name.endsWith(".tmp")) {
    return true;
  }
  return !name.endsWith(".vrs");
}

export class WatchController {
  private readonly queued = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly last = new Map<string, { size: number; mtimeMs: number }>();
  private readonly inflight: Promise<void>[] = [];
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly opts: WatchOptions = {}
  ) {}

  note(filename: string, dir = this.dir): void {
    if (this.closed || shouldSkipWatchName(filename)) {
      return;
    }
    const fullPath = join(dir, filename);
    const key = filename;
    this.queued.set(key, fullPath);
    const prev = this.timers.get(key);
    if (prev) {
      clearTimeout(prev);
    }
    const wait = this.opts.debounceMs ?? 200;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const path = this.queued.get(key);
      this.queued.delete(key);
      if (path) {
        this.inflight.push(this.sealPath(path));
      }
    }, wait);
    this.timers.set(key, timer);
  }

  async flush(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    const paths = [...this.queued.values()];
    this.queued.clear();
    for (const path of paths) {
      this.inflight.push(this.sealPath(path));
    }
    await Promise.all(this.inflight.splice(0, this.inflight.length));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.queued.clear();
  }

  private writeErr(text: string): void {
    if (this.opts.stderr) {
      this.opts.stderr(text);
      return;
    }
    process.stderr.write(text);
  }

  private async sealPath(path: string): Promise<void> {
    const statFn = this.opts.stat ?? defaultStat;
    let st: { size: number; mtimeMs: number };
    try {
      st = await statFn(path);
    } catch {
      return;
    }
    if (st.size === 0) {
      return;
    }
    const prev = this.last.get(path);
    if (prev && st.mtimeMs <= prev.mtimeMs && st.size === prev.size) {
      return;
    }
    this.last.set(path, { size: st.size, mtimeMs: st.mtimeMs });
    try {
      const sealer = this.opts.seal ?? ((filePath: string) => this.defaultSeal(filePath));
      const result = await sealer(path);
      this.writeErr(`sealed ${path} seq=${result.seq} head=${result.hash}\n`);
    } catch {
      this.writeErr("VRC2013 watch_inflight_fail\n");
    }
  }

  private async defaultSeal(path: string): Promise<{ seq: number; hash: string }> {
    const session = await loadVrs(path, {
      maxFileBytes: this.opts.maxFileBytes ?? DEFAULT_MAX_SESSION_FILE_BYTES,
      maxEvents: this.opts.maxEvents ?? DEFAULT_MAX_SESSION_EVENTS
    });
    const result = await sealFromSession(session, sidecarPath(path), {
      include_wrap_io: this.opts.include_wrap_io,
      payload_mode: this.opts.payload_mode,
      fsync: this.opts.fsync,
      emit: this.opts.emit,
      source_path: path
    });
    return { seq: result.last.seq, hash: result.last.hash };
  }
}

async function defaultStat(path: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await stat(path);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

export function watchDirectory(dir: string, opts: WatchOptions = {}): WatchHandle {
  const controller = new WatchController(dir, opts);
  const watchers: FSWatcher[] = [];
  watchers.push(
    fsWatch(dir, (_event, filename) => {
      if (typeof filename === "string") {
        controller.note(filename, dir);
      }
    })
  );
  if (opts.recursive) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) {
        continue;
      }
      const sub = join(dir, ent.name);
      watchers.push(
        fsWatch(sub, (_event, filename) => {
          if (typeof filename === "string") {
            controller.note(filename, sub);
          }
        })
      );
    }
  }
  return {
    note: (filename, noteDir) => controller.note(filename, noteDir ?? dir),
    flush: () => controller.flush(),
    close: () => {
      controller.close();
      for (const watcher of watchers) {
        watcher.close();
      }
    }
  };
}
