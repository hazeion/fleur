# Runtime heap preparation and verification

The AMD64 VFS worker in [CI 39292274975](https://github.com/hazeion/fleur/actions/runs/39292274975) exited with Docker status 139 before its operation deadline. The pidfd guard reported a premature physical exit, with the parent control channel still open. That establishes an actual worker failure; it does not identify the failing JSC call.

Bun 1.4.3 commit `c6da4a4d3010e5553438c60f6bd76d981976867c` pins WebKit `0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f`. Its compiler worklist uses automatic threads that stop after ten idle seconds and can restart when work arrives. Thread creation failure is fatal in that upstream implementation. Therefore warming the engine once does not guarantee that later compilation can reuse an existing thread. [Pinned worklist](https://github.com/oven-sh/WebKit/blob/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f/Source/JavaScriptCore/jit/JITWorklist.cpp), [thread lifetime](https://github.com/oven-sh/WebKit/blob/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f/Source/WTF/wtf/AutomaticThread.h), [thread creation](https://github.com/oven-sh/WebKit/blob/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f/Source/WTF/wtf/Threading.cpp).

The candidate worker configuration uses three supported settings consistently in the runtime and database-worker images:

- `BUN_JSC_useConcurrentJIT=0`: compile on the executing thread while keeping JIT tiers enabled.
- `BUN_JSC_numberOfGCMarkers=1`: use one GC marker.
- `BUN_JSC_useWarmUpMarkedBlocks=0`: omit the optional helper that prefaults heap blocks.

Bun itself pairs the first two settings for one-shot startup, and applies `BUN_JSC_` options before creating the VM. The block-prefault helper otherwise starts lazily after an allocation threshold. These source-supported settings are a compatibility candidate; native execution must establish whether they fix this failure. [Bun initialization](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/jsc/bindings/ZigGlobalObject.cpp), [WebKit options](https://github.com/oven-sh/WebKit/blob/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f/Source/JavaScriptCore/runtime/OptionsList.h).

After TSYNC, the host descriptor audit, and its acknowledgement, every Bun worker runs `verifyRetainedHeap`. Three bounded allocation rounds exercise six forced synchronous collections. Across those collections, 128 retained objects keep their identifiers, strings, and all bytes of their typed arrays. Their 16 KiB of retained buffers and identifier checksum 8128 are checked explicitly. Failure prevents application compilation/evaluation. Success emits the fixed GC verification marker before busy execution and supplies `runtime_gc_verified: true` with detailed counts in the healthy evidence frame. The database worker uses the same bootstrap and probe.

The original busy application, worker restrictions, resource profile, physical deadline, and late-termination tolerance stay intact. An additional delayed broker acknowledgement can stress compiler-thread idle retirement; it supplements the original concurrent lifecycle checks. Local Bun tests exercise the retained-heap function, while only native CI exercises it under the full worker restrictions. The GC and JIT runtime remain enabled.
