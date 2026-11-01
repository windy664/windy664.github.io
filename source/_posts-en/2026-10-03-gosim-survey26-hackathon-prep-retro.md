---
title: "GOSIM Sky-Survey Agent Hackathon Prep Retrospective: Pushing the Baseline from 4223 to 4846 in One Day"
date: 2026-10-03 23:59:00
tags:
  - Hackathon
  - AI Agent
  - GOSIM
  - Retrospective
categories:
  - Tech Notes
---

# GOSIM Sky-Survey Agent Hackathon Prep Retrospective: Pushing the Baseline from 4223 to 4846 in One Day

## Background

In the early hours of October 5, the GOSIM "Agent Sky Survey" hackathon (survey26) officially kicked off. The premise is romantic: your agent takes over a (simulated) spectroscopic survey telescope and autonomously decides the pointing, duration, observation program, and fiber allocation for every exposure across an entire observing season — but it can't see the real weather. It can only guess from a briefing that arrives every 15 minutes, and the entire survey has a real wall-clock budget of just 900 seconds.

This post is a retrospective of the prep work I did the day before the competition started. Report card first:

| Local card | Official example baseline | After tuning | Δ |
|---|---|---|---|
| L1 | 4458.6 | 4508.5 | +50 |
| L2 | 4767.7 | 4895.2 | +128 |
| L3 | 4288.3 | 4813.7 | +525 |
| L4 | 3378.5 | 5166.2 | +1788 |
| Average | 4223.3 | **4845.9** | **+623** |

## Intelligence First: Turning the Static Site into Documents

The competition platform is a Vue SPA hosted on GitHub Pages, with no traditional "documentation page" to scrape. But being an SPA means all the content lives in the JS chunks. I pulled down the site's entire frontend bundle and used regexes to extract the Chinese documentation, the full rules, and the descriptions of the four practice cards from the minified string literals. Combined with the transcript PDF of the official lecture (shared in the WeChat group), I organized everything into five requirements documents and committed them to the repo.

The payoff was immediate: many of the pitfalls I later hit in code were actually documented (for example, the rule that "hit_count is a purely geometric determination," which became the foundation of the pointing_offset detector later on).

**Lesson one: don't fully trust transcripts.** In the lecture transcript, "9900 seconds" was actually 900 seconds, and `--cards ../local_cards/l1` was actually `--card ../local-cards/L1`. For any critical number or command, always cross-validate against the code and the written documentation.

## Baseline Analysis: Where the Points Were Being Lost

After getting the official example running, I didn't rush to change code — I first did a loss attribution analysis. The baseline profiles across the four local cards were remarkably consistent:

1. **0% completion rate on time-limited observation requests** — the code had zero references to the `observation_request` message type, so the free points the system hands out (up to +200 per card) went entirely unclaimed;
2. **15 required targets missed** (−750 in total) — and I found a beautiful counterintuitive bug: targets with more failed attempts were exponentially down-weighted (0.7^attempts), so **the more they failed, the less they were retried** — they sank to the bottom of the queue and never got scheduled again;
3. **Only 4% of the 900-second wall clock was used** — the pacing logic could only throttle down, never up, so the anchor search stayed at its lowest setting permanently.

## Fixes: Three Changes, +623 Points

- **Request-aware scheduling**: parse `active_requests`, add a scheduling bonus for requested targets, and constrain exposure durations by the request deadline (only exposures that fall entirely within the window count) → +100 on each of three cards;
- **Exempt required targets from failure damping** + guarantee they enter the candidate pool on the final night → L4 went from missing 8 required targets to missing just 1;
- **Ledger rebuild on state_resync**: in Hard mode, a data_loss event invalidates a stretch of observations. The original code voided the observations but kept the historical success/failure records, so invalidated targets kept carrying their "failure damping" and could never recover. After clearing the ledger, L4 jumped straight up by +1788.

There was also a deeply hidden bug: earthquake announcements get replayed every slot throughout the entire recovery period (about 17 days), while the fault detector's evidence pool requires "clean" samples. The earthquake announcements made every sample permanently unclean, freezing the fault evidence so subsequent instrument faults could never be reported. After excluding earthquakes from the announcement set, three cards each recovered +100 in reporting points.

## Cloud Reality Check: The LLM Came Alive — and Made Things Worse

I submitted the packaged agent to the platform and ran practice cards α–δ. There's a fundamental difference between cloud and local: **the LLM actually works on the platform** (the platform injects its own model proxy). During local debugging, all LLM calls failed and fell back to rule-based defaults; in the cloud, night_advice was genuinely giving advice every night.

And then things like this showed up in the logs:

```
avoid=['E', 'N', 'NE', 'NW', 'S', 'SE', 'SW', 'W']  duration x0.70
```

All eight directions advised to avoid — effectively "don't do any work tonight." At the same time, exposure durations were cut to 70%, which pushed a batch of borderline required targets below the 0.5 completion threshold. In the cloud, the four cards missed 20/15/9/20 required targets — an order of magnitude worse than locally.

The fix was to add a "sanitization layer" for LLM advice: discard any avoid-all recommendation covering more than 7 directions (a full-sky shutdown is handled by our own announcement mechanism), raise the duration-scaling floor to 0.85, and apply only a 20% discount to LLM avoidance advice for required targets. **LLM output must always pass through a layer of deterministic validation — this principle cannot be emphasized enough in agent engineering.**

The platform's public test cards also exposed another structural difference: a short season of only 7 nights (the local cards are all 38 nights), so the "last-minute rescue on the final night" logic never had time to kick in. I changed it to an emergency window that adapts to the season length.

## Engineering Incident: Zombie Subagent and Output Races

An honest record of an incident that day. I delegated an iterative tuning task to a coding subagent. It hit the 2-hour limit and reported a timeout — but **it wasn't actually dead**; it kept running tests in the background. Unaware of this, I was running tests on my side too, and both test processes shared the same `run_output/` directory, overwriting each other's result files. For a while I was analyzing L1 card faults using the L4 card's message stream, and nearly drew a wrong conclusion.

Three lessons:

1. Concurrent experiments must have isolated output directories, or use locks;
2. "Timed out" does not mean "terminated" — when managing background tasks, confirm the process has actually exited;
3. Slice large tasks small enough to close the loop within the time limit — nobody can babysit a two-hour task.

## Pre-Competition Status

The code is at [gosim-survey26-agent](https://github.com/windy664/gosim-survey26-agent) (private; will be open-sourced after the competition per the rules): request scheduling, required-target guarantees, and both Hard mode mechanisms (data_loss rebuild + pointing_offset probe) are implemented, with zero-regression verification on all four local cards.

Remaining risks: pointing_offset can't be validated on any local card, so I have to wait for the cloud γ/δ results; L1's fault reports get diluted during the earthquake recovery period — the ±100 point tradeoff is shelved for now; and the model quota depends on the Kimi Coding Plan redemption code awarded to the "first 100 teams to complete the practice round."

The competition starts at 00:00 on October 5, when the four official cards A–D go live. I'll write a proper retrospective after the competition — hopefully with a trophy in hand.

---

*Note: the protocol analysis in this post is based on the competition's public documentation and the local evaluation engine, in compliance with the competition rules (what's prohibited is only reading other teams' data and manually intervening in decisions).*
