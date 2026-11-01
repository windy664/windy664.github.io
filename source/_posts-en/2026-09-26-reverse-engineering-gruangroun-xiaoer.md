---
title: "Reverse-Engineering the \"GuangRuan XiaoEr\" Campus Food Ordering System: Scraping Menu Data Across the Entire Platform from Scratch"
date: 2026-09-26 16:30:00
tags:
  - Reverse Engineering
  - WeChat Mini Program
  - Web Scraping
  - Rust
  - Campus Life
categories:
  - Tech Notes
---

# Reverse-Engineering the "GuangRuan XiaoEr" Campus Food Ordering System: Scraping Menu Data Across the Entire Platform from Scratch

## Introduction

At Guangzhou Software College, "GuangRuan XiaoEr" is the main platform students use to order food. As a tech enthusiast, I was curious about the technical architecture behind this mini program, and I also wanted to collect menu data from the entire platform for some interesting analysis. That led to this reverse-engineering project.

**Final results**:
- Scraped complete data for **43 stores** and **2,084 products**
- Included **23 fields** covering store info, business hours, prices, stock, images, and more
- Generated a visual HTML report with meal recommendations by living-expense budget tiers

## 1. Tech Stack

| Tool | Purpose |
|------|---------|
| Rust | Core scraping program |
| mitmproxy | Network traffic capture |
| Python | Data processing |
| curl | API debugging |

I chose Rust for its performance and type safety, which makes it a good fit for a scraper that needs to fire off frequent requests.

## 2. Reverse-Engineering the Mini Program

### 2.1 Locating the Mini Program Package

The desktop version of WeChat stores mini program packages at:

```bash
~/.xwechat/radium/Applet/packages/
```

Each mini program has a unique AppID as its directory name. By sorting by modification time, I found the most recently used packages:

```bash
ls -lt ~/.xwechat/radium/Applet/packages/ | head -10
```

**Problem**: The directory contains more than 20 mini program packages — how do I identify which one is "GuangRuan XiaoEr"?

**Solution**: By comparing modification times and directory structures, I narrowed it down to a few candidate directories. Then I used the `strings` command to extract strings from the mini program code, searching for keywords like "广软" (GuangRuan), "餐" (food), and "menu", which finally confirmed the target mini program.

### 2.2 Analyzing the Mini Program Code

The mini program's code is packaged in a `.wxapkg` file. wxapkg is WeChat's custom packaging format, and unpacking it directly runs into encryption issues.

**Problem**: The wxapkg file is encrypted, so it can't be directly unpacked to get the source code.

**Solution**: Use the `strings` command to extract readable strings from the file. While this doesn't give you the full code, it's enough to find the key information:

```bash
strings __APP__.wxapkg | grep -E "wxapi/|https?://"
```

**Key findings**:

1. **System platform**: The mini program is built on the POS system from [pospal.cn](https://pospal.cn)
2. **API base URL**: `https://wxservice-stg69.pospal.cn/`
3. **Main endpoints**:
   - `wxapi/customeraccount/Auth` - WeChat login
   - `wxapi/store/GetStoreDataFast` - store info
   - `wxapi/product/categories` - get menus
   - `wxapi/shopcart/SyncShopCart` - cart sync
   - `wxapi/shopcart/Checkout` - checkout

### 2.3 Identifying the Authentication Mechanism

By analyzing the request functions in the code, I found the authentication mechanism:

```javascript
// Request header config extracted from the code
var p = {
    PSPLVISITORID: a._token,      // login token
    STOREID: storeId,              // store ID
    PSPLVISITORAUTO: "API",
    POSPALSTOREMODE: a._storeMode + "|" + a._storeModeValue,
    APPTYPE: a._appType,
    VERSIONINFO: a._miniappName + "|" + a._version
};
```

## 3. Capturing the Token with a Proxy

### 3.1 Setting Up mitmproxy

mitmproxy is a powerful traffic-capturing tool that supports Python scripting. I wrote a script to automatically capture the login token:

```python
#!/usr/bin/env python3
import json
from mitmproxy import http

TOKEN_FILE = "token.json"

class TokenCapture:
    def response(self, flow: http.HTTPFlow):
        # Capture the login endpoint response
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
                    
                    print(f"[+] Token captured: {token[:20]}...")
            except Exception as e:
                print(f"[-] Parse failed: {e}")

addons = [TokenCapture()]
```

Start the capture:

```bash
mitmdump -s capture_token.py -p 8080
```

### 3.2 Configuring the System Proxy

To route WeChat's traffic through mitmproxy, you need to configure the system proxy:

```bash
# Linux
gsettings set org.gnome.system.proxy mode 'manual'
gsettings set org.gnome.system.proxy.http host '127.0.0.1'
gsettings set org.gnome.system.proxy.http port 8080
gsettings set org.gnome.system.proxy.https host '127.0.0.1'
gsettings set org.gnome.system.proxy.https port 8080
```

### 3.3 Capturing the Token

Open the "GuangRuan XiaoEr" mini program in WeChat and log in — mitmproxy will automatically capture the request:

```bash
[15:55:24.661] HTTP(S) proxy listening at *:8080.
[+] StoreId: 4188030 - https://wxservice-stg69.pospal.cn/wxapi/o2ostore/GetO2oStoreShowFiles
[+] Token: B1RXDgowBGUGZgQ3DWIKMl...
[+] Token captured!
[+] Saved to: token.json
```

**Problem**: Desktop WeChat may not use the system proxy.

**Solution**: Manually configure the proxy in WeChat's settings: Settings → General Settings → Network Proxy → enter `127.0.0.1:8080`.

## 4. API Calls and Data Collection

### 4.1 Getting the Store List

First, I needed to get the info for all stores:

```rust
async fn get_stores(&self) -> Result<Vec<Store>> {
    let url = format!("{}/wxapi/o2ostore/GetStores", self.base_url);
    
    let response = self.client.post(&url)
        .header("PSPLVISITORID", &self.token)
        .header("STOREID", "4540116")  // platform ID
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
        // Parse the store list...
    }
}
```

**Finding**: There are 43 stores in total, including Ningzhu, KFC, Mixue Bingcheng, and various cafeteria stalls.

### 4.2 Getting Menu Data

**Problem**: The API I initially guessed, `wxapi/product/FindProducts`, returned an HTML page instead of JSON data.

**Troubleshooting process**:
1. Used `strings` to search the mini program code for all API endpoints
2. Found two endpoints in the code: `wxapi/product/categories` and `wxapi/product/listmulti`
3. Analyzed the code logic and found that the `categories` endpoint is used to fetch categories and product lists
4. Tried calling the `categories` endpoint and got a successful JSON response

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

### 4.3 Identifying Store IDs

**Problem**: There are two kinds of store IDs in the system, which caused data fetching to fail.

**Troubleshooting process**:
1. The store_id from token.json was `4540116`
2. Using this ID with the `categories` endpoint only returned two products: "tissues" and "cups"
3. Checking the mitmproxy logs, I found the actual requests used store_id `4188030`
4. Analyzing the code revealed that `4540116` is the platform ID, while `4188030` is the actual store ID

**Solution**: Use the `GetStores` endpoint to get the full store list, then iterate over each store ID to fetch its menu.

### 4.4 Batch Collection

I wrote a script to batch-fetch menus for all stores:

```bash
#!/bin/bash
TOKEN=$(cat token.json | grep token | cut -d'"' -f4)

# Get all store IDs
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
    echo "Fetching: $store_name (ID: $store_id)"
    
    curl -s -X POST "https://wxservice-stg69.pospal.cn/wxapi/product/categories" \
      -H "PSPLVISITORID: $TOKEN" \
      -H "STOREID: $store_id" \
      -H "PSPLVISITORAUTO: API" \
      -H "POSPALSTOREMODE: RegularOrder|0" \
      -H "APPTYPE: 2" \
      -d "storeId=$store_id&includeAllProducts=true" > "menus/${store_id}.json"
    
    sleep 0.5  # avoid hitting the API too fast
done

echo "Done! Fetched menus for $(ls menus/*.json | wc -l) stores"
```

**Output**:

```
Fetching all store menus...
Fetching: Ningzhu (GuangRuan Library store) (ID: 4188030)
Fetching: Cantonese Qianwei Braised Dishes / Sizzling Chicken Rice (Feibi store) (ID: 4542459)
Fetching: Taihe Bone-Broth Rice Noodles (Feibi store) (ID: 4542460)
...
Done! Fetched menus for 43 stores
```

## 5. Data Organization

### 5.1 CSV Export

I used Python to organize the JSON data into CSV format:

```python
import json
import csv

with open('all_menus.json', 'r') as f:
    all_data = json.load(f)

with open('menu.csv', 'w', newline='', encoding='utf-8-sig') as csvfile:
    writer = csv.writer(csvfile)
    
    # Write header
    writer.writerow([
        'Store ID', 'Store Name', 'Address', 'Phone', 'Industry Category', 'Business Hours',
        'Is Open', 'Logo Image', 'Min Delivery Fee', 'Delivery Fee', 'Distance (km)',
        'Product ID', 'Product Name', 'Category', 'Price', 'Original Price', 'Stock', 'Out of Stock',
        'Product Image', 'Barcode', 'Description', 'Is New', 'Created At'
    ])
    
    for store_id, data in all_data.items():
        store_info = stores_info.get(store_id, {})
        
        # Store info
        store_name = store_info.get('CompanyName', '')
        address = store_info.get('Address', '')
        phone = store_info.get('Telephone', '')
        industry = store_info.get('Industry', '')
        
        # Business hours
        biz_times = store_info.get('StoreBusinessTimes', [])
        business_hours = ', '.join([
            f"{t['begin'][:5]}-{t['end'][:5]}" 
            for t in biz_times
        ]) if biz_times else 'Not set'
        
        # Iterate over products
        for cat_id, products in data.get('productsByCategory', {}).items():
            for p in products:
                writer.writerow([
                    store_id, store_name, address, phone, industry, business_hours,
                    'Yes' if not store_info.get('IsBizClosed') else 'No',
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
                    'Yes' if p.get('isOutOfStock') else 'No',
                    p.get('defaultproductimage', {}).get('imagepath', ''),
                    p.get('barcode', ''),
                    p.get('description', ''),
                    'Yes' if p.get('isNewly', 0) > 0 else 'No',
                    p.get('createTime', '')
                ])
```

**Final data**:
- 43 stores
- 2,084 products
- 23 fields
- 880KB file size

## 6. Pitfalls Encountered

### 6.1 Encrypted Mini Program Package

WeChat mini program wxapkg files are encrypted, so unpacking them directly fails. Extracting strings with the `strings` command turned out to be an effective workaround.

### 6.2 Wrong API Endpoint

The endpoint I initially guessed, `wxapi/product/FindProducts`, returned an HTML page. Only by analyzing the mini program code did I find the correct endpoint: `wxapi/product/categories`.

**Lesson**: Don't guess APIs based on experience — find the real endpoints by reverse-engineering the code.

### 6.3 Confusing Store IDs

There are two kinds of store IDs in the system:
- Platform ID: 4540116 (used to fetch the store list)
- Actual store ID: 4188030 (used to fetch menus)

**Lesson**: When capturing traffic, pay attention to the parameters actually used in requests — don't just rely on variable names in the code.

### 6.4 Anomalous Address Data

I noticed that the store "Multigrain Fish Noodle" lists its address as "Fifth Cafeteria, Guangzhou Software College, Guangzhou, Guangdong", but there is no Fifth Cafeteria on campus. That's a data issue on the platform's side, not a scraping problem.

## 7. Summary and Outlook

### Results

Through this reverse-engineering project, I successfully:
1. Analyzed the technical architecture of the GuangRuan XiaoEr mini program
2. Scraped complete data for all 43 stores and 2,084 products on the platform
3. Generated a visual HTML report and CSV data files

### Potential Applications

- **Price comparison**: Compare similar products across stores
- **Smart recommendations**: Recommend meals based on budget and taste
- **Data analysis**: Analyze price distribution in the campus food market
- **Automated ordering**: Build an auto-ordering bot

## 7. Summary

Through this reverse-engineering project, I successfully:
1. Analyzed the technical architecture of the GuangRuan XiaoEr mini program
2. Scraped complete data for all 43 stores and 2,084 products on the platform
3. Generated CSV data files

### Potential Applications

- **Price comparison**: Compare similar products across stores
- **Smart recommendations**: Recommend meals based on budget and taste
- **Data analysis**: Analyze price distribution in the campus food market

---

**Author**: windy664  
**Date**: 2026-09-26
