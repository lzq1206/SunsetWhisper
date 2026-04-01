# SunsetWhisper

中国主要城市朝霞 / 晚霞预报网页。

## 特点
- 使用 GFS 分层数据：低云 / 中云 / 高云 + 气溶胶 AOD
- 严格版算法：分层湿度 + 太阳方位角光路采样 + 地球曲率照亮判别
- 支持全国主要城市地图、排行和单城详情
- GitHub Actions 每日自动生成静态数据并部署到 GitHub Pages

## 本地开发

```bash
npm install
npm run build
```

构建后会生成 `dist/`，可用任意静态服务器打开。

## 数据说明

- 数据源：Open-Meteo GFS 与 Air Quality API
- 分层变量：`relative_humidity_*hPa`、`cloud_cover_*hPa`、`geopotential_height_*hPa`
- 教程参考：<https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/>
