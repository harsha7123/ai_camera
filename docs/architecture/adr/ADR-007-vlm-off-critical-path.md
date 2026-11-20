# ADR-007: VLM is local, advisory and off the critical path
**Status:** Accepted · **Date:** 2026-10-27, revised 2026-11-20

## Decision
No alert depends on a vision-language model. A local open-weight VLM (e.g. Qwen3-VL, Apache-2.0) may later:
1. power **natural-language search** over incidents and clips for complaint investigation (playbook H4: "show me the 2:15 pm order at register 1") — combined with the existing `pos_ref` search;
2. summarise an existing incident clip in a constrained schema.
It cannot create, escalate or close incidents. No continuous video goes to an external provider.

## Ship condition
Measured reduction in time-to-find / time-to-disposition without more wrong dispositions, and a privacy review of any search index (an index of footage is itself personal data).
