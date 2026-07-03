import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act, waitFor, fireEvent } from "@testing-library/react";

const saveAttachment = vi.fn(async () => {});
vi.mock("../../platform", () => ({
  saveAttachment: (...a: unknown[]) => saveAttachment(...a),
  showInFolder: vi.fn(),
  openFileWithDefault: vi.fn(),
  IS_TAURI: false,
}));
vi.mock("../../platform/auth", () => ({ getAccessToken: () => "test-token" }));
vi.mock("../../views/chat/hooks/useMdModules", () => ({ useMdModules: () => null }));

const blobFn = vi.fn(async () => new Blob(["%PDF-1.4 fake"], { type: "application/pdf" }));
const safeFetch = vi.fn(async () => ({ ok: true, status: 200, blob: blobFn } as unknown as Response));
vi.mock("../../providers", () => ({ safeFetch: (...a: unknown[]) => safeFetch(...(a as [string])) }));

import { FileAttachmentCard } from "../FileAttachmentCard";

describe("FileAttachmentCard PDF preview (test18)", () => {
  beforeEach(() => {
    saveAttachment.mockClear();
    safeFetch.mockClear();
    // jsdom has no object-URL impl.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock-pdf");
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  it("previews a PDF via an authed blob object URL, not a bare src, and does NOT download", async () => {
    const { getByTitle } = render(
      <FileAttachmentCard
        file={{ filename: "最终报告.pdf", file_path: "D:/o/最终报告.pdf" }}
        apiBaseUrl="http://test"
      />,
    );
    // The primary click is preview (docKind), not download.
    const previewBtn = getByTitle("点击预览 · 右键更多操作");
    await act(async () => { fireEvent.click(previewBtn); });

    // The preview modal is portaled to document.body, not the render container.
    await waitFor(() => {
      const iframe = document.body.querySelector("iframe");
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute("src")).toBe("blob:mock-pdf");
    });
    // Fetched through the authed path (safeFetch), against the inline URL.
    expect(safeFetch).toHaveBeenCalled();
    expect(String(safeFetch.mock.calls[0][0])).toContain("inline=1");
    // Preview must never trigger a download.
    expect(saveAttachment).not.toHaveBeenCalled();
  });
});
