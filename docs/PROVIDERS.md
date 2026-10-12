# 服务接入与代理

## 当前配置

四项密钥已写入本机 `.env`，权限为0600；`.gitignore`排除该文件。前端、示例配置、文档和MCP配置均不包含实际密钥。

| 服务 | 应用后端接入 | 环境变量 |
| --- | --- | --- |
| Jev | TypeSafe官方 `/v1/systemone`，Choice结构化判断 | `TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL`、`TYPESAFE_DEFAULT_MODEL` |
| DeepSeek | `/chat/completions`，JSON说明生成 | `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` |
| 和风天气 | 默认Current Weather v1，杭州城区当前天气 | `QWEATHER_API_KEY`、`QWEATHER_API_BASE` |
| 高德 | 行政区、城市POI检索、定位与步行路线；分城市天气 | `AMAP_MAPS_API_KEY`（兼容旧 `AMAP_KEY`） |

本机 `.env` 已启用 `DATA_MODE=live`。实况规划已改为动态检索真实POI；营业、票价与预约仍待核实。演示模式保留杭州样本。Jev仅在会话获得授权且触发规则时调用；模拟健康事件不发送模型。DeepSeek仍只接收获授权的非健康行程内容。

Jev的输入是 `model/state/questions`，选项用 `criteria` 指定；后端校验选择、概率分布、置信度和类型。模型输出作为规则边界内的参考，不直接执行路线修改。低质量响应、鉴权错误、限流和超时均回退规则，且不会对页面输出上游原始错误或密钥。

和风天气默认v1接口。若账户只开放旧版城市产品，可显式设置 `QWEATHER_API_VERSION=v7`，调用 `/v7/weather/now`；不会自动重试付费产品版本。v1当前接口没有观测时间字段时显示“获取时间”，v7显示 `obsTime`；两者都不是未来旅行日预报。杭州和风失败时切换高德天气并标注原因；两家均失败则显示不可用。其他城市按目标城市行政编码查询高德实况，不使用杭州天气。

## 代理

本机已按用户指定配置：

```dotenv
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1
```

`npm start`、`npm run dev`、`npm run providers:check`均带 `--use-env-proxy`，让Node内置fetch和HTTP客户端使用代理。仅设置 `HTTPS_PROXY` 而不启用Node代理支持可能无效。项目要求Node.js **22.21+（22.x）或24.5+**。无代理环境可清空两个代理变量；不需要禁用TLS验证。

MCP启动器也只向子进程传递必要的代理变量和对应服务密钥，不传其他服务密钥。外部终端环境变量通常优先于 `.env`；如终端存在旧代理，请统一配置。

## 连接验证

```bash
npm run providers:check
# 单独检查某一项
npm run providers:check -- jev
npm run providers:check -- weather
npm start
```

检查使用公开样本坐标和合成模型输入，不发送真实用户行程或健康数据。每项执行一次；模型检查可能产生少量API费用。输出仅含服务名、状态、安全错误码、时间，不输出密钥、请求头或完整上游响应。

2026-10-12最新实测：

- 权限更新后，经 `127.0.0.1:7897` 代理，高德、和风、TypeSafe Jev、DeepSeek均返回有效响应；四项服务在实际网页后端进程中均记录为 `ok`。
- 首轮遇到DeepSeek输出不完整，已为短文案显式设置 `thinking.type=disabled`、800输出token，并拒绝 `finish_reason=length` 的截断结果。之后JSON说明生成与网页调用成功。过程中出现过TLS连接重置，故仍保留故障回退。
- 多段行程首轮触发高德 `10021` 限流，已加入后端全局排队、默认1100ms间隔和最多3次的限流重试。`AMAP_MIN_INTERVAL_MS` 可按账户额度调整；鉴权错误不重试。
- 浏览器完成真实行程规划、拒绝建议、接受改线、节点打卡与结束报告；天气来源为和风，说明来源为DeepSeek，决策参考为TypeSafe Jev。

此前出现的 `EAI_AGAIN/EPERM` 属于旧权限环境历史记录，当前阻断已解除。运营页状态属于当前后端进程内存；重启后需实际调用才会再次出现 `ok`。

## MCP配置

网页后端采用上述HTTP接口，不依赖npx子进程。用户给出的MCP配置另存为 `config/mcp.json`，供支持stdio MCP的客户端使用；未修改本机全局Agent配置，也未宣称该会话已注册MCP工具。

项目提供两个启动器：

```bash
npm run mcp:qweather
npm run mcp:amap
```

真正的MCP客户端应使用 `config/mcp.json` 中的直接 `node` 命令，避免npm启动提示混入协议stdout。启动器从项目根 `.env` 加载凭据，再调用用户指定的包：

- `npx -y @mseep/qweather-mcp@1.0.8`
- `npx -y @amap/amap-maps-mcp-server`

天气子进程只得到天气密钥和API Host，高德子进程只得到地图密钥。stdio的stdout保留给协议，不打印配置；第三方包stderr被屏蔽，以免泄漏上游请求细节。客户端连接超时请设60秒；字段名称随客户端而异，故通用JSON不写特定客户端超时字段。移动项目后，修改JSON里的绝对脚本路径。

两个npm包均已完成 `initialize/tools/list/tools/call` 实测：高德列出12个工具并成功调用 `maps_direction_walking`；和风列出2个工具并成功调用 `get-weather-now`（杭州）。首轮安装超过握手等待时间，安装完成后重新连接成功。可通过 `npm run mcp:check` 重验；只输出调用状态，不打印凭据或完整服务响应。

## 官方依据

- [TypeSafe API参考](https://docs.typesafe.ai/api)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
- [和风Current Weather v1](https://dev.qweather.com/en/docs/api/weather/weather-current/)
- [和风API Key鉴权](https://dev.qweather.com/en/docs/configuration/authentication/)
- [和风旧版城市实况接口](https://dev.qweather.com/en/docs/api/weather/weather-now-webapi-v7/)
- [高德步行路径规划](https://lbs.amap.com/api/webservice/guide/api/direction/)
- [Node.js代理支持](https://nodejs.org/learn/http/enterprise-network-configuration)

### 高德人均消费与评分

自动城市路线检索通过地点搜索 2.0 的 `show_fields=business` 读取 `business.cost` 与 `business.rating`，不额外调用模型或餐饮推荐服务。归一化后的 `per_capita_cost`（元/人）、`rating`（5 分制）、`commerce_source`、`commerce_fetched_at` 随 POI 存入行程和路线库，并显示在行程节点、餐厅列表及用餐改线建议中。时间表示本次获取时间，不是高德内容更新时间。

空值、零值、负值及无效数值显示“暂无”；不生成评价正文。参考人均独立于 `price`，不作为门票或确定费用计入总价。已有行程保留原始快照，重新生成行程后获取新字段。

字段说明：https://lbs.amap.com/api/webservice/guide/api/newpoisearch

### 真实路线地图

`GET /api/trip/{id}/map?day=1&zoom=14&focus=0` 使用当前浏览器所属行程生成底图视图。`zoom`（3—17）和 `focus`（从 0 开始的地点序号）可省略，默认包含当天所有地点与实况路径。使用现有 Web 服务 Key 调用高德 `/v3/staticmap`，返回底图 data URL、GCJ-02 中心点和缩放级别；密钥、上游 URL 不发往浏览器。每个浏览器限 60 次/分钟，服务端底图缓存最多 64 张、5 分钟。

前端按 Web Mercator 投影叠加已有 GCJ-02 步行路径，不再次偏移坐标，不连接缺失路段。地图保留高德原图署名与审图号。切换页面取消过时请求，失败提供重试与地点跳转。它是可切换视图的真实静态底图，不使用 JS SDK，不提供拖拽或定位追踪。

官方文档：https://lbs.amap.com/api/webservice/guide/api/staticmaps

### 目的地选择

目的地采用省份、城市、区县三个联动下拉框，通过 `/api/regions` 读取高德全国行政区划（`keywords=中国&subdistrict=3&extensions=base`）。直辖市的第二级保持城市名称，第三级合并其行政区县。街道不作为区县选项；没有区县层级的城市可选择全市范围。旧 `/api/cities` 保留兼容。

改变省份会重选城市并清空区县，改变城市会清空区县；自动定位同步三项并保留日期和预算。城市列表请求失败可重试，也可使用常用城市及定位结果。

规划请求支持 `province`、`district_adcode`，后端校验省市区归属，按区县代码检索并严格过滤区外 POI。区县景点不足时建议改选全市或其他区县，不静默扩大范围。路线库按城市／区县分别记录，并保留重新规划时的区县选择。
