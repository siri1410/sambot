# Deploy Moltbot on Railway

This guide covers deploying Moltbot gateway on [Railway](https://railway.app).

## Prerequisites

- A Railway account
- A GitHub repository with Moltbot code (or this repository)
- API keys for your AI provider (Anthropic, OpenAI, etc.)

## Quick Start

### 1. Create a New Project

1. Log in to [Railway](https://railway.app)
2. Click **New Project**
3. Select **Deploy from GitHub repo**
4. Connect your GitHub account and select the Moltbot repository

### 2. Configure Environment Variables

In your Railway service settings, add the following environment variables:

#### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `CLAWDBOT_GATEWAY_TOKEN` | Gateway authentication token (generate a secure random string) | `your-secure-token-here` |

#### AI Provider Keys (at least one required)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google Gemini API key |

#### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAWDBOT_GATEWAY_PORT` | Override the gateway port (Railway provides `$PORT` automatically) | Uses `$PORT` from Railway |
| `CLAWDBOT_STATE_DIR` | State directory for persistent data | `/data/.clawdbot` |
| `NODE_ENV` | Node environment | `production` |

### 3. Set Up Persistent Storage (Recommended)

Moltbot stores session data, configuration, and logs that should persist across deployments.

1. In your Railway project, click **Add** > **Volume**
2. Name it `moltbot-data`
3. Set the mount path to `/data`
4. Add environment variable: `CLAWDBOT_STATE_DIR=/data/.clawdbot`

### 4. Deploy

Railway will automatically build and deploy when you:
- Push to your connected GitHub branch
- Click **Deploy** in the Railway dashboard

## Build Configuration

The deployment uses the project's `Dockerfile` for building. The configuration in `railway.json` and `railway.toml` specifies:

- **Builder**: Dockerfile
- **Start Command**: `node dist/index.js gateway --port $PORT --bind lan --allow-unconfigured`
- **Health Check**: `GET /health` (returns `{"status":"ok","timestamp":"..."}`)

### Health Check Endpoints

The gateway exposes HTTP health check endpoints for load balancers and PaaS platforms:

- `GET /health` - Primary health check endpoint
- `GET /healthz` - Kubernetes-style health check
- `GET /api/health` - Alternative API-style endpoint

All endpoints return:
```json
{"status":"ok","timestamp":"2026-01-29T12:00:00.000Z"}
```

## Connecting to Your Gateway

Once deployed, Railway provides a public URL for your service. Use this URL to connect clients to your Moltbot gateway.

### Get Your Service URL

1. Go to your Railway project
2. Click on your Moltbot service
3. Go to **Settings** > **Networking**
4. Copy the **Public URL** (e.g., `moltbot-production.up.railway.app`)

### Connect via WebSocket

Clients connect to your gateway via WebSocket at:
```
wss://your-service.up.railway.app/ws
```

Include authentication in your connection:
```javascript
const ws = new WebSocket('wss://your-service.up.railway.app/ws', {
  // Include auth token in connection params
});
ws.send(JSON.stringify({
  type: 'connect',
  params: {
    auth: { token: 'your-gateway-token' }
  }
}));
```

## Custom Domain (Optional)

1. In Railway, go to **Settings** > **Networking** > **Custom Domain**
2. Add your domain (e.g., `gateway.yourdomain.com`)
3. Configure DNS with the provided CNAME record

## Environment-Specific Configuration

### Development vs Production

For a development environment, you may want different settings:

```bash
# Development
NODE_ENV=development
CLAWDBOT_GATEWAY_TOKEN=dev-token

# Production
NODE_ENV=production
CLAWDBOT_GATEWAY_TOKEN=<secure-random-token>
```

## Monitoring and Logs

### View Logs

1. Go to your Railway project
2. Click on your Moltbot service
3. Click **Deployments** to see deployment logs
4. Click **View Logs** for runtime logs

### Health Monitoring

Railway automatically monitors the `/health` endpoint. You can also:
- Use the WebSocket-based health API for detailed status
- Set up external monitoring tools (Uptime Robot, Pingdom, etc.)

## Troubleshooting

### Common Issues

#### Build Fails

- Ensure Node.js version is 22+ (the Dockerfile uses `node:22-bookworm`)
- Check that `pnpm-lock.yaml` is committed to the repository
- Verify the Dockerfile builds locally: `docker build -t moltbot .`

#### Gateway Won't Start

- Verify `CLAWDBOT_GATEWAY_TOKEN` is set when using `--bind lan`
- Check logs for specific error messages
- Ensure the `PORT` environment variable is being passed correctly

#### Connection Refused

- Ensure the service is deployed and running
- Verify the correct URL and port
- Check that authentication token matches
- Test the health endpoint: `curl https://your-service.up.railway.app/health`

#### Health Check Fails

- The gateway may take a few seconds to start; increase `healthcheckTimeout` if needed
- Check that port binding is correct (`--bind lan` for external access)

### Reset State

If you need to reset the gateway state:

1. Delete the volume contents or create a new volume
2. Redeploy the service

## Cost Optimization

Railway offers a free tier with limited resources. For production use:

- **Hobby Plan**: Good for personal projects
- **Pro Plan**: Better for production workloads

Tips to reduce costs:
- Use Railway's sleep feature for development environments
- Monitor resource usage in the Railway dashboard

## GitHub Auto-Deploy

Railway can automatically deploy when you push to GitHub:

1. Connect your GitHub repository
2. Select the branch to watch (e.g., `main`)
3. Enable **Auto Deploy** in service settings

Each push to the selected branch triggers a new deployment.

## Alternative: Manual Deployment

If you prefer manual control:

1. Install the Railway CLI: `npm install -g @railway/cli`
2. Log in: `railway login`
3. Link your project: `railway link`
4. Deploy: `railway up`

## Alternative: Nixpacks Build

If you prefer Nixpacks over Dockerfile, modify `railway.toml`:

```toml
[build]
builder = "nixpacks"
buildCommand = "pnpm install --frozen-lockfile && pnpm build && pnpm ui:install && pnpm ui:build"

[deploy]
startCommand = "node dist/index.js gateway --port $PORT --bind lan --allow-unconfigured"
healthcheckPath = "/health"
healthcheckTimeout = 300
```

## Security Best Practices

1. **Use strong tokens**: Generate secure random strings for `CLAWDBOT_GATEWAY_TOKEN`
   ```bash
   openssl rand -base64 32
   ```
2. **Enable HTTPS**: Railway provides HTTPS by default
3. **Limit access**: Use allowlists if you need to restrict who can connect
4. **Rotate tokens**: Periodically update your gateway token
5. **Monitor logs**: Regularly check logs for suspicious activity

## Related Documentation

- [Moltbot Configuration](https://docs.molt.bot/configuration)
- [Gateway Setup](https://docs.molt.bot/gateway)
- [Railway Documentation](https://docs.railway.app)
