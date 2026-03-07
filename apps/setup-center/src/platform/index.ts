// ─── Platform Abstraction Layer (minimal for feedback download backport) ───
// Provides downloadFile / showInFolder across Tauri desktop and Web.

import { IS_TAURI, IS_WEB, IS_CAPACITOR } from "./detect";
export { IS_TAURI, IS_WEB, IS_CAPACITOR };

/**
 * Download a URL to a file.
 * - Tauri (Win/Mac/Linux): Native HTTP GET → save to user Downloads → returns path.
 * - Web: Programmatic <a download> click; backend must send Content-Disposition: attachment.
 * Returns: saved path (Tauri) or filename (Web).
 */
export async function downloadFile(
  url: string,
  filename: string,
): Promise<string> {
  if (IS_TAURI) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<string>("download_file", { url, filename });
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return filename;
}

/** Show a file in the OS file manager. No-op on web. */
export async function showInFolder(path: string): Promise<void> {
  if (!IS_TAURI) return;
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  await tauriInvoke("show_item_in_folder", { path });
}
