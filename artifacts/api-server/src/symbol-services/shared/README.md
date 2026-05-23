# Symbol Services Shared Contract Layer

This folder defines shared contracts and runtime-flow helpers for symbol services.

V3.2 scope:

- Shared contracts and helper types are allowed here.
- Shared worker, allocator, persistence, and operational utilities are allowed here.
- Route ownership and synthesis orchestration should remain service-specific where behavior differs by service.
- The shared layer must not encode symbol-specific strategy beliefs.

Active services must fail loudly when required promoted runtime fields are missing rather than falling back to another service's rules.
