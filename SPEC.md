# AI Tools Auditor

Status: local queue, isolated yt-dlp caption retrieval, manual channel discovery over public Atom feeds, research packets, validated imports, and Obsidian generation implemented. Ongoing daily scheduling, live subscription analysis, distributable container packaging, and three-video acceptance remain pending.

## Purpose

Reduce time spent watching AI videos while discovering tools the user will actually use or build. Produce evidence-backed decision reports in an Obsidian vault.

## Evaluation profile

- Primary interests: building and running personal software, automating personal work, and keeping tool data local.
- Subscription budget and providers are user-configured. Do not assume paid API access.
- The local workflow requires no paid API usage. Research sessions use a provider chosen by the user.
- Runtime preference: containers where available. Each installation must inspect its own resources.
- Acceptable setup: one command to start after initial configuration, with occasional updates.
- The auditor may use hosted services. Privacy preferences concern the tools being evaluated.
- Favor local-data options when similarly capable; hosted tools remain eligible with explicit privacy tradeoffs. Sensitive-data exclusions require an explicit designation.

## Inputs and processing

Monitor a configurable list of YouTube channels daily and accept individual video URLs. Process new uploads; historical backfills are explicit actions.

Discovery queues work automatically. AI analysis may wait for a user-launched session using the existing subscription. Verify the supported integration before promising unattended analysis. Keep failed work visible and retryable.

Extract distinct tools from each video and maintain one identity per product. Eligible subjects include hosted products, open-source projects, models, reusable workflows, and potential personal builds.

Videos are discovery leads. Research transcripts, current documentation, pricing, repositories, and available independent evidence. Separate vendor claims, verified facts, estimates, and hands-on results. The first version does not install or execute discovered tools.

Videos without usable transcripts are blocked for manual review rather than audited from titles and descriptions alone. Disclose when visual demonstrations were not inspected.

## Decision reports

Lead with one of: use existing, buy, adapt, build, watch, or skip.

Explain the task solved, personal fit, evidence, costs, local-data support, setup and maintenance burden, alternatives, and uncertainties. Cite sources and date the evidence checks. Withhold positive recommendations when supporting evidence is insufficient.

Build feasibility concerns the smallest useful implementation for the user, not feature parity with a commercial product. Compare using existing resources, buying, adapting open source, building, and skipping. Identify dependencies, estimated effort, maintenance, privacy implications, recurring costs, and unproven assumptions.

The output is advice. Purchases, accounts, installations, connecting services, execution of discovered software, adoption, and implementation are separate user decisions.

## Identity, comparisons, and freshness

Distinguish repeat coverage of one product from different products solving the same job. Attach repeat mentions as new evidence instead of creating duplicate tool notes.

Compare alternatives for specific tasks. Refresh current evidence for both sides when a new competitor triggers a comparison. Permit different strengths and insufficient evidence instead of forcing a winner.

Keep the current assessment accessible and preserve dated verdict changes with their reasons. Mark other reports as needing refresh after 30 days; refresh on request or comparison rather than repeatedly researching the entire catalog.

## Obsidian output

Write to a configurable dedicated folder in an existing vault, or a standalone folder that can be opened as a vault. Use standard Markdown links and properties without mandatory plugins.

- One current note per tool.
- Linked category pages organized by the job solved; multiple categories are allowed.
- Source video records and evidence links.
- Separate dated comparisons and assessment history.
- Clearly marked generated sections and preserved personal annotation sections.
- User annotations, adoption decisions, and experience inform later audits.
- A dashboard for new reports, promising build ideas, changed recommendations, and items needing evidence.
- Repeated coverage without new information stays out of the main reading queue.

## First-version acceptance

Validate on three user-selected videos before enabling ongoing monitoring. Demonstrate:

1. Usable Obsidian reports with linked evidence and categories.
2. Recognition of repeated products without duplicate notes.
3. Comparison of relevant alternatives using current evidence, including uncertainty.
4. A sourced build-versus-buy recommendation for the user's practical need.
5. Preservation of personal annotations across report refreshes.
6. Visible blocked or failed items rather than fabricated audits.

Reports should support a decision without requiring the user to watch every source video.

## Configuration and verification remaining

Select initial channels and three trial videos, choose the vault destination, inspect available runtime resources, and verify a supported analysis workflow using the existing subscription with no extra paid usage. These are implementation inputs, not assumed facts.
