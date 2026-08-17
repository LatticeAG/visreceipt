import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { visreceiptConfigSchema, type VisreceiptConfig } from "./types.js";

export const CONFIG_NAME = "visreceipt.json";

export interface LoadConfigOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function findConfigPath(opts?: LoadConfigOpts): string | undefined {
  const env = opts?.env ?? process.env;
  const override = env.VISRECEIPT_CONFIG;
  if (typeof override === "string" && override.trim().length > 0) {
    return resolve(override);
  }
  let dir = resolve(opts?.cwd ?? process.cwd());
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function defaultConfig(): VisreceiptConfig {
  return visreceiptConfigSchema.parse({ schema_version: 1 });
}

export function loadConfig(opts?: LoadConfigOpts): VisreceiptConfig {
  const path = findConfigPath(opts);
  if (!path) {
    return defaultConfig();
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read visreceipt.json: ${message}`);
  }
  if (text.includes("\r")) {
    throw new Error("visreceipt.json must be UTF-8 LF");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid visreceipt.json: ${message}`);
  }
  const result = visreceiptConfigSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? first.path.join(".") : "root";
    throw new Error(`invalid visreceipt.json: ${where}: ${first?.message ?? "invalid"}`);
  }
  return result.data;
}
