# OpenMAIC 服务器购买方向

## 结论

这台服务器只用于运行 **OpenMAIC 互动课堂**。主站、虚拟分光计和实验记录继续部署在 Cloudflare Pages，不迁移到服务器。

个人演示（通常 1–3 人同时使用）、月预算不超过 100 元时，优先购买：

> **阿里云香港轻量应用服务器：2 vCPU / 4 GiB 内存 / 60 GiB 或以上 SSD / 独立公网 IPv4 / Ubuntu 24.04 LTS**

香港节点免 ICP 备案，适合从武汉访问，也能避免把主站和 AI 课堂绑在同一台机器上。若香港同规格缺货或价格明显超预算，选择**新加坡同规格**作为备选；不要为了省钱降级到 2C2G。

## 购买清单

| 项目 | 选择 | 原因 |
| --- | --- | --- |
| 产品类型 | 轻量应用服务器 | 个人项目配置简单，公网 IP、系统盘和基础带宽通常已包含。 |
| 地域 | 中国香港；备选新加坡 | 无需 ICP 备案，面向中国大陆的访问体验通常优于欧美节点。 |
| CPU / 内存 | 2 vCPU / 4 GiB | 适合 Docker 运行 OpenMAIC，并给构建、Node.js 和缓存保留余量。 |
| 系统盘 | 60 GiB SSD 起 | 容纳 Ubuntu、Docker 镜像、构建缓存和课堂数据；40 GiB 容易紧张。 |
| 网络 | 独立公网 IPv4；开放 80、443、22 端口 | 用于 HTTPS 访问、域名解析和维护。SSH 端口可后续按需收紧。 |
| 操作系统 | Ubuntu 24.04 LTS | 与 Docker、Caddy/Nginx 和 OpenMAIC 文档兼容，维护周期长。 |
| 购买周期 | 优先按年比较总价 | 先确认 2C4G 规格，再使用可用优惠券；不要因优惠券改买 2C2G。 |

## 不购买什么

- **不买 2C2G。** Docker 构建和运行余量不足，远程终端也更容易在高负载时失去响应。
- **不买 Windows。** 本项目使用 Docker 和 Linux 运维工具，Windows 会增加维护复杂度和资源消耗。
- **不买 GPU。** OpenMAIC 使用外部 DeepSeek API，不在这台机器本地运行大语言模型。
- **不买中国大陆节点。** 面向公网访问时会涉及 ICP 备案；当前目标是免备案部署。
- **不为主站重复购买服务器。** `spectra-ai-lab.pages.dev` 仍由 Cloudflare Pages 承载。

## 部署边界

服务器只部署以下内容：

- Docker 与 Docker Compose；
- OpenMAIC 应用；
- HTTPS 反向代理（Caddy 或 Nginx）；
- 可选的 2–4 GiB Swap，作为突发内存缓冲，不替代真实内存。

模型调用继续使用外部 DeepSeek API。API 密钥只保存在服务器的环境文件中，不提交 GitHub、不写入本文件，也不放进网页前端。

要把课堂嵌入主站，必须先准备域名和 HTTPS，再将 OpenMAIC 的嵌入白名单仅设置为：

- `https://spectra-ai-lab.pages.dev`
- `https://spectra-lab.byte-wizard.chatgpt.site`

同时启用 OpenMAIC 的访问码，避免公开地址被陌生人直接消耗模型额度。

## 升级条件

| 使用情形 | 服务器建议 |
| --- | --- |
| 个人演示、普通互动课程、外部模型 API | 2C4G，关闭视频导出。 |
| 5 人以上较频繁使用、启用持久化数据库或需要更快构建 | 升级到 4C8G。 |
| 启用 MP4 视频导出 | 至少 4C8G；不要在 2C4G 上开启标准视频导出。 |
| 需要高并发或对外公开服务 | 4C8G 起步，并将构建镜像放到 GitHub Actions 等云端构建环境。 |

OpenMAIC 的视频渲染服务在低内存模式下要求至少 4 GiB，在标准模式下要求 8 GiB，因此视频导出不属于当前低预算个人演示方案。参考：[OpenMAIC 渲染服务说明](https://github.com/THU-MAIC/OpenMAIC/blob/main/render-service/README.md)。

## 购买后验收清单

- [ ] 实例为香港（或新加坡）节点，规格不低于 2C4G，系统为 Ubuntu 24.04 LTS。
- [ ] 可通过公网 IPv4 使用 SSH 密钥登录；账户密码与私钥未公开保存。
- [ ] Docker、Docker Compose、4 GiB 内存和系统盘容量检查正常。
- [ ] 域名已解析，80/443 端口可用，HTTPS 证书有效。
- [ ] OpenMAIC 容器设置为随系统启动自动恢复，并通过健康检查。
- [ ] 课堂页面已设置访问码，API 密钥未出现在浏览器、截图、Git 仓库或本文件中。
- [ ] 仅允许两个主站来源嵌入 OpenMAIC，iframe 与新窗口入口均可正常使用。

## 最终购买口令

在购买页只要按下面一句筛选即可：

> **香港轻量应用服务器，Ubuntu 24.04，2 核 4G、60G SSD、独立 IPv4；没有该规格就不买 2G，改看新加坡 2 核 4G。**
