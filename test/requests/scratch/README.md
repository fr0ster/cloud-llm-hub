# Scratch Directory for Testing

This directory is for temporary test files that you can modify without saving to Git.

## Usage

1. **Copy a template** from `../templates/` directory:
   ```bash
   cp ../templates/local-template.http ./my-test.http
   ```

2. **Modify the file** as needed for your testing

3. **Test your requests** using VS Code REST Client extension

4. **Files are ignored by Git** - they won't be committed

## Example

```bash
# Copy local template
cp ../templates/local-template.http ./test-local.http

# Edit and test
# File won't be saved to Git history
```

## Available Templates

- `../templates/local-template.http` - Local development testing
- `../templates/cloud-template.http` - Cloud (BTP) testing

