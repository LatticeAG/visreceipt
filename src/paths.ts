import { VisReceiptError } from "./errors.js";

export function sidecarPath(vrsPath: string): string {
  if (vrsPath.endsWith(".vrs") || vrsPath.endsWith(".json")) {
    return `${vrsPath}.vrc`;
  }
  throw new VisReceiptError("VRC3002", { detail: vrsPath });
}
