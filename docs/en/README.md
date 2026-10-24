# MusicFS documentation

[简体中文](../README.md)

Choose a path for your task. Guides follow current source; downloadable archives carry the docs matching their version.

## Use MusicFS

[Download](release.md) → [Add a source and browse](user-guide.md) → [Connect a player](clients.md)

- [Desktop, startup, mounts and backups](desktop.md)
- [NAS, SSH and foreground services](headless.md)
- [Deploy or upgrade a Worker](worker.md)

## Build a source plugin

[Author kit workflow](plugin-authoring.md) → [Public contract](plugin-interface.md) → [Exact types](../../packages/plugin-api/src/index.ts)

The kit includes a sample, public types and build tools. Users install its ZIP without rebuilding MusicFS.

## Develop MusicFS

[Set up and develop](development.md) → [Architecture](architecture.md) → [Management HTTP API](management-api.md)

Build and release steps are in the development guide. Native toolchains are described in the [desktop helper README](../../native/desktop/README.md).

## Detailed designs and records

The complete source package also contains the [Chinese topic index](../README.md): architecture diagrams, optional tagging, refresh and cache designs, UI decisions, ADRs and specialist verification tools. [Engineering lessons](../engineering-lessons.md) hold reusable conclusions; [verification](../verification.md) and [release history](../release-history.md) retain version-specific evidence.

All documentation lives under `docs/`: current designs in `architecture/`, plans and trade-offs in `planning/`, dependency research in `research/`, version evidence in `verification/`, and reusable lessons in `lessons/`.
