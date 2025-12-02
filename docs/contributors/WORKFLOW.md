# Git Workflow Guide

Standard workflow for contributing to Cloud LLM Hub.

## 🔄 Overview

We use a **Fork → Branch → Pull Request** workflow:

1. **Fork** the repository
2. **Create a branch** from `main`
3. **Make changes** and commit
4. **Push** to your fork
5. **Create Pull Request** to upstream

## 📋 Step-by-Step Workflow

### 1. Fork the Repository

**On GitHub:**

1. Go to https://github.com/fr0ster/cloud-llm-hub
2. Click "Fork" button
3. Choose your account/organization

**Result:** You have `https://github.com/YOUR_USERNAME/cloud-llm-hub`

### 2. Clone Your Fork

```bash
git clone https://github.com/YOUR_USERNAME/cloud-llm-hub.git
cd cloud-llm-hub
```

### 3. Add Upstream Remote

```bash
git remote add upstream https://github.com/fr0ster/cloud-llm-hub.git

# Verify remotes
git remote -v
# Should show:
# origin    https://github.com/YOUR_USERNAME/cloud-llm-hub.git (fetch)
# origin    https://github.com/YOUR_USERNAME/cloud-llm-hub.git (push)
# upstream  https://github.com/fr0ster/cloud-llm-hub.git (fetch)
# upstream  https://github.com/fr0ster/cloud-llm-hub.git (push)
```

### 4. Keep Your Fork Updated

**Before starting new work, sync with upstream:**

```bash
# Fetch upstream changes
git fetch upstream

# Switch to main branch
git checkout main

# Merge upstream/main
git merge upstream/main

# Push to your fork
git push origin main
```

**Regular sync:** Do this weekly or before starting new work.

### 5. Create a Branch

**Always create a new branch for your changes:**

```bash
# Switch to main (make sure it's up to date)
git checkout main
git pull origin main

# Create and switch to new branch
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-name
# or
git checkout -b docs/update-readme
```

**Branch naming conventions:**

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation
- `refactor/` - Code refactoring
- `test/` - Test additions/changes
- `chore/` - Build/tooling changes

**Examples:**

- `feature/add-sse-heartbeat`
- `fix/session-timeout-handling`
- `docs/update-contributing-guide`

### 6. Make Your Changes

**Edit files, write code, update documentation:**

```bash
# Make changes to files
# ... edit files ...

# Stage changes
git add .

# Or stage specific files
git add path/to/file.ts
```

### 7. Commit Changes

**Follow [Conventional Commits](https://www.conventionalcommits.org/):**

```bash
git commit -m "feat(proxy): add SSE heartbeat support"
```

**Commit message format:**

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:**

- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `style` - Formatting
- `refactor` - Code refactoring
- `test` - Tests
- `chore` - Build/tooling

**Examples:**

```bash
git commit -m "feat(proxy): add SSE heartbeat support"
git commit -m "fix(manager): handle session expiration"
git commit -m "docs: update getting started guide"
git commit -m "test: add integration tests for streaming"
```

### 8. Push to Your Fork

```bash
# Push branch to your fork
git push origin feature/your-feature-name

# If branch doesn't exist remotely, set upstream
git push -u origin feature/your-feature-name
```

### 9. Create Pull Request

**On GitHub:**

1. Go to https://github.com/fr0ster/cloud-llm-hub
2. Click "Pull requests" → "New pull request"
3. Click "compare across forks"
4. Select:
   - **Base:** `fr0ster/cloud-llm-hub` → `main`
   - **Compare:** `YOUR_USERNAME/cloud-llm-hub` → `feature/your-feature-name`
5. Fill out PR template:
   - **Title:** Clear, descriptive title
   - **Description:** What and why
   - **Type:** Bug fix, feature, docs, etc.
   - **Testing:** How you tested
6. Click "Create pull request"

### 10. Address Review Feedback

**If changes are requested:**

```bash
# Make additional changes
git add .
git commit -m "fix: address review feedback"
git push origin feature/your-feature-name
```

**PR will update automatically** - no need to create a new PR.

### 11. After Merge

**Clean up your fork:**

```bash
# Switch to main
git checkout main

# Pull latest from upstream
git fetch upstream
git merge upstream/main

# Delete local branch (optional)
git branch -d feature/your-feature-name

# Delete remote branch (optional)
git push origin --delete feature/your-feature-name
```

## 🔀 Branching Strategy

### Main Branch

- `main` - Production-ready code
- Always stable and deployable
- Protected branch (requires PR)

### Feature Branches

- Branch from `main`
- One feature per branch
- Target `main` in PR
- Delete after merge

### Naming

- Use descriptive names
- Include type prefix (`feature/`, `fix/`, etc.)
- Use kebab-case
- Keep names short but clear

**Good:**

- `feature/add-destination-probe`
- `fix/session-timeout`
- `docs/contributor-guide`

**Bad:**

- `my-changes`
- `fix`
- `feature_add_something`

## 📝 Commit Best Practices

### Atomic Commits

- One logical change per commit
- Commit frequently (after each small change)
- Keep commits focused

### Good Commit Messages

```
feat(proxy): add SSE heartbeat support

- Add heartbeat every 15 seconds
- Implement auto-reconnect logic
- Update documentation

Closes #123
```

### Bad Commit Messages

```
fix stuff
update
changes
WIP
```

## 🚫 What NOT to Do

### ❌ Don't Commit to Main

```bash
# ❌ WRONG
git checkout main
git commit -m "fix: something"
git push origin main

# ✅ CORRECT
git checkout -b fix/something
git commit -m "fix: something"
git push origin fix/something
# Then create PR
```

### ❌ Don't Force Push to Main

```bash
# ❌ NEVER
git push --force origin main

# ✅ Only force push to your feature branches (if needed)
git push --force origin feature/your-branch
```

### ❌ Don't Merge Upstream Main into Your Branch

```bash
# ❌ AVOID
git checkout feature/your-branch
git merge upstream/main

# ✅ PREFERRED: Rebase (if needed)
git rebase upstream/main
```

### ❌ Don't Create PRs from Main Branch

Always create a feature branch first.

## 🔄 Updating Your Branch

### If Upstream Has New Changes

**Option 1: Rebase (preferred for feature branches)**

```bash
# Fetch upstream
git fetch upstream

# Rebase your branch on upstream/main
git checkout feature/your-branch
git rebase upstream/main

# Force push (safe for feature branches)
git push --force origin feature/your-branch
```

**Option 2: Merge (if rebase is complex)**

```bash
git fetch upstream
git checkout feature/your-branch
git merge upstream/main
git push origin feature/your-branch
```

## 📚 Additional Resources

- [GitHub Forking Guide](https://guides.github.com/activities/forking/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Git Workflow Best Practices](https://www.atlassian.com/git/tutorials/comparing-workflows)

## ❓ FAQ

**Q: Can I create multiple PRs from the same fork?**  
A: Yes! Create separate branches for each PR.

**Q: How do I update my PR after creating it?**  
A: Just push more commits to the same branch. The PR updates automatically.

**Q: Can I close my PR?**  
A: Yes, you can close it anytime. Closed PRs can be reopened.

**Q: What if I made a mistake in my PR?**  
A: Push fixes to the same branch. The PR will update.

---

**Questions?** Open an issue or check other contributor guides!
