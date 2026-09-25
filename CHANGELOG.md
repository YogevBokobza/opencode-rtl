# Changelog

## Unreleased

### Fixed

- OpenCode V2 can load the package root and server entrypoint. The V2 adapter registers RTL guidance, user-context isolation, optional tool-result formatting, and shell environment hooks. V1 server behavior is retained.
- Local development configuration loads the compiled plugin from `./dist`.

### Compatibility

- V2 has no post-generation assistant-text hook. Assistant output formatting and the V1 TUI commands are not supported on V2. See the README for supported options.
