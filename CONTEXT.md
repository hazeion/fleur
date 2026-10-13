# Fleur

Fleur provides a consistent application environment and development tools for coding agents building full-stack browser applications.

## Language

**Fleur application**:
A full-stack browser application authored within Fleur's supported application surface.

**Application agent**:
An existing coding agent that uses Fleur to develop a Fleur application.

**Fleur command**:
A named development operation supplied by Fleur for consistent use by humans and application agents.

**Approved application surface**:
The application APIs, dependencies, and styling capabilities supplied and supported by Fleur. Additional packages are suggestions for human consideration rather than agent-authorized additions.

**Fleur query**:
A named application operation with validated input and output that can read application data but cannot write it.

**Fleur mutation**:
A named application operation with validated input and output that can read and write application data within one atomic database transaction.

**Fleur page**:
A browser destination declared by a Fleur application through Fleur's supported routing API.

**Fleur retrieval**:
A validated server operation that retrieves external API data through Fleur's approved network capability, separately from database mutations.

**Fleur island**:
A browser-safe interactive component within a server-rendered Fleur page. It owns local interaction state and receives validated public data through Fleur.

**Fleur setup grant**:
A human authorization for a named prerequisite setup action and installation method, valid once or remembered for one OS user on one machine. It grants no authority to application handlers.
