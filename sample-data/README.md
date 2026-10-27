# 示例数据

仓库里所有 CSV 都是**公开真实数据**，没有一个是编的。分英文经典数据集和中文数据集两组。

## 一、中文数据（推荐用于演示）

来源：[`wofeiwo/70city-price-skill`](https://github.com/wofeiwo/70city-price-skill)（把国家统计局「70 个大中城市商品住宅销售价格指数」整理成 CSV，数据口径与统计局月度发布一致）。

| 文件 | 行数 | 列 | 能演示什么 |
| :-- | --: | :-- | :-- |
| `中国70城房价指数_环比.csv` | 16,800 | `日期`(YYYY-MM) / `城市` / `新建商品住宅指数` / `二手住宅指数` | 分组汇总（按城市，70 组）、相关（新建 vs 二手）、时间趋势、分布直方图 |
| `中国70城房价指数_同比.csv` | 16,800 | 同上 | 同上，同比口径 |
| `中国70城房价指数_定基比.csv` | 12,600 | 同上 | 定基比口径（2011 年起） |
| `中国70城房价_2025年12月.csv` | 70 | `城市` / `新建商品住宅指数` / `二手住宅指数` | 横截面：分布、极值、城市间比较 |

口径说明：指数以 **100 为基准**，环比 > 100 表示这个月比上个月涨，同比 > 100 表示比去年同期涨。

**我们做了什么处理**：只做了三件事——① 日期从 `2006/1/1` 规范成 `2006-01`；② 按「指数类型」拆成独立文件（原始数据三种口径混在一列里）；③ 丢掉原始数据里全空的列（`HouseIDX` 等 3 列）。**没有改动任何数值**。

## 二、英文经典数据集（来自 Rdatasets 镜像，即 R 内置数据集）

来源：[`vincentarelbundock/Rdatasets`](https://github.com/vincentarelbundock/Rdatasets)。

| 文件 | 来源 | 行数 | 列 | 适合演示什么 |
| :-- | :-- | --: | :-- | :-- |
| `iris.csv` | R `datasets::iris`（Fisher 1936，UCI 也收录） | 150 | `sepal_length_cm` / `sepal_width_cm` / `petal_length_cm` / `petal_width_cm` / `species` | 分组汇总、两组 t 检验、相关、直方图、异常点 |
| `faithful.csv` | R `datasets::faithful`（黄石老忠实泉） | 272 | `eruption_min` / `waiting_min` | 相关、直方图（双峰）、回归 |
| `airpassengers.csv` | R `datasets::AirPassengers`（1949–1960 国际航空客运量） | 144 | `month` / `passengers` | 时间趋势、按月分组 |
| `airquality.csv` | R `datasets::airquality`（1973 纽约空气质量） | 153 | `ozone_ppb` / `solar_r_langley` / `wind_mph` / `temp_f` / `month` / `month_name` / `day` | **缺失值**（Ozone 有 37 个 NA）、相关、分组 |

处理方式：去掉 R 导出的 `rownames` 索引列；列名改成小写下划线并在会误导处带单位；`airpassengers` 的年份补成 `YYYY-MM`；`airquality` 的 `NA` 改成空单元格并补一列 `month_name`。数值未改。

## 三、用自己的数据

把 CSV 拖进界面即可（第一行表头）。缺失值写 `NA`、`null` 或留空都会被识别为缺失。
