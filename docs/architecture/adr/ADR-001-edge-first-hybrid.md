# ADR-001: Edge-first hybrid deployment
**Status:** Accepted · **Date:** 2026-10-27, revised 2026-11-20 for the restaurant product

## Context
Restaurants already own cameras and an NVR ("zero hardware overhaul" in the owner's industry notes). Uplinks are shared with POS and guest Wi-Fi; 12 cameras streamed to a cloud need roughly 24–48 Mbps sustained upstream [E]. Footage shows employees at work and customers paying, so it is sensitive. Register exceptions and after-hours alerts must still work when the internet drops. The playbook itself suggests "a local AI box that only sends clips/metadata to cloud".

## Options
A. Fully local · B. Cloud video analytics · C. Edge processing + metadata-only cloud

## Decision
**C.** One appliance per site runs vision-worker, core, web and Postgres. Video and clips stay on site. The cloud (roadmap) carries metadata only: multi-site dashboard, fleet updates, push/SMS relay.

## Consequences
+ Works offline; low uplink; video never leaves the restaurant by default; simple privacy story for employees and customers.
− Hardware per site and a spare-unit process; multi-site views need the metadata plane (roadmap); remote clip review means reaching the site box, not a cloud bucket.
