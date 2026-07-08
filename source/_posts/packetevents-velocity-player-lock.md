---
title: Velocity 端 packetevents 登录锁：双层架构设计与实现
date: 2026-07-08
tags: [Minecraft, Velocity, packetevents, 网络编程, 架构设计]
---

在 Minecraft 代理端实现玩家登录锁，听起来简单——不就是阻止玩家移动吗？但当你真正动手时会发现：Velocity 没有 `PlayerMoveEvent`，没有 `BlockBreakEvent`，甚至连 `PlayerInteractEvent` 都没有。代理层根本不感知游戏状态。

这篇文章记录了我们如何用 **packetevents + Velocity 原生事件** 设计出一套双层锁架构，从需求分析到代码实现的完整思考过程。

<!-- more -->

## 一、问题背景

### 1.1 旧方案的痛点

之前的登录锁在 Bukkit 子服端实现（`PlayerLockListener`），通过监听 Bukkit 事件来拦截玩家操作：

```java
// 旧方案：Bukkit 端事件拦截
@EventHandler
public void onMove(PlayerMoveEvent e) {
    if (locked(e.getPlayer())) {
        // 拉回原位
        e.setTo(back);
    }
}
```

这个方案有几个问题：

1. **包已经到了子服才被拦截**——有延迟，玩家可能已经移动了几个 tick
2. **子服插件崩了锁就失效**——安全依赖于子服的稳定性
3. **每个子服都要装插件**——多子服架构下维护成本高
4. **子服需要配合**——登录提示需要子服发 title/message

### 1.2 新目标

我们希望把锁**上移到代理层**（Velocity），实现：

- 包在代理层就被拦截，**根本不到子服**
- 子服不需要装任何锁相关插件
- 登录提示由 Velocity 直接发（`player.showTitle()`）
- QQ 号输入也在 Velocity 端处理（不再依赖子服的聊天监听）

## 二、技术选型：为什么是 packetevents？

### 2.1 Velocity 原生 API 能做什么？

先看看 Velocity 自带的事件系统（`com.velocitypowered.api.event.player` 包）：

| 事件 | 能否用于锁定 |
|------|-------------|
| `PlayerChatEvent` | ✅ 能拦截聊天 |
| `TabCompleteEvent` | ✅ 能拦截补全 |
| `ServerPreConnectEvent` | ✅ 能拦截切服 |
| `PlayerChooseInitialServerEvent` | ✅ 能选初始服 |

**关键发现：Velocity 没有 `PlayerMoveEvent`。**

Velocity 是代理层，不感知游戏状态。它没有：
- ❌ `PlayerMoveEvent`——无法阻止移动
- ❌ `BlockBreakEvent` / `BlockPlaceEvent`——无方块事件
- ❌ `PlayerInteractEvent`——无交互事件
- ❌ `EntityDamageEvent`——无伤害事件
- ❌ `InventoryClickEvent`——无背包事件

**纯 Velocity API 做不了完整的登录锁。**

### 2.2 packetevents 的优势

[packetevents](https://github.com/retrooper/packetevents) 是一个跨平台的 Minecraft 协议库，它在 Netty channel 层插桩，**所有包都经过它**：

```java
public class PlayerLockPacketListener extends PacketListenerAbstract {
    @Override
    public void onPacketReceive(PacketReceiveEvent event) {
        // 这里可以拦截任何客户端→服务端的包
    }

    @Override
    public void onPacketSend(PacketSendEvent event) {
        // 这里可以拦截任何服务端→客户端的包
    }
}
```

这意味着我们可以拦截：移动、交互、攻击、聊天、命令、物品操作……**所有类型的包**。

### 2.3 最终选型：两者结合

| 层 | 工具 | 职责 |
|---|---|---|
| **拓扑层** | Velocity 事件 | 控制玩家能去哪个服、能不能切服 |
| **行为层** | packetevents | 控制玩家在游戏里能做什么 |

## 三、双层锁架构设计

### 3.1 整体流程

```
玩家进服 → 子服加载完成
  ↓
ServerPostConnectEvent (Velocity 事件层)
  ├── lockState.lock(name)
  ├── 启动定时提醒（player.showTitle + sendMessage）
  └── 放行（玩家已在子服，能看到世界）
        ↓
PlayerLockPacketListener (packetevents 包层)
  ├── 白名单放行：KEEP_ALIVE / TELEPORT_CONFIRM / CLIENT_SETTINGS
  ├── 聊天：未绑定玩家 → 读QQ号 → 处理；已绑定 → 拦截
  ├── 移动：捕获坐标 + 拦截 + 发 Position 包拉回
  └── 其他：全部拦截
        ↓
onPacketSend → 全部放行（区块/实体/世界正常下发）
        ↓
ServerPreConnectEvent (Velocity 事件层)
  └── locked → denied()，不让切服
        ↓
群里发"登录"/"绑定" → unlock()
```

### 3.2 两层互补

| 场景 | packetevents 兜底 | Velocity 事件兜底 |
|------|-------------------|-------------------|
| 玩家移动 | ✅ 包级拦截拉回 | — |
| 玩家切服 | — (包到子服才处理) | ✅ 代理层直接拒绝 |
| 子服崩溃重启 | ✅ 包仍经过代理拦截 | ✅ 切服被拒 |
| 玩家聊天/命令 | ✅ 包级拦截 | — |
| 区块加载 | ✅ 放行不崩客户端 | — |

### 3.3 包过滤策略

```java
// 白名单：必须放行，否则连接断开
private static boolean isWhitelisted(PacketTypeCommon type) {
    return type == PacketType.Play.Client.KEEP_ALIVE
            || type == PacketType.Play.Client.TELEPORT_CONFIRM
            || type == PacketType.Play.Client.CLIENT_SETTINGS
            || type == PacketType.Play.Client.CHUNK_BATCH_ACK;
}
```

**为什么 CHUNK_BATCH_ACK 必须放行？**

区块数据是服务端主动推给客户端的。如果我们不放行 `CHUNK_BATCH_ACK`，服务端会认为客户端没有收到区块，可能导致连接超时断开。而且——我们**不想阻止区块加载**，玩家应该能看到正常的世界，只是不能动。这比显示一个空白屏幕体验好得多。

## 四、关键实现细节

### 4.1 锁定坐标的捕获

玩家进服时我们还没有坐标信息。坐标从哪里来？——**第一个 Position 包**。

```java
private void tryCapturePosition(PacketReceiveEvent event, String name,
                                PacketTypeCommon type) {
    // 已经捕获过就跳过
    VelocityPlayerLock.LockData existing = lockManager.getLockData(name);
    if (existing != null && existing.hasPosition()) return;

    Object buf = event.getByteBuf();
    // packetevents 框架已读取 packetId VarInt，游标在 payload 起始位置
    double x = ByteBufHelper.readDouble(buf);
    double y = ByteBufHelper.readDouble(buf);
    double z = ByteBufHelper.readDouble(buf);

    float yaw = 0, pitch = 0;
    if (type == PacketType.Play.Client.PLAYER_POSITION_AND_ROTATION) {
        yaw = ByteBufHelper.readFloat(buf);
        pitch = ByteBufHelper.readFloat(buf);
    }

    lockManager.capturePosition(name, x, y, z, yaw, pitch);
}
```

**只取一次**——后续所有移动包都拦截，然后发一个 Position 包把玩家拉回这个坐标。

### 4.2 发送锁定位置包

当玩家尝试移动时，我们取消他们的移动包，并发一个 Position 包把他们拉回来：

```java
private static void sendLockPosition(User user, VelocityPlayerLock.LockData data) {
    WrapperPlayServerPlayerPositionAndLook pos =
        new WrapperPlayServerPlayerPositionAndLook(
            data.getX(), data.getY(), data.getZ(),
            data.getYaw(), data.getPitch(),
            (byte) 0,  // flags: 0 = 绝对坐标
            0,          // teleportId
            false);     // dismountVehicle
    user.sendPacket(pos);
}
```

**关键点：`flags = 0`**。这个字段控制坐标是绝对值还是相对值。设为 0 表示所有坐标都是绝对值，客户端会直接移动到指定位置。

### 4.3 聊天处理：从 Bukkit 迁到 Velocity

旧方案中，玩家输入 QQ 号的逻辑在 Bukkit 端（`AsyncPlayerChatEvent`）。新方案中，这完全在 Velocity 端处理：

```java
private void handleChat(PacketReceiveEvent event, String name) {
    event.setCancelled(true); // 拦截，不让到子服

    if (!lockManager.isAwaitingQQ(name)) {
        return; // 已绑定：聊天已被拦截
    }

    // 未绑定玩家：读取聊天内容
    WrapperPlayClientChatMessage wrapper = new WrapperPlayClientChatMessage(event);
    String message = wrapper.getMessage();
    Player player = proxy.getPlayer(name).orElse(null);
    if (player != null) {
        lockManager.handleChatInput(player, name, message);
    }
}
```

`handleChatInput` 内部调用 `BindingService.declareQQ()`（异步下载头像），然后通过 `player.sendMessage()` 直接回复玩家。

### 4.4 解耦设计：PlayerLockManager 接口

`VelocityBridge` 在 `velocity` 模块，`VelocityPlayerLock` 在 `xt-auth` 模块。velocity 不能依赖 xt-auth，所以我们在 `common-core` 中定义接口：

```java
// common-core
public interface PlayerLockManager {
    void lock(String player);
    void unlock(String player);
    boolean isLocked(String player);
    void onDisconnect(String player);
}
```

```java
// xt-auth
public class VelocityPlayerLock implements PlayerLockManager {
    // 实现...
}
```

```java
// velocity
public class VelocityBridge {
    private volatile PlayerLockManager lockManager; // 接口类型，不依赖 xt-auth

    public void setLockManager(PlayerLockManager lockManager) {
        this.lockManager = lockManager;
    }
}
```

这是经典的**依赖倒置原则**——高层模块不依赖低层模块，都依赖抽象。

### 4.5 AuthAdapter 替换

旧方案中，`PluginMessageAuthAdapter` 把 `login()`/`register()` 操作通过 PluginMessage 发给子服执行。新方案中，解锁直接在 Velocity 侧完成：

```java
public class VelocityDirectAuthAdapter implements AuthAdapter {
    private final VelocityPlayerLock lock;

    @Override
    public void login(String player) {
        lock.unlock(player);  // 直接解锁，不走 PluginMessage
    }

    @Override
    public void register(String player) {
        lock.unlock(player);
    }

    @Override
    public void titlePlayer(String player, String mainTitle, String subTitle) {
        proxy.getPlayer(player).ifPresent(p ->
            p.showTitle(Title.title(legacy(mainTitle), legacy(subTitle))));
    }
}
```

当玩家在 QQ 群发送「登录」时，流程是：

```
QQ群"登录" → WhitelistHandler → BindingService.loginByGroup()
  → authAdapter.login(playerName)
  → VelocityDirectAuthAdapter.login()
  → lock.unlock(playerName)
  → packetevents 停止拦截该玩家的包
```

## 五、扩展点设计

### 5.1 加群二维码地图（TODO）

```java
// VelocityPlayerLock 中预留的扩展点
private volatile Consumer<Player> qrMapProvider;

/**
 * 设置加群二维码地图提供者（TODO：以后实现）。
 * 调用时机：玩家 QQ 登记成功、进入「去群里发『绑定』」阶段。
 */
public void setQrMapProvider(Consumer<Player> provider) {
    this.qrMapProvider = provider;
}
```

二维码地图渲染已经在 `VelocityMapPacketSender` 中实现了（用 packetevents 直发地图包），只是还没接入锁管理器的回调。

### 5.2 登记成功回调

```java
private volatile Consumer<String> onCodeIssued;

// 在 handleChatInput 中，QQ 登记成功后触发
if (r.success) {
    awaitingQQ.remove(name);
    Consumer<String> cb = onCodeIssued;
    if (cb != null) cb.accept(name);
}
```

这个回调可以挂接任何逻辑：发加群二维码、发欢迎消息、记录日志……

## 六、踩坑记录

### 6.1 WrapperPlayServerPlayerPosition 不存在

一开始以为发 Position 包用 `WrapperPlayServerPlayerPosition`，结果编译报错找不到类。查了 packetevents 源码才发现，服务端发给客户端的 Position 包封装在 `WrapperPlayServerPlayerPositionAndLook` 中——它同时包含位置和视角。

```java
// ❌ 不存在
new WrapperPlayServerPlayerPosition(x, y, z, yaw, pitch, flags, teleportId);

// ✅ 正确
new WrapperPlayServerPlayerPositionAndLook(x, y, z, yaw, pitch,
    (byte) 0, 0, false);
```

### 6.2 velocity 模块不能引用 xt-auth 的类

`VelocityBridge` 在 `velocity` 模块，`VelocityPlayerLock` 在 `xt-auth` 模块。Gradle 模块依赖方向是 `xt-auth → velocity`，反过来不行。

解决方案：在 `common-core` 定义 `PlayerLockManager` 接口，两个模块都依赖 `common-core`。

### 6.3 ByteBuf 游标位置

packetevents 框架在构造 `ProtocolPacketEvent` 时已经读取了 `packetId`（VarInt），所以 ByteBuf 的游标在 payload 起始位置。读取坐标时不需要再跳过 packetId。

但要注意：读取后必须 `resetReaderIndex()`，否则后续的包处理会读到错误的位置。

### 6.4 区块包不能拦

最初考虑过拦截服务端→客户端的区块包来实现"黑屏锁定"效果。但这样做的后果是：

1. 客户端收不到区块数据，会不断请求重传
2. 服务端不断重发，带宽暴涨
3. 最终可能超时断开，或者客户端崩溃

**结论：区块包必须放行**，让玩家看到正常世界，只是不能操作。

## 七、性能考虑

### 7.1 包拦截的开销

每个包都要经过 `onPacketReceive` 检查 `isLocked(name)`。这是一个 `ConcurrentHashMap.contains()` 操作，时间复杂度 O(1)，开销可以忽略。

### 7.2 定时提醒的开销

每个锁定玩家每 3 秒收到一次 title + message。对于正常服务器（几十个玩家同时在线），这个开销完全可以接受。

### 7.3 内存

每个锁定玩家的数据：
- `LockState`：一个 `ConcurrentHashMap` 的 entry
- `LockData`：5 个 primitive 字段（x, y, z, yaw, pitch）
- `awaitingQQ`：一个 `Set` 的 entry
- `reminderTasks`：一个 `ScheduledTask` 引用

总计约 200 字节/玩家，100 个锁定玩家才 20KB。

## 八、总结

这个方案的核心思路是**分层解耦**：

- **Velocity 事件层**做粗粒度的拓扑控制（能不能切服）
- **packetevents 包层**做细粒度的行为控制（能不能移动/交互）
- **common-core 接口**做模块解耦（velocity 不依赖 xt-auth）

每一层只关心自己的职责，出了问题也只影响自己。packetevents 漏了一个包？Velocity 事件层兜底。Velocity 事件层没拦住切服？packetevents 在新子服继续拦截。

代码已开源在 [XingtuBot-Spigot](https://github.com/windy664/XingtuBot-Spigot) 项目的 `xt-auth` 模块中。
