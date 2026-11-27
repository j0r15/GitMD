# Gitea Integration for Renovate

This `.gitea` directory provides RenovateBot integration for automatic dependency management with Gitea.

## 📦 What's Included

### Workflows
- **`workflows/renovate.yml`** - Main Renovate workflow for Gitea
- **`workflows/go-deps.yml`** - Go module dependency checks
- **`workflows/docker-update.yml`** - Docker base image checks
- **`workflows/hugo-update.yml`** - Hugo version checks
- **`workflows/gitea-hooks.yml`** - Webhook configuration

### Configuration
- **`renovate-config.yml`** - Gitea-specific Renovate configuration
- **`scripts/run-renovate.sh`** - Helper script to run Renovate

### Hooks
- **`hooks/post-receive`** - Post-receive hook to trigger Renovate on push

## 🚀 Quick Start

### 1. Configure Environment Variables

Edit `.env` or set these in Gitea settings:

```bash
export GITEA_SERVER=https://your-gitea-server.com
export GITEA_USER=your-username
export GITEA_REPO=gitmd
export GITEA_TOKEN=your-token
export GITEA_EMAIL=your-email@example.com
```

### 2. Create a Gitea Webhook

Go to **Settings → Webhooks** in your Gitea repo:

1. Add webhook URL: `https://<your-server>/api/v1/repos/<user>/<repo>/hooks/renovate`
2. Set token: `renovate-secret`
3. Set secret: `renovate-secret`
4. Add events: `push`

### 3. Run the First Scan

```bash
# Install Renovate
npm install -g renovate

# Run the scan
cd .gitea/scripts
./run-renovate.sh
```

### 4. Set Up Post-Receive Hook (Optional)

The `hooks/post-receive` script automatically triggers Renovate on push.

**Enable in Gitea:**
1. Go to **Settings → Repositories → Git Hooks**
2. Enable **Post-receive**
3. Copy the hook script content

## 📅 Schedule

- **Go Dependencies**: Check every Wednesday at midnight
- **Docker Images**: Check every Monday at midnight
- **Hugo Version**: Check every Tuesday at midnight
- **General Renovate**: Check every Sunday at midnight

## 🏷️ Labels

All Renovate PRs will be labeled with:
- `renovate`
- `dependencies`

## 📋 Managed Dependencies

The configuration automatically tracks:

- **Go modules** (`go.mod`/`go.sum`)
- **Docker base images**:
  - `golang:1.23-alpine`
  - `alpine:3.20`
- **Hugo**: `0.170.0` (from `Dockerfile`)
- **Vulnerability alerts**: Enabled

## 🔧 Auto-Merge Settings

By default, Renovate will:
- Auto-merge minor/patch updates (`automerge: true`)
- Use fast-track merging (`automergeType: fast-track`)
- Auto-merge on the platform (`platformAutomerge: true`)

## 📝 Example

After pushing an update to `go.mod`:

```bash
git add go.mod go.sum
git commit -m "chore: update go.mod"
git push
```

Renovate will automatically:
1. Scan `go.mod` for outdated dependencies
2. Create a PR with suggested updates
3. Auto-merge if using the default config

## 🎯 Customization

### Change Schedule

Edit `workflows/renovate.yml`:

```yaml
schedule:
  - cron: '0 8 * * 1'  # Every Monday at 8 AM
```

### Disable Auto-Merge

Edit `renovate.json`:

```json
{
  "packageRules": [
    {
      "matchManagers": ["go-modules"],
      "automerge": false  // Disable auto-merge
    }
  ]
}
```

### Add Custom Dependencies

Add to `renovate.json`:

```json
{
  "packageRules": [
    {
      "matchManagers": ["npm"],
      "packagePatterns": ["*"],  // Also check npm packages
      "automerge": true
    }
  ]
}
```

## 🔗 References

- [Renovate Documentation](https://docs.renovatebot.com/)
- [Renovate Gitea Manager](https://docs.renovatebot.com/modules/platform/gitea/)
- [Renovate Dockerfile Manager](https://docs.renovatebot.com/modules/datasource/docker/)

## 📞 Support

For issues, check:
1. GitHub Actions/Gitea Actions logs
2. [Renovate Troubleshooting Guide](https://docs.renovatebot.com/troubleshooting/)
3. Gitea webhook settings

---

**Happy automating! 🎉**
