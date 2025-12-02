# Contributing to Cloud LLM Hub

Thank you for your interest in contributing to Cloud LLM Hub! 🎉

This document provides guidelines and instructions for contributing to the project.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Making Changes](#making-changes)
- [Submitting Changes](#submitting-changes)
- [Code Style](#code-style)
- [Testing](#testing)
- [Documentation](#documentation)
- [Questions?](#questions)

## 🤝 Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on constructive feedback
- Respect different viewpoints and experiences

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and npm
- **Git** for version control
- **SAP BTP account** (for deployment testing, optional)
- Basic knowledge of TypeScript, Node.js, and SAP CAP

### Initial Setup

1. **Fork the repository** on GitHub
2. **Clone your fork:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/cloud-llm-hub.git
   cd cloud-llm-hub
   ```
3. **Add upstream remote:**
   ```bash
   git remote add upstream https://github.com/fr0ster/cloud-llm-hub.git
   ```
4. **Install dependencies:**
   ```bash
   npm install
   ```
5. **Initialize submodules:**
   ```bash
   git submodule update --init --recursive
   ```
6. **Start development server:**
   ```bash
   cds watch --profile development
   ```

**Detailed setup instructions:** See [docs/contributors/SETUP.md](docs/contributors/SETUP.md)

## 🔄 Development Workflow

### Standard Workflow (Fork → Branch → PR)

1. **Fork the repository** on GitHub (if you haven't already)

2. **Create a branch** from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-name
   ```

3. **Make your changes** and commit them:

   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

4. **Push to your fork:**

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create a Pull Request** on GitHub:
   - Go to the original repository
   - Click "New Pull Request"
   - Select your fork and branch
   - Fill out the PR template
   - Submit the PR

**Important:** Always branch from `main` and target `main` in your PR.

**Detailed workflow:** See [docs/contributors/WORKFLOW.md](docs/contributors/WORKFLOW.md)

## ✏️ Making Changes

### Before You Start

1. **Check existing issues** - Your idea might already be discussed
2. **Create an issue first** for significant changes
3. **Ask questions** if unsure about the approach

### Types of Contributions

- 🐛 **Bug fixes** - Fix issues in existing code
- ✨ **New features** - Add new functionality
- 📚 **Documentation** - Improve docs, examples, guides
- 🧪 **Tests** - Add or improve tests
- 🎨 **Code quality** - Refactoring, style improvements
- 🌐 **Translations** - Add or improve translations

### Code Style

- **TypeScript** - Follow existing code style
- **Formatting** - Use consistent indentation (2 spaces)
- **Naming** - Use descriptive names (camelCase for variables, PascalCase for classes)
- **Comments** - Add comments for complex logic
- **Imports** - Organize imports (external → internal)

**Detailed guidelines:** See [docs/contributors/CODE_STYLE.md](docs/contributors/CODE_STYLE.md)

## 🧪 Testing

### Running Tests

```bash
# Integration tests (requires test/integration.yaml)
npm test

# Type checking
npm run type-check

# Smoke tests
cd test/smoke && ./run-all.sh
```

### Writing Tests

- Add tests for new features
- Ensure existing tests pass
- Test edge cases and error handling
- Update tests when fixing bugs

**Testing guidelines:** See [docs/contributors/TESTING.md](docs/contributors/TESTING.md)

## 📝 Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Test changes
- `chore`: Build/tooling changes

**Examples:**

```
feat(proxy): add SSE heartbeat support
fix(manager): handle session expiration correctly
docs: update getting started guide
test: add integration tests for streaming endpoints
```

## 📚 Documentation

- Update documentation when adding features
- Add examples for new functionality
- Keep API documentation current
- Write clear, concise descriptions

**Documentation structure:** See [docs/contributors/](docs/contributors/)

## 🔍 Pull Request Process

### Before Submitting

- [ ] Code follows style guidelines
- [ ] Tests pass locally
- [ ] Documentation is updated
- [ ] Commit messages follow conventions
- [ ] Branch is up to date with `main`

### PR Template

When creating a PR, include:

- **Description** - What changes and why
- **Type** - Bug fix, feature, docs, etc.
- **Testing** - How you tested the changes
- **Checklist** - Confirm all items are done

### Review Process

1. **Automated checks** - CI/CD runs automatically
2. **Code review** - Maintainers review your PR
3. **Feedback** - Address any requested changes
4. **Approval** - Once approved, PR will be merged

**Be patient** - Reviewers may need time. We appreciate your contribution! 🙏

## 🏗️ Project Structure

Understanding the codebase:

- `srv/` - Service implementation (TypeScript)
- `tools/` - Utility scripts
- `test/` - Test scripts
- `docs/` - Documentation
- `submodules/` - External dependencies (git submodules)

**Architecture overview:** See [docs/contributors/ARCHITECTURE.md](docs/contributors/ARCHITECTURE.md)

## ❓ Questions?

- **GitHub Issues** - For bugs and feature requests
- **Discussions** - For questions and discussions
- **Documentation** - Check `docs/contributors/` for detailed guides

## 🙏 Thank You!

Your contributions make Cloud LLM Hub better for everyone. Thank you for taking the time to contribute! 🎉

---

**Need more details?** Check the [contributors documentation](docs/contributors/) for comprehensive guides.
