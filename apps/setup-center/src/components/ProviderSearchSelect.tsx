import { useEffect, useMemo, useRef, useState } from "react";

export function ProviderSearchSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  extraOptions,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  extraOptions?: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const justSelected = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allOptions = useMemo(() => {
    const base = extraOptions ? [...extraOptions, ...options] : options.slice();
    return base;
  }, [options, extraOptions]);

  const selectedLabel = useMemo(
    () => allOptions.find((o) => o.value === value)?.label ?? "",
    [allOptions, value],
  );

  const displayValue = isFocused ? search : selectedLabel;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? allOptions.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      : allOptions;
    return list.slice(0, 200);
  }, [allOptions, search]);

  useEffect(() => {
    if (hoverIdx >= filtered.length) setHoverIdx(0);
  }, [filtered.length, hoverIdx]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          value={displayValue}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          placeholder={placeholder || "搜索服务商..."}
          onClick={() => { if (!open) { setIsFocused(true); setSearch(""); setOpen(true); } }}
          onFocus={() => { setIsFocused(true); setSearch(""); setOpen(true); }}
          onBlur={() => {
            setIsFocused(false);
            blurTimer.current = setTimeout(() => {
              blurTimer.current = null;
              setOpen(false);
              if (justSelected.current) {
                justSelected.current = false;
                return;
              }
              setSearch("");
            }, 150);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHoverIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHoverIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              if (open && filtered[hoverIdx]) {
                e.preventDefault();
                justSelected.current = true;
                onChange(filtered[hoverIdx].value);
                setSearch("");
                setOpen(false);
                setIsFocused(false);
              }
            } else if (e.key === "Escape") {
              setSearch("");
              setOpen(false);
              setIsFocused(false);
            }
          }}
          disabled={disabled}
          style={{ paddingRight: 44, width: "100%", padding: "8px 44px 8px 10px", borderRadius: 8, border: "1px solid var(--line)", fontSize: 13 }}
        />
        <button
          type="button"
          className="btnSmall"
          onClick={() => {
            if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
            if (!open) { setSearch(""); }
            setOpen((v) => !v);
            inputRef.current?.focus();
          }}
          disabled={disabled}
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            width: 34,
            height: 30,
            padding: 0,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
          }}
        >
          ▾
        </button>
      </div>
      {open && !disabled ? (
        <div
          style={{
            position: "absolute",
            zIndex: 50,
            left: 0,
            right: 0,
            marginTop: 6,
            maxHeight: 280,
            overflow: "auto",
            border: "1px solid var(--line)",
            borderRadius: 14,
            background: "var(--panel2)",
            boxShadow: "0 18px 60px rgba(17, 24, 39, 0.14)",
          }}
          onMouseDown={(e) => { e.preventDefault(); }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: 12, color: "var(--muted)", fontWeight: 650 }}>没有匹配项</div>
          ) : (
            filtered.map((opt, idx) => (
              <div
                key={opt.value}
                onMouseEnter={() => setHoverIdx(idx)}
                onClick={() => {
                  justSelected.current = true;
                  onChange(opt.value);
                  setSearch("");
                  setOpen(false);
                  setIsFocused(false);
                }}
                style={{
                  padding: "10px 12px",
                  cursor: "pointer",
                  fontWeight: 650,
                  background: opt.value === value
                    ? "rgba(14, 165, 233, 0.16)"
                    : idx === hoverIdx
                      ? "rgba(14, 165, 233, 0.06)"
                      : "transparent",
                  borderTop: idx === 0 ? "none" : "1px solid rgba(17,24,39,0.06)",
                }}
              >
                {opt.value === value ? `✓ ${opt.label}` : opt.label}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
