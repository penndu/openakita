import { copyToClipboard } from "../utils/clipboard";

type ToastContainerProps = {
  busy: string | null;
  notice: string | null;
  error: string | null;
  onDismissNotice: () => void;
  onDismissError: () => void;
  /** 点击错误 Toast 时若复制成功则调用（用于显示「已复制」提示） */
  onCopySuccess?: () => void;
  /** 错误 Toast 的 title 提示，如「点击复制」 */
  errorClickToCopyTitle?: string;
};

export function ToastContainer({
  busy,
  notice,
  error,
  onDismissNotice,
  onDismissError,
  onCopySuccess,
  errorClickToCopyTitle,
}: ToastContainerProps) {
  if (!busy && !notice && !error) return null;
  const handleErrorClick = async () => {
    if (!error) return;
    const ok = await copyToClipboard(error);
    if (ok) {
      onCopySuccess?.();
      onDismissError();
    }
  };
  return (
    <div className="toastContainer">
      {busy && <div className="toast toastInfo">{busy}</div>}
      {notice && <div className="toast toastOk" onClick={onDismissNotice}>{notice}</div>}
      {error && (
        <div
          className="toast toastError"
          title={errorClickToCopyTitle}
          onClick={handleErrorClick}
        >
          {error}
        </div>
      )}
    </div>
  );
}
