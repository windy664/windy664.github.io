---
title: "Building an AI Ops Agent: What to Hand to the LLM, What to Keep Away From It"
date: 2026-06-13 22:00:00
tags: [LLM, Agent, Architecture, Minecraft]
categories: [Thoughts]
---

"We're an AI project" — the biggest trap in that sentence is that it makes you reflexively shove every task into the LLM. While building WindyAgent, I kept stumbling over the question "should this step call the LLM or not," and gradually worked out a dividing line.

<!-- more -->

## Counterexample 1: Having the LLM price items one by one — 14 minutes and still inaccurate

When I needed to value over a thousand items, I once tried having the LLM quote prices one at a time. When it actually ran: mimo priced 80 items, **one batch took 170 seconds**, and 5 batches came to nearly 14 minutes. And on top of that —

Asking an LLM to do ten-level-deep crafting-tree arithmetic like "A = 4×B + C, B = 4×D + E..." means it will make mistakes and contradict itself. **This is structured graph computation, not a language task.** This kind of work belongs to deterministic code: my recipe-propagation pipeline processes 649 items in **seconds**, and every run produces identical, reproducible, explainable results.

> One counterintuitive point: batch size (80) has no effect on total time at all. LLM valuation time ≈ item count × per-item cost (mimo ~2 seconds/item), regardless of how many batches you split it into. To go faster, you can only **reduce the number of items it has to price** — tweaking batch size does nothing.

## Counterexample 2: Do deterministic commands secretly burn tokens?

Someone asked me: those "type it and it runs" deterministic commands of yours — are they secretly calling an LLM behind the scenes?

No. The handling logic looks like this:

```kotlin
val meta = router.dispatch(input, ...)   // pure code, checks whether the first word matches a command
if (meta != null) { reply; return }       // match → execute and return, never reaches below
val resp = agent.run(context)             // ← the only place the LLM is called
```

Input goes through `dispatch` first; if the first word matches a command (`build`/`status`/`clear`...), it executes and returns immediately — **it never even reaches the LLM**. Deterministic commands are the **zero-token** path. Only natural language that *isn't* a command falls through to `agent.run` and spends tokens.

So "deterministic commands" and "saving tokens" aren't contradictory — quite the opposite. The whole point is to **route around the LLM** for high-frequency, well-specified operations.

## So what is the LLM actually good at?

Once you rule out everything it does badly, where the LLM genuinely earns its keep becomes clear:

- **Natural-language intent**: "broadcast that there's an event at 8 PM tonight" — translating human speech into tool calls.
- **World knowledge**: "Nether Stars are rare, basic essence is cheap" — this kind of judgment can't be computed from recipes, but the model saw it during training.
- **Classification**: sorting an item into "common / rare / epic" tiers.

The third point is the key compromise. When pricing source items, I ended up not asking the LLM for exact numbers — instead I had it **only do the tiering** (classification is its strength), with the gold value of each tier written into config, and exact prices derived by deterministic propagation. That cut LLM calls from "hundreds of items" down to "a few dozen tier judgments" — faster and consistent. **Let the LLM produce labels; let code produce numbers.**

## "Asks but doesn't act": a chronic weakness of weaker models — fix with prompts, backstop with commands

Another pitfall: you give the LLM an imperative like "kick Steve," and weaker models (especially the cheap ones) often **ask back "are you sure you want to kick them?" or verbally agree without actually doing it**. I bent it into line with the system prompt — explicitly writing "execute ops commands directly, only ask follow-ups when parameters are missing, don't ask whether to proceed."

But that's **treating the symptom**. The cure: for genuinely high-frequency operations that need 100% reliability, build deterministic commands as the backstop, and don't bet on the model's mood. A prompt can make it "very likely to act"; a command makes it "certain to act" — the two cost differently, so pick per scenario.

## A decision table I actually use

| Characteristics of the step | Hand it to |
|---|---|
| Enumerable / computable / needs reproducibility / high-frequency | **Deterministic code** (commands, propagation, rules) |
| Open-ended language / needs world knowledge / fuzzy intent | **LLM** |
| In between (tagging, tiering, extraction) | **LLM produces labels + code produces results** |

## Final thoughts

Don't let the word "AI" on your project turn the hammer into your only tool, making you want to bang on everything you see. The LLM is one tool in the toolbox, not the box itself.

My default order when building a feature now is: **first ask whether it can be done deterministically** — anything enumerable, computable, or rule-definable gets made deterministic (with zero tokens, instant responses, and reproducibility as a bonus); **only at the seams that genuinely require "understanding" and "judgment" do I bring in the model**. That architecture is the least stressful and the cheapest — and once you've made deterministic everything that can be, you see more clearly exactly which few points the LLM's irreplaceable value actually sits on.
