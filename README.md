# Falck

Falck is a local-first AI IDE/desktop app that helps non-technical teammates contribute to real codebases with guardrails, setup guidance, and friendly Git workflows. The desktop app reads a `.falck/config.yaml` file in a repo to understand prerequisites, secrets, setup steps, and launch commands.

## Repository layout

- `desktop/` - Tauri + React desktop app
- `website/` - Astro marketing site
- `falck-spec.md` - Falck configuration specification

## Prerequisites

- Bun
- Rust toolchain + Tauri system dependencies (see https://tauri.app/v2/guides/prerequisites/)

## Install dependencies

```sh
bun install
```

## Run the desktop app

```sh
bun run desktop:dev
```

Build a production app bundle:

```sh
bun run desktop:build
```

## Run the website

```sh
bun run website:dev
```

Build the static site:

```sh
bun run website:build
```

## Create a Falck config

1. Create a `.falck` directory in the repo you want Falck to manage.
2. Add `.falck/config.yaml` and commit it.
3. Follow the specification in `falck-spec.md`.

Minimal example:

```yaml
version: "1.0"

metadata:
  name: "My App"
  description: "Example Falck configuration"

applications:
  - id: "web"
    name: "Web App"
    type: "web"
    root: "."
    setup:
      steps:
        - name: "Install dependencies"
          command: "bun install"
    launch:
      command: "bun run dev"
      access:
        type: "http"
        url: "http://localhost:3000"
        port: 3000
```

Once the config is in place, open the repo in Falck and use the setup/launch actions to run the apps defined in the configuration.
