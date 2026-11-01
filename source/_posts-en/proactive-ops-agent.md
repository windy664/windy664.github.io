---
title: "From \"You Ask, I Answer\" to \"I'll Go Check Myself\" — The Line Between an Agent and a Chatbot"
date: 2026-06-14 21:30:00
tags: [Agent, Ops, Architecture, Minecraft]
categories: [Thoughts]
---

After working on WindyAgent for so long, one day I stared at it and suddenly realized something a bit embarrassing: what I had built was actually a **very capable passive assistant** — you send `!ai` and it replies, you tell it to do something and it does it. But in the five characters "运维 Agent" (Ops Agent), the most valuable part is precisely **proactiveness**. Ops isn't waiting around for someone to ask; it's watching things yourself and being the first to know when something goes wrong.

This post records my first step in pushing it from a "Q&A machine" toward "an Agent that patrols on its own," plus a few boundaries I figured out along the way.

<!-- more -->

## Passive vs. proactive: the difference isn't features, it's "who speaks first"

A passive assistant's entire interaction loop is: human speaks → it responds. No matter how smart it is, it has to wait for you.

A proactive Agent adds another loop: **it checks on a schedule → spots anomalies → speaks up on its own**. The minimal closed loop I built for it has four steps:

> Monitor (scheduled checks of each sub-server's TPS / memory / online / offline status) → Evaluate (threshold-flip detection) → Recommend (call the LLM on anomalies for a one-line diagnosis + suggested action) → Notify (console + web alerts).

Sounds simple, but "letting it act on its own" forced me to make an uncomfortable decision at every single step.

## Decision one: edge-trigger, or it will drown you

My first version went like this: "every patrol round, if TPS is below the threshold, report it." Run that through your head and you know it's doomed: one laggy server, one check every 30 seconds, and it will **report "lagging" every 30 seconds** — hundreds of alerts overnight, turning the alert channel into a landfill. Once alerts flood in, people stop reading them — which is worse than having no alerts at all.

So I switched to **edge triggering**: only report once when the state **flips**. TPS drops below the threshold — one "lag started" alert; it recovers — one "recovered" alert; silence in between. In code, it's just maintaining a "currently active alerts" set per server, and only pushing when `add` succeeds (i.e., goes from absent to present):

```kotlin
private fun raise(s: String, k: IncidentKind, ...) {
    if (active(s).add(k)) onIncident(...)   // only report on new entries; duplicate add returns false
}
```

A simple truth, but one you have to internalize on day one of building monitoring: **the value of an alert isn't "reporting everything," it's "reporting accurately without spamming."**

## Decision two: it can "propose," but don't let it "act" yet

This was the one I agonized over the longest. A proactive Agent spots a lagging server — should it go run `/restart` itself, kick players itself?

Technically not hard. But facing a server that **I had never stress-tested myself**, I really couldn't bring myself to hand an unwatched AI the steering wheel for "destructive commands." If it judged wrong and restarted the server at midnight, kicking every player offline, I'd still be asleep.

So the policy I settled on is **"advise, don't execute"**: the sentinel spots a problem, calls a cheap model for a one-line diagnosis + suggested action (even including the exact command), but it **just pushes it to me** — execution/approval stays with the human. If it's ever going to act automatically, anything high-risk still has to go through my manual approval gate.

The longer I think about this boundary, the more right it feels: **the degree of automation should match how much you trust its judgment**. Trust is fed slowly with data, not granted by handing over all the keys on day one. Let it be a reliable "pair of eyes + advisor" first; once its judgment has been validated enough times, gradually delegate authority down to its "hands."

## Decision three: when unattended, hard-block all high-risk operations

Later I added a scheduled "nightly knowledge base cleanup" task — letting the Agent distill the day's data into the knowledge base by itself in the early morning. That raised a new problem: **in unattended mode, the Agent still carries tools** — what if, mid-cleanup, it gets a "bright idea" and runs a dangerous command?

I added an `unattended` flag to the request context. When unattended, high-risk commands no longer "enter the approval queue and wait for a human" (nobody is approving anything at midnight) — instead they're **blocked outright + logged**. It can read data, write to the knowledge base, and write to memory, but it can't reach destructive operations — **not because it behaves itself, but because that road is physically sealed off**.

## A bug that sobered me up: proactive monitoring presumes "the metrics are actually obtainable"

After the sentinel went live, I discovered that on my test server (Youer, a NeoForge hybrid), **TPS was always -1**. Because `getTPS()` is a Paper API, and Youer doesn't have it. The result: my "lag alert" was **never going to fire from day one** — the sentinel's eyes were open, but one of them was blind.

I later used NMS reflection to read the real TPS (that's a story for another post). But this pitfall taught me a lesson:

> When building proactive monitoring, the first thing to do isn't writing alert logic — it's confirming that **the metric you want to monitor is actually obtainable in your target environment**. Don't take it for granted that the APIs exist. A monitor that can't get data is more dangerous than no monitor at all — because it gives you the false sense of security that "someone is watching."

## Final thoughts

The dividing line between a passive assistant and a proactive Agent, I now believe, isn't "how capable it is" — it's three questions:

- Will it **speak up on its own**? (the monitoring loop)
- When it speaks up, will it **drown you**? (edge triggering, alert discipline)
- How far can it **act**? (matching trust to permissions, hard boundaries when unattended)

I didn't push it to full autonomy in one step — quite the opposite: I let it **be the eyes and the advisor first, while the hands stay with me**. An Agent that patrols on its own, judges, and offers suggestions, but asks you before acting, is already a big step beyond "you ask, I answer." The rest of the delegation can wait until it proves it deserves it.
