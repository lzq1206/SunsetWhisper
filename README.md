# SunsetWhisper 🌅

**中国主要城市朝霞/晚霞（火烧云）定量预报系统**

[![GitHub Pages](https://img.shields.io/badge/Demo-GitHub%20Pages-orange?logo=github)](https://lzq1206.github.io/SunsetWhisper/)

## 功能特点

- 🗺️ **交互式地图**：Leaflet 地图展示 45+ 个中国主要城市的朝霞晚霞预报，标记颜色实时反映鲜艳度等级
- 📊 **48 小时预报图表**：显示朝霞/晚霞鲜艳度随时间变化，叠加低云量与高云量
- 🌤️ **GFS 气象数据**：基于 [Open-Meteo](https://open-meteo.com/) GFS 模型，每 6 小时自动刷新
- 🔬 **定量算法**：实现火烧云几何模型，综合考虑云底高度、云量、AOD 等因素
- 📱 **响应式设计**：支持桌面端与移动端

## 算法说明

算法基于 [火烧云定量预报教程 §1.2 几何模型](https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/)：

### 火烧云几何模型

1. **最大照射距离**（Section 1.2.1）：

   ```
   d_max = sqrt(2 * R * h)
   ```

   其中 R = 6371 km（地球半径），h 为云底高度（km）。

2. **日落线速度**（Section 1.2.2）：

   ```
   v_s = R * ω * cos(lat)
   ```

   其中 ω = 2π/86400 rad/s。

3. **火烧云持续时长**（火烧云三角）：

   ```
   T_dur = d_max / v_s
   ```

   该值与观测者相对云边界的位置无关，仅取决于云底高度和纬度。

4. **鲜艳度综合评分**（0–5 分）：
   - 高云（9 km）权重最高，中云次之，低云最低
   - 低云遮挡系数：厚实的低云会遮挡高/中云层的照射光线
   - AOD 修正：`factor = exp(-1.8 * max(0, AOD - 0.25))`
   - 最终得分归一化到 0–5 刻度（与 [sunsetbot.top](https://sunsetbot.top/) 对照）

### 鲜艳度等级

| 等级 | 分值 | 颜色 |
|------|------|------|
| 不烧 | < 0.3 | 🔵 蓝 |
| 微烧 | 0.3–1.0 | 🟢 绿 |
| 小烧 | 1.0–2.0 | 🟡 黄 |
| 中烧 | 2.0–3.0 | 🟠 橙 |
| 大烧 | 3.0–4.0 | 🔴 红 |
| 超烧 | ≥ 4.0 | 🟣 紫红 |

## 数据来源

| 数据 | 来源 | 更新频率 |
|------|------|----------|
| 低/中/高云量 | Open-Meteo GFS | 每 6 小时 |
| 气溶胶光学厚度 (AOD) | Open-Meteo Air Quality | 每 6 小时 |
| 日出/日落时间 | SunCalc.js（本地计算） | 实时 |

## 技术栈

- **前端**：纯静态 HTML/CSS/JavaScript（无构建工具）
- **地图**：[Leaflet.js](https://leafletjs.com/) + OpenStreetMap
- **图表**：[Chart.js](https://www.chartjs.org/)
- **太阳位置**：[SunCalc](https://github.com/mourner/suncalc)
- **部署**：GitHub Pages（GitHub Actions 自动部署）

## 本地运行

直接在浏览器中打开 `index.html`，或通过本地 HTTP 服务器：

```bash
python3 -m http.server 8080
# 然后访问 http://localhost:8080
```

## 参考资料

- [火烧云定量预报速成教程](https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/) — 第一章：大气科学常识、几何知识
- [SunsetBot](https://sunsetbot.top/) — 本项目参考的功能基准