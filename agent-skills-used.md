# Agent Skills Used

The `.claude/skills/` folder (gitignored) holds the Claude Code agent skills available during this project. Each skill is a markdown instruction set the agent loads on demand to enforce a discipline or workflow.

## Central to k0

- **k0-design-skill** — the project's own design system and philosophy: Vercel's Geist language translated for k0. Governs *all* k0 code, not just UI — latency budgets, streaming, durable state, provenance chrome, color-step semantics, typography, motion, and voice. 

- **frontend-design** — produces distinctive, production-grade frontend interfaces and avoids generic AI-generated aesthetics. 

- **web-design-guidelines** — audits UI code against Web Interface Guidelines: accessibility, focus states, motion preferences, semantics.

## Vercel engineering practice

- **vercel-react-best-practices** — React/Next.js performance rules from Vercel Engineering (rendering, re-renders, bundle, data fetching); applies as the POC grows into a Next.js app.
- **vercel-composition-patterns** — scalable React composition patterns: compound components, avoiding boolean-prop proliferation, React 19 API changes.

## General tooling (not k0-specific)

- **skill-creator** — scaffolding, evals, and benchmarking for authoring skills; used to build and refine `k0-design-skill`.
- **aggressive-dep-updater** — updates all npm/pnpm dependencies to latest majors and fixes the resulting breakage.
- **mburry** — forensic, primary-source, adversarial research discipline for deep audits and stress-testing claims.
