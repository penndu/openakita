/**
 * 全局 fetch 拦截：macOS WKWebView 的 fetch() 遵守系统代理设置，
 * 代理软件（Clash/V2Ray 等）运行时，对 127.0.0.1 的请求会被路由到
 * 代理服务器而非直连本地后端。
 *
 * 解决方案：在 Tauri 环境下，用 Tauri HTTP 插件的 fetch() 替代原生 fetch()。
 * 插件走 Rust reqwest，配合 Rust 端设置的 NO_PROXY 环境变量绕过系统代理。
 * 支持 JSON、FormData、SSE 流式响应，与原生 fetch 行为一致。
 *
 * 仅拦截 localhost 请求，其他请求仍走浏览器原生 fetch。
 * 在非 Tauri 环境（如 `npm run dev` 的浏览器）下不做任何拦截。
 */
const LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/;

export function installLocalFetchOverride(): void {
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window)
  ) {
    return;
  }

  const nativeFetch = window.fetch.bind(window);

  let tauriFetchFn: typeof fetch | null = null;
  import("@tauri-apps/plugin-http").then((mod) => {
    tauriFetchFn = mod.fetch as typeof fetch;
  });

  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else if (input instanceof Request) url = input.url;
    else return nativeFetch(input, init);

    if (!LOCAL_RE.test(url)) {
      return nativeFetch(input, init);
    }

    if (!tauriFetchFn) {
      const mod = await import("@tauri-apps/plugin-http");
      tauriFetchFn = mod.fetch as typeof fetch;
    }
    return tauriFetchFn(input, init);
  };
}
