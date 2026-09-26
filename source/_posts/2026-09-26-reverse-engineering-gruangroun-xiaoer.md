---
title: 逆向广软小二校园点餐系统：从0到1爬取全平台菜单数据
date: 2026-09-26 16:30:00
tags:
  - 逆向工程
  - 微信小程序
  - 爬虫
  - Rust
  - 校园生活
categories:
  - 技术分享
---

# 逆向广软小二校园点餐系统：从0到1爬取全平台菜单数据

## 前言

在广州软件学院，"广软小二"是同学们日常点餐的主要平台。作为一个技术爱好者，我很好奇这个小程序背后的技术架构，同时也想获取全平台的菜单数据做一些有趣的分析。于是就有了这次逆向工程的实践。

**最终成果**：
- 爬取了 **43个店铺**、**2084个商品** 的完整数据
- 包含店铺信息、营业时间、商品价格、库存、图片等 **23个字段**
- 生成了可视化HTML报告，支持按生活费档次推荐餐表

## 一、技术选型

| 工具 | 用途 |
|------|------|
| Rust | 核心爬虫程序 |
| mitmproxy | 网络抓包 |
| Python | 数据处理 |
| curl | API调试 |

选择Rust是因为它性能好、类型安全，适合写这种需要频繁请求的爬虫程序。

## 二、小程序逆向分析

### 2.1 定位小程序包文件

微信电脑版的小程序包文件存储在：

```bash
~/.xwechat/radium/Applet/packages/
```

每个小程序都有一个唯一的AppID作为目录名。通过修改时间排序，我找到了最近使用的小程序包：

```bash
ls -lt ~/.xwechat/radium/Applet/packages/ | head -10
```

### 2.2 分析小程序代码

小程序的代码打包在 `.wxapkg` 文件中。使用 `strings` 命令可以提取出有用的信息：

```bash
strings __APP__.wxapkg | grep -E "wxapi/|https?://"
```

**关键发现**：

1. **系统平台**：小程序使用的是 [pospal.cn](https://pospal.cn) 的收银系统
2. **API地址**：`https://wxservice-stg69.pospal.cn/`
3. **主要接口**：
   - `wxapi/customeraccount/Auth` - 微信登录
   - `wxapi/store/GetStoreDataFast` - 店铺信息
   - `wxapi/product/categories` - 获取菜单
   - `wxapi/shopcart/SyncShopCart` - 购物车同步
   - `wxapi/shopcart/Checkout` - 结账

### 2.3 识别认证机制

从代码中分析出认证流程：

```
请求头:
- PSPLVISITORID: 登录token
- STOREID: 店铺ID
- PSPLVISITORAUTO: "API"
- POSPALSTOREMODE: "RegularOrder|0"
- APPTYPE: "2"
```

## 三、抓包获取Token

### 3.1 配置mitmproxy

编写一个Python脚本来自动捕获登录token：

```python
#!/usr/bin/env python3
import json
from mitmproxy import http

class TokenCapture:
    def response(self, flow: http.HTTPFlow):
        if "customeraccount/Auth" in flow.request.url:
            data = json.loads(flow.response.text)
            if data.get("successed") and data.get("accessToken"):
                token = data["accessToken"]
                # 保存token到文件
                with open("token.json", "w") as f:
                    json.dump({"token": token}, f)

addons = [TokenCapture()]
```

启动抓包：

```bash
mitmdump -s capture_token.py -p 8080
```

### 3.2 处理代理冲突

由于我平时使用FlClash作为代理工具，需要让mitmproxy把流量转发到FlClash：

```bash
# 方案1：暂停FlClash
pkill flclash

# 方案2：使用上游代理
mitmdump -s capture_token.py -p 8081 --mode upstream:http://127.0.0.1:7890
```

### 3.3 捕获Token

配置系统代理后，在微信中打开"广软小二"小程序并登录，token会自动保存到 `token.json`。

## 四、API调用与数据采集

### 4.1 获取店铺列表

```rust
async fn get_stores(&self) -> Result<Vec<Store>> {
    let url = format!("{}/wxapi/o2ostore/GetStores", self.base_url);
    
    let response = self.client.post(&url)
        .header("PSPLVISITORID", &self.token)
        .header("STOREID", "4540116")  // 平台ID
        .form(&[("storeId", "4540116"), ("pageSize", "999")])
        .send()
        .await?;
    
    let result: Value = response.json().await?;
    // 解析店铺列表...
}
```

**发现**：共43个店铺，包括：
- 柠著(广软图书馆店)
- 广软肯德基
- 蜜雪冰城
- 各食堂档口...

### 4.2 获取菜单数据

```rust
async fn fetch_categories(&self, store_id: &str) -> Result<Value> {
    let url = format!("{}/wxapi/product/categories", self.base_url);
    
    let mut data = HashMap::new();
    data.insert("storeId", store_id);
    data.insert("includeAllProducts", "true");
    
    // 发送请求...
}
```

**踩坑记录**：
- 最初猜测的API是 `wxapi/product/FindProducts`，返回HTML页面
- 通过分析小程序代码找到正确的接口 `wxapi/product/categories`

### 4.3 批量采集

遍历所有店铺，批量获取菜单：

```bash
for store_id in $STORES; do
    curl -X POST "https://wxservice-stg69.pospal.cn/wxapi/product/categories" \
      -H "PSPLVISITORID: $TOKEN" \
      -H "STOREID: $store_id" \
      -d "storeId=$store_id&includeAllProducts=true" \
      > "menus/${store_id}.json"
    sleep 0.5  # 避免请求过快
done
```

## 五、数据整理

### 5.1 CSV导出

使用Python将数据整理成CSV格式：

```python
import csv
import json

with open('menu.csv', 'w', newline='', encoding='utf-8-sig') as f:
    writer = csv.writer(f)
    writer.writerow([
        '店铺ID', '店铺名称', '地址', '电话', '行业分类', '营业时间',
        '商品ID', '商品名称', '分类', '价格', '原价', '库存', '是否缺货',
        '商品图片', '条码', '描述', '是否新品', '创建时间'
    ])
    # 写入数据...
```

**最终数据**：
- 43个店铺
- 2084个商品
- 23个字段
- 880KB文件大小

### 5.2 HTML可视化报告

生成了一个交互式HTML报告，功能包括：

1. **生活费档次推荐**
   - 经济实惠型：15-25元/天（月800-1200元）
   - 普通日常型：25-40元/天（月1200-1800元）
   - 小资享受型：40-60元/天（月1800-2500元）
   - 土豪随意型：60元+/天（月2500元+）

2. **智能餐表生成**
   - 根据档次自动搭配早中晚餐
   - 显示每日花费合计

3. **搜索筛选**
   - 按店铺名、商品名搜索
   - 按店铺筛选

## 六、踩坑记录

### 6.1 小程序包加密

微信小程序的wxapkg文件是加密的，直接解包会失败。通过 `strings` 命令提取字符串信息是一个有效的替代方案。

### 6.2 API端点错误

最初猜测的 `wxapi/product/FindProducts` 返回的是HTML页面，通过分析小程序代码才发现正确的接口是 `wxapi/product/categories`。

### 6.3 店铺ID混淆

系统中有两种店铺ID：
- 平台ID：4540116（用于获取店铺列表）
- 实际店铺ID：4188030（用于获取菜单）

### 6.4 地址数据异常

发现"五谷杂粮渔粉"的地址显示为"广东省广州市广州软件学院第五食堂"，但实际上不存在第五食堂。这是平台数据的问题。

## 七、总结与展望

### 成果

通过这次逆向工程，我成功：
1. 分析了广软小二小程序的技术架构
2. 爬取了全平台43个店铺、2084个商品的完整数据
3. 生成了可视化的HTML报告和CSV数据文件

### 潜在应用

- **价格比较**：对比不同店铺的同类商品
- **智能推荐**：根据预算和口味推荐餐品
- **数据分析**：分析校园餐饮市场的价格分布
- **自动化点餐**：开发自动点餐机器人

### 法律与道德考量

逆向工程和数据爬取需要注意：
1. 仅用于个人学习和研究
2. 不要对服务器造成过大压力
3. 不要用于商业用途
4. 尊重平台的知识产权

## 附录

### 完整代码

项目代码已开源：[github.com/windy664/wechat-agent](https://github.com/windy664/wechat-agent)

### 数据文件

- `menu.csv` - 完整菜单数据
- `report.html` - 可视化报告
- `all_menus.json` - 原始JSON数据

---

**作者**：windy664  
**日期**：2026-09-26  
**声明**：本文仅供技术学习交流使用，请勿用于非法用途。
