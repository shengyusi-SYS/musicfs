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

## Design and verification

- [Dependencies and trade-offs](dependencies.md)
- [Compatibility and verification scope](verification.md)
- [Detailed Chinese architecture index](../architecture/README.md)
- [Specialist checks, Chinese](../development-reference.md)
- [Architecture decisions](../adr/)
- [Engineering lessons, Chinese](../engineering-lessons.md)

Current designs live in `architecture/`, important decisions in `adr/`, specialist references in `research/`, and reusable lessons in `lessons/`. Earlier plans, raw test receipts and development screenshots remain in Git history.
