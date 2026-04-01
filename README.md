# SunsetWhisper

中国主要城市朝霞 / 晚霞预报网页。

## 特点
- 使用 GFS 分层数据：低云 / 中云 / 高云 + 气溶胶 AOD
- 结合火烧云几何模型计算朝霞与晚霞强度
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
- 教程参考：<https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/>
