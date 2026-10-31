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

**New development database**:
A development database Fleur created for a storage binding that has provably never been initialized. It stays new across development startups until initialization succeeds. A database that merely contains no data, or that held data before, is not new.

**Agent query role**:
The PostgreSQL role, provisioned by Fleur in its development cluster, under which agent-written SQL runs. It can read application tables and nothing else. Fleur-generated SQL never runs under it.

**Fleur setup grant**:
A human authorization for a named prerequisite setup action and installation method, valid once or remembered for one OS user on one machine. It grants no authority to application handlers.

**Machine tool**:
Software the developer supplies on their own machine and Fleur only checks: Bun, Docker components, the operating system release and kernel. Fleur never installs, upgrades or embeds a machine tool.

**Release pin**:
An exact, immutable version or digest that a Fleur release owns and ships: container image digests, lockfiles, the application dependency set and the Fleur version a generated project records. Release pins are not machine tool requirements.

**Version floor**:
The lowest version of a machine tool a Fleur release admits. The floor is the version the release was measured with; equal or newer versions are admitted, older versions refuse.
