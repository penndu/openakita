"""Keep Playwright browser binaries out of the frozen core package.

See hook-playwright.async_api.py. BrowserManager resolves the same managed
optional driver for both APIs.
"""

datas = []
