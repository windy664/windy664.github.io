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

**问题**：目录中有20多个小程序包，如何确定哪个是"广软小二"？

**解决方法**：通过对比修改时间和目录结构，锁定了几个候选目录。然后使用 `strings` 命令提取小程序代码中的字符串，搜索关键词"广软"、"餐"、"menu"等，最终确认目标小程序。

### 2.2 分析小程序代码

小程序的代码打包在 `.wxapkg` 文件中。wxapkg是微信自定义的打包格式，直接解包会遇到加密问题。

**问题**：wxapkg文件是加密的，无法直接解包获取源代码。

**解决方法**：使用 `strings` 命令提取文件中的可读字符串，虽然不能获取完整代码，但足够找到关键信息：

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

通过分析代码中的请求函数，我发现了认证机制：

```javascript
// 从代码中提取的请求头配置
var p = {
    PSPLVISITORID: a._token,      // 登录token
    STOREID: storeId,              // 店铺ID
    PSPLVISITORAUTO: "API",
    POSPALSTOREMODE: a._storeMode + "|" + a._storeModeValue,
    APPTYPE: a._appType,
    VERSIONINFO: a._miniappName + "|" + a._version
};
```

## 三、抓包获取Token

### 3.1 配置mitmproxy

mitmproxy是一个强大的抓包工具，支持Python脚本扩展。我编写了一个脚本来自动捕获登录token：

```python
#!/usr/bin/env python3
import json
from mitmproxy import http

TOKEN_FILE = "token.json"

class TokenCapture:
    def response(self, flow: http.HTTPFlow):
        # 捕获登录接口响应
        if "customeraccount/Auth" in flow.request.url:
            try:
                data = json.loads(flow.response.text)
                if data.get("successed") and data.get("accessToken"):
                    token = data["accessToken"]
                    store_id = flow.request.urlencoded_form.get("storeId", "")
                    
                    result = {
                        "token": token,
                        "store_id": store_id
                    }
                    
                    with open(TOKEN_FILE, "w") as f:
                        json.dump(result, f, indent=2)
                    
                    print(f"[+] Token捕获成功: {token[:20]}...")
            except Exception as e:
                print(f"[-] 解析失败: {e}")

addons = [TokenCapture()]
```

启动抓包：

```bash
mitmdump -s capture_token.py -p 8080
```

### 3.2 配置系统代理

为了让微信的流量经过mitmproxy，需要配置系统代理：

```bash
# Linux系统
gsettings set org.gnome.system.proxy mode 'manual'
gsettings set org.gnome.system.proxy.http host '127.0.0.1'
gsettings set org.gnome.system.proxy.http port 8080
gsettings set org.gnome.system.proxy.https host '127.0.0.1'
gsettings set org.gnome.system.proxy.https port 8080
```

### 3.3 捕获Token

在微信中打开"广软小二"小程序并登录，mitmproxy会自动捕获请求：

```bash
[15:55:24.661] HTTP(S) proxy listening at *:8080.
[+] StoreId: 4188030 - https://wxservice-stg69.pospal.cn/wxapi/o2ostore/GetO2oStoreShowFiles
[+] Token: B1RXDgowBGUGZgQ3DWIKMl...
[+] Token捕获成功!
[+] 已保存到: token.json
```

**问题**：微信电脑版可能不走系统代理。

**解决方法**：在微信设置中手动配置代理：设置 → 通用设置 → 网络代理 → 填入 `127.0.0.1:8080`。

## 四、API调用与数据采集

### 4.1 获取店铺列表

首先需要获取所有店铺的信息：

```rust
async fn get_stores(&self) -> Result<Vec<Store>> {
    let url = format!("{}/wxapi/o2ostore/GetStores", self.base_url);
    
    let response = self.client.post(&url)
        .header("PSPLVISITORID", &self.token)
        .header("STOREID", "4540116")  // 平台ID
        .form(&[
            ("storeId", "4540116"),
            ("pageIndex", "0"),
            ("pageSize", "999")
        ])
        .send()
        .await?;
    
    let result: Value = response.json().await?;
    
    if result["successed"].as_bool().unwrap_or(false) {
        let stores = result["result"].as_array().unwrap();
        // 解析店铺列表...
    }
}
```

**发现**：共43个店铺，包括柠著、肯德基、蜜雪冰城、各食堂档口等。

### 4.2 获取菜单数据

**问题**：最初猜测的API是 `wxapi/product/FindProducts`，但返回的是HTML页面，不是JSON数据。

**排查过程**：
1. 使用 `strings` 命令搜索小程序代码中的所有API端点
2. 发现代码中有 `wxapi/product/categories` 和 `wxapi/product/listmulti` 两个接口
3. 分析代码逻辑，发现 `categories` 接口用于获取分类和商品列表
4. 尝试调用 `categories` 接口，成功返回JSON数据

```rust
async fn fetch_categories(&self, store_id: &str) -> Result<Value> {
    let url = format!("{}/wxapi/product/categories", self.base_url);
    
    let mut data = HashMap::new();
    data.insert("storeId", store_id);
    data.insert("includeAllProducts", "true");
    data.insert("includeAttributes", "false");
    data.insert("isSeries", "true");
    
    let response = self.client.post(&url)
        .header("PSPLVISITORID", &self.token)
        .header("STOREID", store_id)
        .header("PSPLVISITORAUTO", "API")
        .header("POSPALSTOREMODE", "RegularOrder|0")
        .form(&data)
        .send()
        .await?;
    
    let result: Value = response.json().await?;
    Ok(result)
}
```

### 4.3 识别店铺ID

**问题**：系统中有两种店铺ID，导致数据获取失败。

**排查过程**：
1. 从token.json中获取的store_id是 `4540116`
2. 使用这个ID调用 `categories` 接口，只获取到"纸巾"和"杯子"两个商品
3. 检查mitmproxy抓包日志，发现实际请求使用的store_id是 `4188030`
4. 分析代码发现 `4540116` 是平台ID，`4188030` 是实际店铺ID

**解决方法**：使用 `GetStores` 接口获取所有店铺列表，然后遍历每个店铺ID获取菜单。

### 4.4 批量采集

编写脚本批量获取所有店铺的菜单：

```bash
#!/bin/bash
TOKEN=$(cat token.json | grep token | cut -d'"' -f4)

# 获取所有店铺ID
STORES=$(curl -s -X POST "https://wxservice-stg69.pospal.cn/wxapi/o2ostore/GetStores" \
  -H "PSPLVISITORID: $TOKEN" \
  -H "STOREID: 4540116" \
  -d "storeId=4540116&pageIndex=0&pageSize=999" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('result', []):
    print(f\"{s['StoreId']}|{s['CompanyName']}\")
")

mkdir -p menus

echo "$STORES" | while IFS='|' read -r store_id store_name; do
    echo "获取: $store_name (ID: $store_id)"
    
    curl -s -X POST "https://wxservice-stg69.pospal.cn/wxapi/product/categories" \
      -H "PSPLVISITORID: $TOKEN" \
      -H "STOREID: $store_id" \
      -H "PSPLVISITORAUTO: API" \
      -H "POSPALSTOREMODE: RegularOrder|0" \
      -H "APPTYPE: 2" \
      -d "storeId=$store_id&includeAllProducts=true" > "menus/${store_id}.json"
    
    sleep 0.5  # 避免请求过快
done

echo "完成！共获取 $(ls menus/*.json | wc -l) 个店铺菜单"
```

**运行结果**：

```
开始获取所有店铺菜单...
获取: 柠著(广软图书馆店) (ID: 4188030)
获取: 广式仟味卤水/啫啫鸡拌饭店(啡比店) (ID: 4542459)
获取: 太和骨汤米线(啡比店） (ID: 4542460)
...
完成！共获取 43 个店铺菜单
```

## 五、数据整理

### 5.1 CSV导出

使用Python将JSON数据整理成CSV格式：

```python
import json
import csv

with open('all_menus.json', 'r') as f:
    all_data = json.load(f)

with open('menu.csv', 'w', newline='', encoding='utf-8-sig') as csvfile:
    writer = csv.writer(csvfile)
    
    # 写入表头
    writer.writerow([
        '店铺ID', '店铺名称', '地址', '电话', '行业分类', '营业时间',
        '是否营业中', 'Logo图片', '外卖起送费', '配送费', '距离(km)',
        '商品ID', '商品名称', '分类', '价格', '原价', '库存', '是否缺货',
        '商品图片', '条码', '描述', '是否新品', '创建时间'
    ])
    
    for store_id, data in all_data.items():
        store_info = stores_info.get(store_id, {})
        
        # 店铺信息
        store_name = store_info.get('CompanyName', '')
        address = store_info.get('Address', '')
        phone = store_info.get('Telephone', '')
        industry = store_info.get('Industry', '')
        
        # 营业时间
        biz_times = store_info.get('StoreBusinessTimes', [])
        business_hours = ', '.join([
            f"{t['begin'][:5]}-{t['end'][:5]}" 
            for t in biz_times
        ]) if biz_times else '未设置'
        
        # 遍历商品
        for cat_id, products in data.get('productsByCategory', {}).items():
            for p in products:
                writer.writerow([
                    store_id, store_name, address, phone, industry, business_hours,
                    '是' if not store_info.get('IsBizClosed') else '否',
                    store_info.get('StoreLogo', ''),
                    store_info.get('MinShippingFee', 0),
                    store_info.get('ShippingMinAmount', 0),
                    store_info.get('DistanceInKm', 0),
                    p.get('uid', ''),
                    p.get('productDisplayName', ''),
                    cat_name,
                    p.get('sellPrice', 0),
                    p.get('productOriginalPrice', 0),
                    p.get('stock', 0),
                    '是' if p.get('isOutOfStock') else '否',
                    p.get('defaultproductimage', {}).get('imagepath', ''),
                    p.get('barcode', ''),
                    p.get('description', ''),
                    '是' if p.get('isNewly', 0) > 0 else '否',
                    p.get('createTime', '')
                ])
```

**最终数据**：
- 43个店铺
- 2084个商品
- 23个字段
- 880KB文件大小

## 六、踩坑记录

### 6.1 小程序包加密

微信小程序的wxapkg文件是加密的，直接解包会失败。通过 `strings` 命令提取字符串信息是一个有效的替代方案。

### 6.2 API端点错误

最初猜测的 `wxapi/product/FindProducts` 返回的是HTML页面，通过分析小程序代码才发现正确的接口是 `wxapi/product/categories`。

**教训**：不要凭经验猜测API，要通过逆向分析代码找到真实的接口。

### 6.3 店铺ID混淆

系统中有两种店铺ID：
- 平台ID：4540116（用于获取店铺列表）
- 实际店铺ID：4188030（用于获取菜单）

**教训**：抓包时要注意观察实际请求使用的参数，不要只看代码中的变量名。

### 6.4 地址数据异常

发现"五谷杂粮渔粉"的地址显示为"广东省广州市广州软件学院第五食堂"，但实际上不存在第五食堂。这是平台数据的问题，不是爬取的问题。

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
