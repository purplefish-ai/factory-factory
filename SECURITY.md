# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Factory Factory, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues by emailing martin@purplefish.com or opening a private security advisory on GitHub.

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (if you have them)

### Response Timeline

- We will acknowledge receipt of your report within 48 hours
- We will provide a detailed response within 7 days
- We will work with you to understand and resolve the issue

## Security Considerations

Factory Factory runs locally on your machine and interacts with:

- **Local file system**: Git worktrees and project files
- **Claude Code CLI**: External process for AI chat
- **GitHub CLI**: For repository operations
- **Local SQLite database**: Session and workspace data

### Best Practices

1. **Keep dependencies updated**: Run `pnpm update` regularly
2. **Review Claude Code permissions**: Factory Factory inherits Claude Code's access
3. **Protect your database**: The SQLite database contains session history
4. **Network exposure**: By default, the server binds to localhost only

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Updates

Security updates will be released as patch versions. We recommend staying up to date with the latest release.
