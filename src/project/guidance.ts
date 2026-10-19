export const generatedGuidance = `<!-- fleur:generated:start version=0.1.0 -->
# Fleur 0.1.0 project

Fleur prepares an environment for an existing coding agent. It does not launch or manage agents.
Use client/ for interactive Preact islands, server/ for server code and shared/ for browser-safe contracts. Assets belong in assets/. Keep secrets in server-only configuration.
Use only Fleur-approved imports and fixed dependencies. Suggest additional packages with the need and existing alternatives; do not install them or edit protected manifests, locks or tooling. Use Tailwind utilities and documented inline styles/CSS variables. Do not author stylesheets or load external JavaScript.
Server components and operations are the default. Validate public inputs and outputs. Browser data requests must use Fleur operations. Database changes require reviewed migrations and explicit destructive authority; never reset development data to fix a test.
Read .agents/skills/fleur-tdd/SKILL.md before changing testable behavior. Use disposable test data and independent review for substantial work.
This creation release supplies the project layout and pinned tooling. Application APIs, lifecycle and database commands are not implemented by this slice; do not invent working APIs or claim a running application.
<!-- fleur:generated:end -->
`;
export const tddGuidance = `---
name: fleur-tdd
description: Requirements-based Fleur test-first development.
---

Agree observable behavior, acceptance criteria and public test boundaries before implementation. Follow red then green: demonstrate the intended failing behavior, implement the smallest correction, and verify it. Do not weaken assertions or skip failures.
Use Bun tests, positive/negative compiler fixtures, real uniquely owned disposable PostgreSQL for database behavior and browser verification for key flows. Never use development data as test data. Keep application agents within the fixed approved imports and dependencies; do not install packages or author stylesheets.
Repeat timing and network-sensitive checks. Substantial changes need an independent reviewer. Report checks actually executed and remaining limitations. The creation slice does not yet supply application runtime or lifecycle/verification commands.
`;
