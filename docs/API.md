# 前后端接口契约

所有接口在 `/api` 下，同源访问。POST必须发送 `Content-Type: application/json`。匿名身份使用服务器签发的随机 `mx_owner` HttpOnly Cookie；客户端需要保留Cookie。JSON最大32KB。错误格式为 `{"error":"说明"}`。

状态码：400参数错误、403无权访问、404不存在／不属于当前身份、409状态冲突、413请求太大、415内容类型不支持、429请求频繁、503外部路线服务不可用。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/config` | 数据模式、服务配置状态和隐私说明 |
| GET | `/pois` | 演示POI列表 |
| POST | `/location/resolve` | 坐标转换、识别地址并推荐试点起点（不保存定位） |
| GET | `/trips` | 当前浏览器的行程 |
| GET | `/route-packs` | 当前浏览器按城市去重的最新自动路线包摘要 |
| POST | `/trip/plan` | 编排行程并保存 |
| GET | `/trip/{id}` | 读取本人行程 |
| POST | `/session/start` | 开启指定旅行日的会话 |
| GET | `/session/{id}` | 恢复会话与待确认建议标识 |
| GET | `/suggestion/{id}` | 读取本人待确认建议 |
| POST | `/session/state` | 上报派生状态特征 |
| POST | `/feedback` | 手动反馈／显式演示事件 |
| POST | `/session/confirm` | 接受或拒绝建议 |
| POST | `/session/checkin` | 完成当前节点打卡 |
| POST | `/session/end` | 结束会话，重复结束保持原时间 |
| GET | `/trip/{id}/report` | 行程报告 |
| GET | `/ops` | POI统计、本人反馈及任务记录 |
| POST | `/ops/run` | 运行字段审查或反馈聚类 |
| POST | `/privacy/delete` | 删除当前身份的所有记录 |

## 生成行程

```json
{
  "city": "杭州",
  "date": "2026-10-13",
  "days": 1,
  "budget": 300,
  "interests": ["自然", "人文"],
  "walk_limit_km": 6,
  "start_time": "09:00",
  "end_time": "18:00",
  "companion": "独自",
  "start_poi": "auto",
  "model_consent": false
}
```

返回包含 `id`、`version`、`preferences`、`days`、`weather`、`data_mode`、`explanation`、`warnings`。每日包含 `stops`、`skipped`、`distance_m`、`cost`、`duration_min`、`plan_b`。实况节点来自动态POI检索；每段 `leg` 来自高德。实况行程额外包含 `poi_catalog` 地点快照与 `route_pack`，其字段为 `id/city/adcode/generated_at/poi_count/source`。未知 `price/open/close` 为null；每日 `unknown_cost_count` 标记未知费用地点数，`cost` 只统计已知费用，不代表总价为零。

`days` 仅1或2；预算按天分配，当前仅筛选已知费用；动态检索尚无可靠票价，不能保证实际总预算；步行上限按每天计。`companion` 支持独自、情侣、亲子、长辈同行。兴趣支持自然、人文、建筑、展览、美食。当前不接收交通方式、酒店终点和临床健康资料。

## 会话与状态

开始：`{"trip_id":"…","day":1,"model_consent":false}`。这个授权独立于出发前的DeepSeek说明授权，决定是否把派生状态发给Jev网关。不会接收或保存静息心率原始值。

状态上报：

```json
{
  "session_id": "…",
  "trigger": "hr_high_sustained",
  "features": {
    "hr_vs_baseline_pct": 30,
    "duration_s": 190,
    "cadence_change_pct": -20,
    "walked_km_today": 1.2
  }
}
```

`features` 只接受上述字段和 `delay_min`，拒绝原始心率等未声明字段。服务端只保存事件类型和累计步行，特征仅用于当次判断，不持久化。

`/feedback` 使用 `feedback_type` 代替 `trigger`。枚举：`tired`、`hungry`、`rain`、`unwell`；也接受状态枚举 `state`、`hr_high_sustained`、`progress`。雨天事件必须附 `"demo":true`；所有模拟事件也应附该标记。演示健康特征不发送模型网关。

普通状态和冷却响应 `require_confirm=false`。需要改线时返回 `id`（建议ID）、`session_id`、`trip_version`、`expires_at`、`reason`、`changes`、`candidate`、`require_confirm=true`。规则没有校准置信度，`confidence=null`。

## 确认和打卡

```json
{
  "session_id": "…",
  "suggestion_id": "…",
  "accept": true
}
```

只有确认接口可以把候选路线写入行程。拒绝不改变路线；接受增加版本号；重复同一决定幂等，反向重复返回409。新建议会替代旧建议；建议10分钟失效，打卡也会使尚未确认的建议失效。规则触发有5分钟冷却；手动反馈可以跳过冷却。`unwell`始终优先暂停会话，废止待确认建议。

打卡：`{"session_id":"…","stop_id":"当前节点ID"}`。仅允许顺序完成；暂停后禁止继续打卡。

结束：`{"session_id":"…"}`。结束后不能上报或确认。

删除：`{"confirm":true}`；删除服务器记录后前端清除最近行程缓存与会话ID。

## TypeSafe Jev官方接入

优先读取 `TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL` 和 `TYPESAFE_DEFAULT_MODEL`，向 `/v1/systemone` 发送 `model/state/questions`；固定问题 `travel_state` 是Choice类型，选项为 `normal/mild_fatigue/rest`。响应从 `answers.travel_state` 解析 `choice/probabilities/confidence`，校验枚举、0—1范围、概率和及最大概率选项。

默认模型为 `jev-1.13.0`。2.5秒超时、鉴权、限流或格式错误退回规则；未授权和模拟健康事件不调用模型。原有自建 `JEV_GATEWAY_URL/JEV_API_KEY` 仅在官方密钥未配置时兼容使用。

DeepSeek仍只生成获授权的非健康行程说明，不自动接收低置信度健康特征。和风、高德与MCP运行方式详见 [服务接入](PROVIDERS.md)。

`GET /config` 和 `GET /ops` 增加 `providers.weather`，以及 `provider_status`：每项包含 `configured/status/checked_at/error_code`。状态为 `not_configured/not_checked/ok/error`，只反映当前进程调用情况；所有字段均不包含密钥。

## 运营权限

`/ops/run` 请求 `{"job":"poi_audit"}` 或 `{"job":"feedback"}`，必须带 `Authorization: Bearer <ADMIN_TOKEN>`。服务器令牌至少16位。当前反馈聚类仅针对该浏览器，避免演示阶段公开全量用户行为。两个任务均为确定性程序，输出明确标记为字段检查／规则聚类，不伪装模型或官网验证结果。

## 自动识别位置

用户点击“使用当前位置”并授权后，以JSON请求 `POST /api/location/resolve`：

```json
{"lat":30.245,"lng":120.158,"accuracy":20,"coordinate_system":"WGS84"}
```

经纬度须为有限数值，精度单位米。后端调用高德GPS坐标转换，再以GCJ-02坐标逆地理编码，返回 `province`、`city`、`district`、`address`、`nearby`、`position`、`accuracy`、`source`、`resolved_at`、`supported_city` 与 `suggested_start`。

实况模式返回 `dynamic_planning:true`，前端将城市自动填入目的地；`suggested_start:null`，第一站由后续城市动态规划选择。演示模式仍可返回附近杭州样本起点，其他城市仅显示识别结果。精确坐标不进入规划请求或城市路线包。

单次定位只传本项目后端和高德，不发给模型、不写SQLite、不进入地图缓存；响应 `Cache-Control: no-store`。无地图凭据、坐标转换失败或地址缺失均返回503，前端允许手动规划。即使在演示路线模式，也不会伪造地址结果。

官方接口依据：[坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)、[逆地理编码](https://lbs.amap.com/api/webservice/guide/api/georegeo)。

## 自动城市路线库

`DATA_MODE=live` 时，`/trip/plan` 接受高德行政区查询能唯一识别的国内中文城市名（包括四个直辖市），不接受省份或直接区县名。先查询行政区，再限定范围检索风景、展览与餐饮地点，过滤异地结果和无效坐标、去重，最多50个候选。地点查询采用短时缓存（5分钟）。

按聚集程度选起点、兴趣和相邻距离排序，再用真实步行耗时与距离筛选。每天最多6站，至少2站；两日主路线不重复地点。无足够地点／无可行路线返回422，外部服务错误503，不写入半成品或静默改成杭州模板。

成功后地点快照和路线包随行程保存在SQLite；`GET /route-packs` 返回 `{"packs":[{...route_pack,"trip_id":"…"}]}`，按城市保留最新摘要；历史行程仍能查看。身份隔离、删除规则与行程一致。途中改线使用行程内的同城地点快照，饥饿事件仅考虑当前位置节点1.5公里直线范围内的餐饮候选，再用地图测算；没有合适候选时缩短路线并建议休息。

参考：[高德POI 2.0](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch)、[行政区域查询](https://lbs.amap.com/api/webservice/guide/api/district)。

### 行程地图

`GET /api/trip/{id}/map?day=1&zoom=14&focus=0`：限当前浏览器拥有的行程；默认 `day=1`，省略 `zoom` / `focus` 时自动显示全程。返回 `{image, view: {center, zoom, width, height}, source}`，image 为后端取得的高德底图 data URL。参数错误 400、非本人行程 404、超过每分钟 60 次 429、底图不可用 503。

### 城市下拉选项

`GET /api/cities`：返回 `{cities: [{name, province, adcode}], source}`。实况模式从高德行政区划接口读取城市与直辖市，演示模式仅返回杭州。上游失败返回 503，前端保留常用城市和自动定位入口。
