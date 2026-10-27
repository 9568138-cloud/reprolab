# 示例数据（全部为公开真实数据集）

这些 CSV 不是编的，来自公开数据集仓库 [Rdatasets](https://github.com/vincentarelbundock/Rdatasets)（R 内置数据集的镜像，CC0-1.0 / 原始数据集自带许可）。

| 文件 | 来源 | 行数 | 列 | 适合演示什么 |
| :-- | :-- | --: | :-- | :-- |
| `iris.csv` | R `datasets::iris`（R. A. Fisher 1936 发表的鸢尾花测量数据，UCI 也在收录） | 150 | `sepal_length_cm` / `sepal_width_cm` / `petal_length_cm` / `petal_width_cm` / `species` | 分组汇总、两组 t 检验（setosa vs versicolor）、相关、直方图、异常点 |
| `faithful.csv` | R `datasets::faithful`（美国黄石公园老忠实间歇泉喷发记录） | 272 | `eruption_min` / `waiting_min` | 相关、直方图（双峰分布）、回归 |
| `airpassengers.csv` | R `datasets::AirPassengers`（1949–1960 国际航空客运量，Box & Jenkins 经典数据） | 144 | `month`（`1949-01` …） / `passengers` | 时间趋势、按月分组 |
| `airquality.csv` | R `datasets::airquality`（1973 年纽约空气质量） | 153 | `ozone_ppb` / `solar_r_langley` / `wind_mph` / `temp_f` / `month` / `month_name` / `day` | **缺失值**（Ozone 有 37 个 NA）、相关、分组 |

## 我们做了什么处理

- 去掉 R 导出的 `rownames` 索引列；
- 列名改成小写下划线，并在会误导的地方带上单位（`_cm` / `_min` / `_ppb` / `_f`）；
- `airpassengers` 的 `time` 原本只有年份（每月重复），补成 `YYYY-MM` 便于按时间看；
- `airquality` 的 `NA` 统一改写成空单元格，并补一列 `month_name`（May…September）方便分组演示；
- 没有改动任何数值。

原始文件在各自数据源可核对，列名映射见上表；如果你要用自己的数据，直接把 CSV 拖进界面即可。
