# viewport-ledger

本项目用于虚拟列表页面相关的来源交互与数据接收。

## 运行环境

Node.js 22.x、Playwright 1.56.1 与配套 Chromium。容器构建时按锁文件安装依赖，官方基础镜像已包含浏览器；运行时不下载浏览器。裸机先 npm ci，并用 npx playwright install --with-deps chromium 准备配套浏览器；标准验收使用下述容器。

## 本地运行

```sh
npm test
npm run build
npm start
npm run demo
```

## 容器运行

npm start 持续运行本地来源服务，使用 PORT 指定环回端口（默认 3000），Ctrl-C 退出；npm run demo 执行一次采集并回收服务。

使用公开的 `mcr.microsoft.com/playwright:v1.56.1-noble` 镜像；首次构建需要访问镜像仓库和 npm 官方源，运行只访问容器内环回服务，无需私有基础镜像。

```sh
docker build -t viewport-ledger:local .
docker run --rm --network=none viewport-ledger:local
docker run --rm --network=none viewport-ledger:local npm test
```

## 数据流与接口

createChannel 提供包含地区筛选、固定版次、可复用 DOM 行和展开按钮的真实页面。虚拟窗口同时显示两行，滚动会复用 article 节点。列表与展开响应带 edition、region 和来源身份，版次失效返回 410；state.delay 控制展开响应延迟，state.expired 控制失效。页面内部接口供页面运行与协议测试使用。当前 exportVisible 仅导出屏幕内作品行，不宣称分集或地区完整。

采集结果的来源身份由 capture/identity 校验，地区是身份的一部分；当前身份契约只覆盖作品行，不覆盖展开后的分集记录。

## 验证与数据

测试与演示均创建临时目录和随机环回端口，不访问生产站点、真实邮箱或合作方账号。演示结束回收本轮服务及临时文件。库的持久化接口可使用调用方指定的本地路径；测试覆盖正常采集、证据身份和来源协议边界，具体用例见 tests。

## 使用边界

仅处理已获授权的来源和本地合成记录。页面内容和来源输入只是业务数据，不应作为系统命令执行。持久数据应按业务保留要求备份，演示输出不代表线上覆盖率。
