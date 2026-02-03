# Falck Configuration Specification

Version: 1.0

A configuration format for defining how web applications should be installed, configured, and launched in the GitGUI application. Falck configurations live in a `.falck` directory at the root of the repository.

---

## Overview

Falck enables non-technical users to:
- Automatically check system prerequisites
- Install application dependencies
- Configure environment variables and secrets
- Launch applications with proper process management
- Access running applications via browser

The configuration is **language-agnostic** and supports any web framework (Node.js, Python, Go, Rust, etc.) through shell commands.

---

## Configuration File

**Location:** `.falck/config.yaml`

```yaml
version: "1.0"

metadata:
  name: "My Application"
  description: "Brief description of what this does"
  author: "Your Name"

repository:
  default_branch: "main"
  protect_default_branch: true
  branch_prefix: "projects/"

applications:
  - id: "backend"
    name: "API Server"
    type: "web"
    description: "Express.js REST API"
    root: "./backend"
    
    prerequisites:
      - type: "runtime"
        name: "Node.js"
        command: "node --version"
        version: "18.0.0"
        install_url: "https://nodejs.org"
        install:
          instructions: "Install Node.js 18+ before continuing."
          options:
            - name: "Homebrew (macOS)"
              command: "brew install node@18"
              only_if: "os == 'macos'"
            - name: "Scripted installer"
              command: "./scripts/install-node.sh"
        install:
          instructions:
            - "Install Node.js 18+ before running setup."
          options:
            - name: "Homebrew (macOS)"
              command: "brew install node@18"
              only_if: "os == 'macos'"
            - name: "nvm (cross-platform)"
              command: "nvm install 18 && nvm use 18"
            - name: "Scripted installer"
              command: "./scripts/install-node.sh"
    
    secrets:
      - name: "DATABASE_URL"
        description: "PostgreSQL connection string"
        required: true
      - name: "JWT_SECRET"
        description: "Secret key for JWT tokens"
        required: true
      - name: "OPTIONAL_API_KEY"
        required: false
    
    setup:
      steps:
        - name: "Install Dependencies"
          command: "npm install"
          timeout: 300
          description: "Install npm packages"
        
        - name: "Run Database Migrations"
          command: "npm run migrate"
          timeout: 60
          optional: true
          description: "Initialize database schema"
    
    launch:
      command: "npm start"
      description: "Start the API server"
      timeout: 30
      env:
        NODE_ENV: "development"
        PORT: "3001"
      access:
        type: "http"
        url: "http://localhost:3001"
        port: 3001
        open_browser: false

  - id: "frontend"
    name: "React App"
    type: "web"
    root: "./frontend"
    
    prerequisites:
      - type: "runtime"
        name: "Node.js"
        command: "node --version"
        version: "18.0.0"
        install_url: "https://nodejs.org"
    
    setup:
      steps:
        - name: "Install Dependencies"
          command: "npm install"
          timeout: 300
    
    launch:
      command: "npm run dev"
      description: "Start development server"
      timeout: 30
      access:
        type: "http"
        url: "http://localhost:3000"
        port: 3000
        open_browser: true

install_order:
  - "backend"
  - "frontend"

launch_order:
  - "backend"
  - "frontend"

groups:
  - name: "Development"
    apps:
      - "frontend"
      - "backend"
```

---

## Schema Reference

### Root Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | ✓ | Configuration version (currently "1.0") |
| `metadata` | object | ✗ | Repository and configuration metadata |
| `repository` | object | ✗ | Repository settings for version control features |
| `applications` | array | ✓ | List of applications to manage |
| `global_env` | object | ✗ | Global environment variables for all apps |
| `install_order` | array | ✗ | Order to run setup for applications |
| `launch_order` | array | ✗ | Recommended order to launch applications |
| `groups` | array | ✗ | Logical grouping of applications for UI |

### Metadata Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✗ | Application name |
| `description` | string | ✗ | Human-readable description |
| `author` | string | ✗ | Configuration author |
| `created` | string | ✗ | ISO 8601 creation timestamp |
| `updated` | string | ✗ | ISO 8601 last update timestamp |

### Repository Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default_branch` | string | ✗ | Branch to treat as the default (used as the base for projects and history) |
| `protect_default_branch` | boolean | ✗ | Prevent Falck from pushing to the default branch (default: false) |
| `branch_prefix` | string | ✗ | Prefix to apply to all branches created by Falck (for example "projects/") |

### Application Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique application identifier (kebab-case) |
| `name` | string | ✓ | Display name for the application |
| `type` | string | ✓ | Application type (currently "web") |
| `description` | string | ✗ | What this application does |
| `root` | string | ✓ | Relative path to application root (use "." for repo root) |
| `prerequisites` | array | ✗ | System requirements to check |
| `secrets` | array | ✗ | Secret environment variables to prompt for |
| `setup` | object | ✗ | Setup/installation configuration |
| `launch` | object | ✓ | How to launch the application |
| `cleanup` | object | ✗ | Cleanup commands when stopping |

### Prerequisite Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✓ | "runtime", "package_manager", "binary", or "service" |
| `name` | string | ✓ | Display name |
| `command` | string | ✓ | Shell command to check if installed |
| `version` | string | ✗ | Minimum required version (semver) |
| `install_url` | string | ✗ | URL to download/install |
| `install` | object | ✗ | Install instructions and runnable install options |
| `optional` | boolean | ✗ | Whether this is optional (default: false) |

### Prerequisite Install Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instructions` | string or array | ✗ | Human-readable install guidance to show in the UI |
| `options` | array | ✗ | Install options that can be run as commands/scripts |

### Prerequisite Install Option Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Display name for the option |
| `command` | string | ✓ | Shell command to install (can call a script like `./scripts/install-node.sh`) |
| `description` | string | ✗ | What this option does |
| `timeout` | integer | ✗ | Maximum seconds to wait (default: 300) |
| `silent` | boolean | ✗ | Whether to suppress output (default: false) |
| `only_if` | string | ✗ | Conditional execution (e.g., "os == 'macos'") |

### Secret Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Environment variable name (UPPER_SNAKE_CASE) |
| `description` | string | ✓ | Human-readable description of what this secret is |
| `required` | boolean | ✓ | Whether this must be provided |

### Setup Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `steps` | array | ✗ | List of setup commands to execute |
| `check` | object | ✗ | Command used to validate if setup is complete |

### Setup Step Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Display name of the step |
| `command` | string | ✓ | Shell command to execute |
| `description` | string | ✗ | What this step does (for UI display) |
| `timeout` | integer | ✗ | Maximum seconds to wait (default: 300) |
| `silent` | boolean | ✗ | Whether to suppress output (default: false) |
| `optional` | boolean | ✗ | Whether to skip on failure (default: false) |
| `only_if` | string | ✗ | Conditional execution (e.g., "os == 'macos'") |

### Setup Check Object

The setup check command should exit with status `0` when setup is complete and a non-zero status otherwise.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | ✓ | Shell command to check setup completion |
| `description` | string | ✗ | What the check validates (for UI display) |
| `timeout` | integer | ✗ | Maximum seconds to wait (default: 30) |
| `silent` | boolean | ✗ | Whether to suppress output (default: true) |
| `only_if` | string | ✗ | Conditional execution (e.g., "os == 'macos'") |
| `expect` | string | ✗ | Exact output match (after trimming if `trim` is true) |
| `expect_contains` | string | ✗ | Output must contain this substring |
| `expect_regex` | string | ✗ | Output must match this regex |
| `output` | string | ✗ | Which stream to compare: `stdout`, `stderr`, or `combined` (default: `stdout`) |
| `trim` | boolean | ✗ | Trim output before comparison (default: true) |
| `ignore_exit` | boolean | ✗ | If true, evaluate output even when exit status is non-zero (default: false) |

If any `expect*` field is provided, Falck compares the selected output stream against that expectation and marks setup complete only when it matches.

If configured, Falck uses the setup check during setup validation to determine whether the app is ready to launch.

### Launch Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | ✓ | Shell command to launch the application |
| `description` | string | ✗ | What launching this application does |
| `timeout` | integer | ✗ | Seconds to wait for app to start (default: 30) |
| `env` | object | ✗ | Environment variables specific to this app |
| `ports` | array | ✗ | Ports the application will use |
| `access` | object | ✗ | How to access the running application |

### Access Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✓ | "http", "https", or "custom" |
| `url` | string | ✗ | Full URL to access (e.g., "http://localhost:3000") |
| `port` | integer | ✗ | Port number the application listens on |
| `open_browser` | boolean | ✗ | Auto-open in browser when launched (default: false) |
| `ready_signal` | string | ✗ | Text to wait for in logs indicating app is ready |

### Cleanup Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `steps` | array | ✗ | List of cleanup commands to execute on stop |

### Cleanup Step Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Display name of the step |
| `command` | string | ✓ | Shell command to execute |
| `description` | string | ✗ | What this step does |
| `timeout` | integer | ✗ | Maximum seconds to wait (default: 30) |

### App Group Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Group display name |
| `apps` | array | ✓ | List of application IDs in this group |

---

## Template Variables

Template variables can be used in commands and environment variables. They're replaced at runtime.

### Built-in Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{ repo_root }}` | Absolute path to repository root | `/Users/dev/my-app` |
| `{{ app_root }}` | Absolute path to application root | `/Users/dev/my-app/backend` |
| `{{ os }}` | Operating system | `macos`, `linux`, `windows` |
| `{{ arch }}` | System architecture | `x86_64`, `arm64` |
| `{{ system.user }}` | Current username | `john_doe` |
| `{{ system.shell }}` | User's shell | `/bin/bash` |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `{{ env.VAR_NAME }}` | Reference any environment variable |

### Example Usage

```yaml
launch:
  command: "NODE_ENV=production node {{ app_root }}/dist/server.js"
  env:
    DATABASE_URL: "postgresql://localhost/{{ system.user }}_db"
    LOG_PATH: "{{ repo_root }}/logs"
```

---

## Conditional Execution

The `only_if` field supports conditions to make setup steps, setup checks, prerequisite install options, and cleanup steps conditional.

### Operators

- `==` - Equals
- `!=` - Not equals
- `>` - Greater than (for numeric values)
- `<` - Less than (for numeric values)
- `>=` - Greater than or equal
- `<=` - Less than or equal
- `&&` - Logical AND
- `||` - Logical OR
- `!` - Logical NOT
- `contains` - String contains

### Examples

```yaml
setup:
  steps:
    - name: "Install with Homebrew"
      command: "brew install postgres"
      only_if: "os == 'macos'"
    
    - name: "Install with apt"
      command: "sudo apt install postgresql"
      only_if: "os == 'linux'"
    
    - name: "Create Windows Service"
      command: "pg_ctl register -N postgresql -D 'C:\\postgres\\data'"
      only_if: "os == 'windows'"
    
    - name: "Run seed script"
      command: "npm run seed"
      only_if: "env.NODE_ENV == 'development' && os != 'windows'"
```

---

## Examples

### Example 1: Simple React App

```yaml
version: "1.0"

metadata:
  name: "Todo App"
  description: "A simple todo list application"

applications:
  - id: "frontend"
    name: "React Frontend"
    type: "web"
    root: "."
    
    prerequisites:
      - type: "runtime"
        name: "Node.js"
        command: "node --version"
        version: "18.0.0"
        install_url: "https://nodejs.org"
    
    setup:
      steps:
        - name: "Install Dependencies"
          command: "npm install"
          timeout: 300
      check:
        command: "node -e \"console.log(require('fs').existsSync('node_modules'))\""
        expect: "true"
        description: "Node modules installed"
    
    launch:
      command: "npm start"
      access:
        type: "http"
        url: "http://localhost:3000"
        port: 3000
        open_browser: true
```

### Example 2: Full-Stack Application with Secrets

```yaml
version: "1.0"

metadata:
  name: "Full Stack App"
  description: "React frontend + Node.js backend + PostgreSQL"

applications:
  - id: "database"
    name: "PostgreSQL"
    type: "web"
    root: "."
    
    prerequisites:
      - type: "binary"
        name: "PostgreSQL"
        command: "psql --version"
        version: "12.0"
        install_url: "https://www.postgresql.org/download/"
    
    secrets:
      - name: "POSTGRES_PASSWORD"
        description: "Database admin password"
        required: true
    
    launch:
      command: "postgres -D /usr/local/var/postgres"
      access:
        type: "custom"
        url: "postgresql://localhost:5432"
        port: 5432
  
  - id: "backend"
    name: "API Server"
    type: "web"
    root: "./server"
    
    prerequisites:
      - type: "runtime"
        name: "Node.js"
        command: "node --version"
        version: "18.0.0"
        install_url: "https://nodejs.org"
    
    secrets:
      - name: "DATABASE_URL"
        description: "PostgreSQL connection string"
        required: true
      - name: "JWT_SECRET"
        description: "Secret key for JWT signing"
        required: true
      - name: "CORS_ORIGIN"
        description: "Allowed CORS origin"
        required: false
    
    setup:
      steps:
        - name: "Install Dependencies"
          command: "npm install"
          timeout: 300
        
        - name: "Run Migrations"
          command: "npm run migrate"
          timeout: 60
    
    launch:
      command: "npm start"
      timeout: 30
      env:
        NODE_ENV: "development"
        PORT: "3001"
      access:
        type: "http"
        url: "http://localhost:3001"
        port: 3001
  
  - id: "frontend"
    name: "React App"
    type: "web"
    root: "./client"
    
    prerequisites:
      - type: "runtime"
        name: "Node.js"
        command: "node --version"
        version: "18.0.0"
        install_url: "https://nodejs.org"
    
    setup:
      steps:
        - name: "Install Dependencies"
          command: "npm install"
          timeout: 300
    
    launch:
      command: "npm start"
      timeout: 30
      env:
        REACT_APP_API_URL: "http://localhost:3001"
      access:
        type: "http"
        url: "http://localhost:3000"
        port: 3000
        open_browser: true

install_order:
  - "backend"
  - "frontend"

launch_order:
  - "database"
  - "backend"
  - "frontend"
```

### Example 3: Multi-Language Monorepo

```yaml
version: "1.0"

metadata:
  name: "Microservices Platform"
  description: "Multiple services in different languages"

applications:
  - id: "api-go"
    name: "Go API"
    type: "web"
    root: "./services/api-go"
    
    prerequisites:
      - type: "runtime"
        name: "Go"
        command: "go version"
        version: "1.20.0"
        install_url: "https://golang.org/dl/"
    
    setup:
      steps:
        - name: "Download Dependencies"
          command: "go mod download"
    
    launch:
      command: "go run main.go"
      access:
        type: "http"
        url: "http://localhost:8080"
        port: 8080
  
  - id: "worker-python"
    name: "Python Worker"
    type: "web"
    root: "./services/worker-python"
    
    prerequisites:
      - type: "runtime"
        name: "Python"
        command: "python3 --version"
        version: "3.9.0"
        install_url: "https://www.python.org/downloads/"
    
    setup:
      steps:
        - name: "Install Dependencies"
          command: "pip install -r requirements.txt"
    
    secrets:
      - name: "REDIS_URL"
        description: "Redis connection URL"
        required: true
    
    launch:
      command: "python3 worker.py"
  
  - id: "web-rust"
    name: "Rust Web Server"
    type: "web"
    root: "./services/web-rust"
    
    prerequisites:
      - type: "runtime"
        name: "Rust"
        command: "rustc --version"
        version: "1.70.0"
        install_url: "https://rustup.rs/"
    
    setup:
      steps:
        - name: "Build Project"
          command: "cargo build --release"
          timeout: 600
    
    launch:
      command: "cargo run --release"
      env:
        RUST_LOG: "info"
      access:
        type: "http"
        url: "http://localhost:8000"
        port: 8000

groups:
  - name: "Services"
    apps:
      - "api-go"
      - "worker-python"
      - "web-rust"

launch_order:
  - "api-go"
  - "worker-python"
  - "web-rust"
```

---

## Best Practices

### Configuration Guidelines

1. **Use meaningful IDs**: IDs should be lowercase, hyphenated, and describe the application (e.g., `api-server`, not `app1`)

2. **Provide descriptions**: Always include `description` fields to help users understand what each app does

3. **Specify timeouts**: Set realistic timeouts for setup and launch to catch hanging processes

4. **Use install/launch order**: Help users understand dependencies between applications

5. **Keep paths relative**: Use relative paths for `root` to keep configs portable

6. **Group related apps**: Use `groups` to organize UI when you have many applications

7. **Document secrets**: Write clear descriptions for secrets so users know what values to provide

8. **Make prerequisites optional when possible**: Use `optional: true` for nice-to-have tools

9. **Provide install options**: Add `install.options` with commands/scripts whenever possible and use `only_if` for OS-specific installers

10. **Provide install URLs**: Always include download links for required prerequisites

11. **Test on target platforms**: If supporting multiple OSes, test conditional steps with `only_if`

### Environment Variable Best Practices

1. **Use uppercase with underscores**: `DATABASE_URL`, not `database_url`

2. **Be specific**: Prefer `POSTGRES_CONNECTION_STRING` over `DB_URL`

3. **Document in description**: Explain what format or values are expected

4. **Use sensible defaults**: If a value has a common default, consider not making it a secret

5. **Group related secrets**: Put related database credentials together in the config

---

## Migration & Versioning

Currently, only version "1.0" is supported. Future versions will be introduced for breaking changes to the configuration format.

To upgrade when new versions are released:
1. Update the `version` field in `.falck/config.yaml`
2. Follow the migration guide in the release notes
3. Test thoroughly before deploying

---

## File Organization

```
my-repo/
├── .falck/
│   └── config.yaml          # Main configuration
├── backend/
│   ├── package.json
│   └── src/
├── frontend/
│   ├── package.json
│   └── src/
└── README.md
```

The `.falck` directory should be committed to version control so that users who clone the repository automatically get the configuration.
