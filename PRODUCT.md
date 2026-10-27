---
register: product
---

# Account Style Library Workbench

## Users

A single operator (and occasionally a few teammates) who collect high-performing Bilibili and Douyin content, maintain transcripts, distill account style cards, and generate copy from those references.

They use it in two modes:

- **At the Mac** (`127.0.0.1:3000`): long, focused sessions — collecting accounts, batch transcribing, editing style cards and drafts, maintaining gross-margin data.
- **Remotely** (`https://work.xjxwork.online`, mostly on a phone): short check-ins — scanning the hotlist, checking whether jobs finished, starting a quick draft, copying a result. The link goes through Cloudflare to the Mac, so every request costs roughly 0.5–2 s.

Users are task-oriented and often move between collection, transcription, style editing, drafting, and asset generation in one sitting. They need clear state, dense information, and safe local-file behavior more than marketing flourish.

## Product Purpose

The product turns local files in `style-library` into a usable content operations system. It helps users:

- Discover what is performing now (video hotlist, hotspot radar).
- Collect account videos and source materials.
- Generate or edit transcripts and style cards.
- Draft copy in a reference account's style, plus comments and derivative images.
- Maintain and monitor gross-margin data.
- Publish selected output to Feishu when configured.

Removed: project workbench, project writing, and draft cover generation. Their historical data stays readable but gets no new entry points.

## Tone

Chinese UX copy should feel like a capable local tool: concise, specific, calm, and actionable. Name the next step instead of showing raw low-level errors. Avoid marketing language and vague success messages. Labels describe actions ("刷新日志"), not raw values (a timestamp as a button label).

## Strategic Principles

- **Protect local assets first.** Deletion, migration, and batch rewriting must be conservative, recoverable, and confirmed.
- **Content before controls.** Each page's first screen shows real content (ranked videos, the draft, job status), not a stack of toolbars. On a phone, the first item must be visible without scrolling.
- **Fast on a slow link.** Show cached or last-known data immediately and update in place. Send few requests, never fetch the same data twice in one visit, and keep heavy checks off the critical path. Perceived speed matters more than animation.
- **Dense on desktop, focused on mobile.** Desktop shows many rows and panes at once; mobile shows one task per screen and collapses secondary filters and actions.
- **Explicit state.** Prefer visible progress, selection, save, and connection states over passive text. Make fallback behavior visible and non-alarming.
- **Calm visuals.** Neutral by default; color is for status, motion is for explaining change. Details live in `DESIGN.md`.

## Constraints

- The public link currently has no login: anyone with the URL can view and operate the workbench on shared local data. New features must not assume a trusted viewer. Service-level and credential actions (service-mode switch, model sign-in, settings that hold secrets) are local-only; destructive actions stay recoverable and confirmed. Engineering rules for this live in `AGENTS.md`.
- The service runs on one Mac. When the Mac sleeps or the tunnel drops, the UI must say so clearly and keep what is already on screen.

## Anti-References

- Marketing landing-page composition and large decorative hero sections.
- Dark neon dashboards.
- Glassmorphism as a default surface treatment.
- Rainbow-colored data tiles that use status colors as decoration.
- Over-simplified empty screens that hide the next useful action.
- Full-page spinners that hide data the user already had.

## Related Documents

This file covers who the product is for and which trade-offs win. Visuals live in `DESIGN.md`, engineering rules and the document map in `AGENTS.md`, setup and deployment in `README.md`.
