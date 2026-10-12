# 前后端接口契约

所有接口在 `/api` 下，同源访问。POST必须发送 `Content-Type: application/json`。登录身份使用 `mx_auth` HttpOnly Cookie；游客使用服务器签发的随机 `mx_owner` HttpOnly Cookie。客户端需要保留 Cookie。JSON最大32KB。错误格式为 `{"error":"说明"}`。

状态码：400参数错误、401未登录或凭据错误、403无权访问、404不存在／不属于当前身份、409状态冲突、413请求太大、415内容类型不支持、429请求频繁、503外部路线服务不可用。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/auth/me` | 当前账号，未登录返回 user:null |
| POST | `/auth/register` | 注册普通用户并登录 |
| POST | `/auth/login` | 登录账号 |
| POST | `/auth/logout` | 撤销当前登录会话并退出 |
| GET | `/config` | 数据模式、服务配置状态和隐私说明 |
| GET | `/pois` | 演示POI列表 |
| POST | `/location/resolve` | 坐标转换、识别地址并推荐试点起点（不保存定位） |
| POST | `/places` | 在城市范围内按名称检索地点，供自定义起点／终点／必去节点使用 |
| POST | `/transit` | 同城公交换乘方案（高德路径规划） |
| POST | `/elevation` | 按行程或坐标查询海拔、累计爬升与坡段（Open Topo Data） |
| GET | `/trips` | 当前账号或游客身份的行程 |
| GET | `/route-packs` | 当前账号或游客身份按城市去重的最新自动路线包摘要 |
| POST | `/trip/plan` | 编排行程并保存 |
| POST | `/trip/{id}/stops` | 用完整列表替换某一天的节点（新增／删除） |
| GET | `/trip/{id}` | 读取本人行程 |
| POST | `/trip/{id}/summary` | 用本次行程生成一段收尾文字（需模型授权） |
| POST | `/journal` | 写入或清空某个地点的日记文字 |
| POST | `/journal/photo` | 给某个地点的日记加一张照片 |
| POST | `/journal/photo/delete` | 删除一张照片 |
| GET | `/trip/{id}/journal` | 读取本人行程的日记与照片 |
| POST | `/session/start` | 开启指定旅行日的会话 |
| GET | `/session/{id}` | 恢复会话与待确认建议标识 |
| GET | `/suggestion/{id}` | 读取本人待确认建议 |
| POST | `/session/state` | 上报派生状态特征 |
| POST | `/feedback` | 手动反馈／显式演示事件 |
| POST | `/session/confirm` | 接受或拒绝建议 |
| POST | `/session/checkin` | 完成当前节点打卡 |
| POST | `/session/end` | 结束会话，重复结束保持原时间 |
| GET | `/trip/{id}/report` | 行程报告 |
| GET | `/ops` | 仅管理员：服务配置与最近调用状态 |
| POST | `/ops/test` | 仅管理员：主动测试地图或天气服务 |
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

`/ops` 要求有效登录会话且服务端账号角色为 `admin`。未登录返回401、普通用户返回403；不再接受旧 `ADMIN_TOKEN` 作为访问凭据。返回内容仅包含服务配置与最近调用状态。

`POST /ops/test` 使用相同管理员权限，请求为 `{"provider":"maps"}` 或 `{"provider":"weather"}`。每次跳过缓存，直接测试杭州西湖公共地点的高德步行路径或和风天气实况；演示模式下也实际请求上游，不改变系统的数据模式。天气测试不会退回高德天气。响应包含 `provider/ok/elapsed_ms/checked_at/error_code/message/result`，并更新服务最近调用状态。服务测试完成时返回200，以 `ok` 区分成功与失败；非法服务名返回400。错误只返回安全错误码，不返回密钥、上游请求地址或原始错误内容。

## 自动识别位置

页面初次打开时自动请求一次浏览器定位权限；允许后，以 JSON 请求 `POST /api/location/resolve`。页面切换不重复请求，用户可点击“重新识别位置”主动重试：

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

`GET /api/trip/{id}/map?day=1&zoom=14&focus=0`：限当前账号或游客身份拥有的行程；默认 `day=1`，省略 `zoom` / `focus` 时自动显示全程。平移可传 `lng` 和 `lat`（GCJ-02，经度 ±180、纬度 ±85，必须成对且不能与 `focus` 同时使用）。返回 `{image, view: {center, zoom, width, height}, source}`，image 为后端取得的高德底图 data URL。参数错误 400、非本人行程 404、超过每分钟 60 次 429、底图不可用 503。

### 城市下拉选项

`GET /api/cities`：返回 `{cities: [{name, province, adcode}], source}`。实况模式从高德行政区划接口读取城市与直辖市，演示模式仅返回杭州。上游失败返回 503，前端保留常用城市和自动定位入口。

### 省市区联动

`GET /api/regions` 返回 `{provinces: [{name, adcode, cities: [{name, adcode, districts: [{name, adcode}]}]}], source}`。

`POST /api/trip/plan` 可增加 `province`（省份名称）和 `district_adcode`（六位区县代码，空字符串或省略为全市范围）；省市区不匹配返回 422，字段格式错误返回 400。成功行程的 preferences 中包含已校验的区县名称 `district`，route_pack 中 `adcode` 为所选区县或全市代码，`city_adcode` 为所属城市代码。演示模式仅支持杭州全市样本。

### 地点检索（自定义起点／终点／必去节点）

`POST /api/places`，请求 `{"keyword":"西湖文化广场","trip_id":"…"}` 或 `{"keyword":"…","city":"杭州市"}`。二者必选其一：给了行程就用行程所在城市，否则按城市名解析行政区（解析不到返回 503）。`keyword` 去首尾空格后须为 2—40 字，否则 400。

返回 `{places:[{id,name,address,lng,lat,category,coordinate_system:"GCJ-02",adcode}],keyword,region,source,mode,updated_at}`，最多 8 条，坐标非法或缺少名称的记录被丢弃。检索刻意不做区县过滤，因为用户可能跨区去一个具体地址；结果只在所选城市范围内（`city_limit=true`）。

演示模式或未配置高德 Key 时返回 503 并提示需要开启实况服务，不返回空列表冒充「没有这个地点」。前端在实况模式下才显示选择入口。

### 公交换乘

`POST /api/transit`，请求 `{"from":{name,lat,lng},"to":{name,lat,lng},"trip_id":"…"}`；也可以给 `city`（六位城市编码）代替 `trip_id`。缺少城市编码返回 400（不猜城市），坐标非法返回 400，起终点相同返回 400。

返回 `{options:[…],city,from,to,source,updated_at}`，`options` 按耗时升序最多 3 条，每条为 `{duration_min,distance_m,walking_distance_m,cost,transfers,rides,segments}`。`cost` 在高德未提供票价时为 `null`，不当作 0 元。`segments` 每项为 `{type,line,from,to,stops,distance_m,duration_min}`，`type` 取 `walk/bus/subway/railway/taxi`；高德对未使用的方式会返回空对象，后端会剔除，避免把空段算成一次乘坐而虚增换乘次数。

仅支持同城换乘（不传 `cityd` 做跨城）。无方案、鉴权失败或上游异常统一返回 503，且不回传上游错误正文。演示模式返回 503。

### 海拔、爬升与坡段

`POST /api/elevation`，两种用法：`{"trip_id":"…","day":1}` 用当天全部站点加高德步行折线自动铺采样点（等间隔压缩到 48 个，首尾必留）；或 `{"points":[{name,lat,lng},…]}` 直接给 1—48 个点，用来查「当前位置」的单个海拔。

输入按 GCJ-02 解释，查询前沿用标准算法反解为 WGS-84（高程数据集是 WGS-84 网格，几百米偏移在陡坡上足以改变取样）。

返回 `{samples,segments,summary,context,dataset,source,source_url,attributions,coordinate_note,accuracy_note,updated_at}`。`samples` 的 `elevation` 在无数据处为 `null`；`segments` 为 `{from,to,from_label,to_label,distance_m,rise_m,grade_pct,level,level_label}`，`level` 取 `flat/gentle/noticeable/steep`。任一相邻点缺高程时该段被跳过，不会用 0 米补齐造出假爬升。`summary` 含 `point_count/measured_count/length_m/gain_m/loss_m/min_m/max_m/max_up_grade_pct/max_down_grade_pct/steep_count/missing_count`。负海拔是有效数据。

行程不属于当前身份返回 404、旅行日无效返回 400、高程服务异常返回 503。`accuracy_note` 固定说明这是 SRTM 90 米网格估算、不是实测坡度。


### 手动调整行程（新增／删除）

`POST /api/trip/{id}/stops`，请求 `{"day":1,"stops":[{"id":"…"} | {"name":"…","lat":30.25,"lng":120.15,"category":"美食","duration_min":60}]}`。它是**整天列表的完整替换**，不是增量操作：客户端把想要的结果整份发过来（新增就把新地点放进列表，删除就不带它），服务端重算每段的步行与时间。

与自动规划的关键差别是：**不静默丢站**。自动规划会把超出约束的节点放进 `skipped`；用户手动给出的列表是明确的选择，悄悄删掉比排不进去更糟，所以这里全部保留，改为在 `warnings` 里逐条说明（超时、超步行上限、超预算、当天通常闭馆）。响应 `{trip,warnings}`。

规则：
- 每天 2—8 个地点；少于两个、多于八个、坐标非法、重复地点、行程里没有的 `id` 都返回 400。
- 候选池里的地点只传 `id`，服务端以池内事实为准，**客户端无法借这个接口伪造票价、评分或营业时间**；没有 `id` 的对象按「用户自己新增的地点」处理，只采信名称、坐标与停留时长，费用类字段一律为 `null`。
- 终点由 `preferences.end_point` 决定，不接受客户端增删；即使传了 `destination` 也会被忽略，最后一天会按设置重新接回末尾。
- 版本号 `version` 会加一，此前拿到但还没确认的改线建议因此自动过期。
- 漫游进行中（存在未结束的会话）返回 409，因为会话里的 `current_index` 指向具体节点，重排会让它失去意义。

### 漫游日记与照片

一个地点一条日记，记录键为 `行程:天:站点`。文字与照片都挂在这条记录上。

- `POST /api/journal`，`{"trip_id","day","stop_id","text"}`。`text` 去首尾空白、统一换行为 `\n`、上限 1200 字。**文字被清空且没有照片时整条记录删除**，不留空壳。返回 `{entry}` 或 `{deleted:true}`。
- `POST /api/journal/photo`，`{"trip_id","day","stop_id","data"}`，`data` 是 `data:image/(jpeg|png|webp);base64,…`。服务端会校验 **data URL 前缀、base64 合法性、字节大小（单张 2MB）以及文件头魔数**，声明的类型必须与文件头一致——否则会把任意内容当图片存下来再当图片发给浏览器。每个地点最多 6 张。这条路径的请求体上限放宽到 3MB，其它接口仍是 32KB。
- `POST /api/journal/photo/delete`，`{"photo_id"}`；只删照片，不动文字。删掉最后一张照片且没有文字时记录一并清除。
- `GET /api/trip/{id}/journal` 返回 `{entries,limits}`，每条含 `photos:[{id,mime,size,url}]`，`url` 就是可直接放进 `<img src>` 的 data URL。

照片以 data URL 直接存在记录里：网页端落在 SQLite，App 端落在设备存储，两端共用同一条代码路径。这样不需要文件系统，也不需要单独的二进制下载接口——App 内的后端是通过 JSON 桥接调用的，返回二进制流那条路走不通。

`stop_id` 必须是当天行程里真实存在的节点，否则 400；`/privacy/delete` 会连同日记与照片一起删除。

### 走完之后的收尾文字

`POST /api/trip/{id}/summary`，请求体为空对象。要求 `preferences.model_consent === true`（沿用规划时的说明授权——总结是行程内容，不是健康内容），否则 400；未配置 DeepSeek 返回 503。成功返回 `{summary:{text,generated_at,source}}` 并随行程持久化，`GET /trip/{id}/report` 会直接带上。

发给模型的上下文只有行程事实：城市、区县、日期、天数、同行、兴趣、当时的天气文字、每天的地点名与类别、打卡数、改线接受／拒绝次数、是否已结束。**不含坐标、不含身份、不含任何健康特征**（连步数推算的里程也不发）。模型返回空、超长或截断时明确失败，不编造一段。

`GET /trip/{id}/report` 的返回同时增加了 `summary`（或 `null`）与 `journal`（与 `/journal` 相同的条目），手记页因此不需要再发第二轮请求。

## 注册与登录

- `POST /auth/register` / `POST /auth/login`：`{"username":"traveler","password":"your-password"}`；成功返回 `{user:{id,username,role}}` 并设置登录 Cookie。注册返回201，登录返回200。
- 用户名3—32位字母、数字或下划线，去首尾空格并转小写；新注册密码8—128位。注册角色固定为 `user`，忽略客户端角色字段；用户名重复返回409。登录错误统一返回401，不区分用户不存在和密码错误。
- 首次初始化生成 `admin / admin`，管理员角色为 `admin`，已有账号不会在重启时覆盖。
- 密码使用随机盐和 scrypt 哈希。登录 Cookie 的随机凭据在数据库仅保存 SHA-256 摘要，有效期7天；Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下自动附带 Secure。
- 注册与登录合计每个来源IP每15分钟最多20次；超限返回429。浏览器跨站 Origin 被拒绝。
- 登录或注册会将该浏览器的游客记录关联到账号；各账号的数据相互隔离，管理员运营权限不提供读取其他账号行程的捷径。
- `POST /auth/logout`（`{}`）撤销当前会话，刷新游客身份。`GET /auth/me` 返回 `{user:null}` 表示未登录或会话已过期。其他设备的登录会话不受退出影响。
- `/privacy/delete` 删除当前账号或游客的行程记录，不删除账号与密码。


## 地点推荐说明

生成行程时，主路线每个节点新增 `recommendation_reason` 与 `recommendation_source`（`DeepSeek` 或 `规划规则`）。开启 `model_consent` 且已配置 DeepSeek 时，用一次请求生成整份说明与按地点 ID 对应的逐地点说明，仅发送城市、兴趣和公开地点名／类别／描述，不发送身份、坐标或健康数据。

输出限定已给定地点 ID，未知／重复 ID、空说明或截断响应不作为有效模型结果。缺失条目和服务失败使用类别／兴趣规则说明，不标为 DeepSeek；有效结果随行程持久化，并同步到对应 POI，便于后续改线沿用。

“今日的风景清单”展示地点名、已知参考人均／评分、说明正文及纯文本“查看高德地点”链接；不展示未知指标占位、停留／营业／预约／来源小字、步行小字或装饰符号。原始事实、时间与路段字段仍保留在接口和导出数据中。旧行程缺少新字段时，页面使用规则说明，不额外调用模型。

## Apple Watch 临时转发

此通道独立于蓝牙与模型授权：网页和手表都需明确同意原始心率经 HTTPS 临时转发。服务端只在内存保留最新一条、20秒失效，不写数据库、不写日志、不直接发送到模型。单进程部署；应用重启后需重新配对。

| 接口 | 方法与授权 | 输入/输出 |
| --- | --- | --- |
| `/api/watch/link` | POST，当前行程所有者 Cookie | `{session_id,relay_consent:true}`；返回8位一次性 `code`、毫秒时间戳 `pair_expires_at`（5分钟）和 `expires_at`（4小时） |
| `/api/watch/pair` | POST，一次性配对码 | `{code}`；返回 `token`、`expires_at` 和建议发送间隔 `sample_interval_s:5`；每IP每5分钟最多10次 |
| `/api/watch/sample` | POST，`Authorization: Bearer <token>` | `{bpm:75,timestamp:1791800000000,sequence:1}`；timestamp 为实际采样 Unix 毫秒，25–240 bpm，最多20秒前/5秒未来，序号和采样时间严格递增，发送间隔至少2秒 |
| `/api/watch/state?session_id=…` | GET，当前行程所有者 Cookie | `{status,sample,expires_at?}`；sample为最新 `{bpm,timestamp,sequence}` 或 null；状态 waiting / waiting_for_sample / live / disconnected |
| `/api/watch/unlink` | POST，当前行程所有者 Cookie | `{session_id}`；立即撤销 |
| `/api/watch/disconnect` | POST，设备 Bearer token | `{}`；手表停止时撤销 |

除本机 loopback 测试外必须使用 TLS；不信任任意转发头。设备 token 无行程读取权限。结束、暂停行程、退出登录、账号切换、删除数据、替换配对时撤销。读接口 `Cache-Control: no-store`，服务工作线程不缓存 API。旧/乱序样本返回409，失效token返回401，超限429。

手表工程与 Mac 安装方法见 [Apple Watch 接入](../apple/README.md)。网页登录恢复不会自动恢复心率采集，需要重新配对。
