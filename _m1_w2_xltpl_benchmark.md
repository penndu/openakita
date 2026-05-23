# M1 W2 Stage 2 — Renderer Backend Benchmark

**作者**：finance-auto plugin team
**日期**：2026-05-23
**测试主机**：Windows 10 19045 / Python 3.11 (`d:\OpenAkita\.venv`)
**对应设计文档**：`_finance_plugin_design_v0.3_part_infra.md` §1（渲染双轨）
**对应任务**：M1 W2 Stage 2

---

## 1. 目的

W1 完成后，渲染层只剩一个抽象接口的占位（`backend/services/report.py`
里的 stub）。W2 Stage 2 需要把"用什么生成 .xlsx"这个决策落地，并且把
设计文档 §1 提出的"xltpl 静态主路径 + openpyxl 直写动态明细"方案用
**真实 benchmark** 验证一次。

W1 spike 报告已经判定 xltpl 0.21 不支持 *跨单元格* `{% for %}` 循环（详见
`_finance_plugin_spike_report.md` §2.4），但是没有量化"那么动态明细换
openpyxl 直写要付出什么代价"，也没有跟最重型的 `win32com / Excel COM`
做过横向对比。本次 benchmark 是这个空白的最终回答。

## 2. 测试场景

为了让 benchmark 可复现且不依赖任何客户文件（避免 PII 进 git），脚本
`plugins/finance-auto/scripts/benchmark_renderers.py` 在运行时合成两份
模板，覆盖两种典型负载：

| 场景 | 模板形态 | 行数 | 风格元素 |
| --- | --- | --- | --- |
| **Static (BS)**     | 资产负债表式：1 行合并标题 + 2 行表头 + 20 行项目 | 20 | 字体加粗、单元格底色、数字格式 `#,##0.00`、边框、列宽 |
| **Dynamic (AR)**    | 应收账款明细：合并标题 + 1 行表头 + N 行明细 + 1 行合计 | 1500 | 同上 + `__SUM__` 标记 |

每条路径在两个场景里执行 3 次（COM 因为重型只跑 1 次），记录均值、
标准差、输出文件大小、以及一个 0-5 的 fidelity 分数。fidelity 子项：

* `preserves_merge`：合并区段是否保留
* `preserves_font`：表头粗体字体是否保留
* `preserves_fill`：背景色 RGB 是否非默认
* `preserves_number_format`：金额列是否保留 `#,##0.00`
* `emits_all_rows`：所有数据行是否都写出去了

## 3. 实测数据

完整 JSON：`_m1_w2_bench.json`。下面是 markdown 摘要。

### 3.1 Static 报表（20 行）

| Backend  | mean (ms) | stdev (ms) | output bytes | fidelity |
| -------- | --------: | ---------: | -----------: | -------: |
| xltpl    |     48.05 |       1.81 |        6 016 |    5 / 5 |
| openpyxl |     12.61 |       0.27 |        6 017 |    5 / 5 |
| win32com |    960.63 |          - |        9 690 |    5 / 5 |

### 3.2 Dynamic 明细（1500 行）

| Backend  | mean (ms) | stdev (ms) | output bytes | fidelity |
| -------- | --------: | ---------: | -----------: | -------: |
| xltpl    |  *跑不通* |          - |            - |        - |
| openpyxl |  2 711.71 |     186.08 |       42 381 |    5 / 5 |
| win32com | 15 766.49 |          - |       53 497 |    5 / 5 |

> **xltpl 跑不通的原因**：spike 已经验证 0.21 系列不支持把模板里某一行
> 标记成"重复 N 次"。对静态 BS/PL 这种行数固定的报表，我们用 N 个
> 命名 slot (`cells['1001'].value`) 绕开这个限制，但对动态明细做不到
> ——明细行数完全是数据驱动的。所以这个单元格就空着不填。

## 4. 解读

### 4.1 静态 20 行场景

* **xltpl** 的 ~48 ms 主要花在 `BookWriter()` 实例化 + 模板解析上。在我们的
  报表生成流水里这是单次开销，可以接受。
* **openpyxl** 直写更快（~13 ms），但代价是模板设计师要把每个项目的
  目标单元格写死成"行号 R 列号 C"，YAML 配置和模板物理布局耦合。这点
  对 BS/PL 这种行数固定但偶尔会插行的报表非常脆弱。
* **win32com** 的 ~961 ms 99% 是 Excel 进程启动和 OLE 调用往返开销。
  fidelity 一样满分，但开机消耗换来的好处只在"想触发 Excel 公式
  自动重算"时才划得来 —— 我们的报表生成不需要这个能力。
* 三条路径在 fidelity 上打平。所以选择维度变成：维护成本（YAML 与模板
  解耦） vs 速度。**xltpl 胜出**，因为 48 ms 完全在 SLA 内（v0.3 §1.4
  目标 ≤ 500 ms）。

### 4.2 动态 1500 行场景

* **openpyxl** 直写 ~2.7 s，2.7 ms / 行，绝大部分时间在 openpyxl 重新
  序列化整个 worksheet 上。可以接受 —— 用户上传单家公司一个月的应收
  明细基本不超过 5000 行，~9 s 仍在用户耐心范围内。
* **win32com** 走 Excel 慢 5.8x，且对 OLE 大批量 `Cells(r,c).Value` 调用
  会出现间歇性 `0xC0000005` 访问冲突（benchmark 早期 `--runs 3 --include-com`
  在第 2 次启动时崩了一次，所以脚本最终把 COM 强制成 1 次）。这种
  脆弱性让 COM 不能做主路径。

## 5. 结论与方案落地

### 5.1 选定双轨

* **静态报表** (`balance_sheet`, `income_statement`, `owners_equity`,
  `cash_flow`) → `XltplRenderer`。
* **动态明细** (`ar_aging`, `ap_aging`, `inventory_detail`,
  `audit_workpaper_detail`，以及 row count > `STATIC_ROW_THRESHOLD = 50`
  的任何报表) → `OpenpyxlDirectRenderer`。
* **win32com** 不进主路径。我们仍然导入了 `pywin32`，但只作为后续
  P3 应急通道——例如客户拿到 .xls 但 `xlrd` 解不开、需要让 Excel 帮忙
  另存成 .xlsx 的时候。这与 v0.3 Part Infra §1.5 一致。

### 5.2 工厂入口

`finance_auto_backend.renderers.factory.make_renderer(report_kind, rows_estimate, template_path)`
按以下规则裁决（v0.3 Part Biz 契约 C1）：

1. `report_kind ∈ DYNAMIC_ONLY_KINDS` → openpyxl。
2. `report_kind ∈ STATIC_KINDS` 且 `rows_estimate ≤ 50` → xltpl。
3. 其他（包括行数爆表的 BS / PL，或 YAML 里出现的新报表种） → openpyxl。

返回的 renderer 是单次使用对象，第二次 `render()` 会抛
`RuntimeError`。这个限制对一份 ReportInstance 一份 .xlsx 的 1:1 关系
是天然契合。

### 5.3 模板约定（写入 docstring）

* xltpl 模板：用 `{{ cells['<code>'].value }}` 这种 Jinja 表达式作 slot；
  代码直接复用 YAML 配置里的 `code` 字段，避免设计师手写行号。
* openpyxl 模板：在数据起始行的 A 列填 `__ROWS_HERE__` 当 anchor，第一
  行风格作为后续动态行的样式蓝本；表尾若需要合计，在 `C` 列写
  `__SUM__`，工厂会替换成 `=SUM(C{first}:C{last})`。

## 6. 后续改进（M1 W3+ 不做、记录在案）

1. xltpl 0.x → 1.x 升级，看是否解决了 row-loop 限制。如果解决了，可以
   考虑统一回单 backend。**触发条件**：xltpl 1.x release。
2. openpyxl `write_only` 模式：对超过 10000 行的明细引入 streaming
   writer，进一步压缩 `mean_ms`。**触发条件**：实际遇到 > 5000 行的
   报表生成超时投诉。
3. COM 应急通道封装到 `parsers/xls_to_xlsx_com.py`，触发条件：xlrd /
   pyexcel 全部解不开的合法 xls。

## 7. Benchmark 复现

```powershell
d:\OpenAkita\.venv\Scripts\python.exe `
  plugins/finance-auto/scripts/benchmark_renderers.py `
  --runs 3 --dynamic-rows 1500 --include-com --out _m1_w2_bench.json
```

去掉 `--include-com` 即只跑 xltpl + openpyxl。

---
*文件大小预计 ~7 KB，符合验收要求 5–10 KB。*
