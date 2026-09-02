# Dokploy Deployment Guide

This guide explains how to deploy the DolyOutfits POS application using Dokploy.

## Prerequisites

1. A server with Dokploy installed
2. Your Convex deployment URL (from Convex dashboard)
3. Your domain name (optional but recommended)

## Deployment Steps

### 1. Prepare Environment Variables

You'll need the following environment variables:

```bash
# Required
NEXT_PUBLIC_CONVEX_URL=https://your-convex-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://your-convex-deployment.convex.site
NEXT_PUBLIC_APP_URL=https://your-domain.com

# Optional (for Convex authentication)
CONVEX_DEPLOY_KEY=your-deploy-key
```

### 2. Deploy with Dokploy

#### Option A: Using Docker Compose (Recommended)

1. **Create a new application in Dokploy:**
   - Go to Dokploy Dashboard → Applications → Create Application
   - Choose "Docker Compose" as the source

2. **Connect your Git repository:**
   - Add your Git repository URL
   - Set the branch to deploy (e.g., `main`)

3. **Configure environment variables:**
   - Add all required environment variables in Dokploy's environment section

4. **Deploy:**
   - Click "Deploy" to start the deployment
   - Dokploy will automatically build and deploy your application

#### Option B: Using Dockerfile

1. **Create a new application in Dokploy:**
   - Go to Dokploy Dashboard → Applications → Create Application
   - Choose "Dockerfile" as the source

2. **Connect your Git repository:**
   - Add your Git repository URL
   - Set the branch to deploy (e.g., `main`)

3. **Configure build arguments:**
   - Add build arguments for environment variables that need to be available during build:
     - `NEXT_PUBLIC_CONVEX_URL`
     - `NEXT_PUBLIC_APP_URL`

4. **Configure environment variables:**
   - Add runtime environment variables

5. **Deploy:**
   - Click "Deploy" to start the deployment

### 3. Domain Configuration

1. **Add your domain in Dokploy:**
   - Go to your application → Domains
   - Add your domain name
   - Configure SSL (Let's Encrypt is recommended)

2. **Update DNS:**
   - Point your domain to your Dokploy server's IP address

### 4. Convex Configuration

Since Convex is a separate backend service, you need to:

1. **Deploy your Convex functions:**
   ```bash
   npx convex deploy
   ```

2. **Get your Convex deployment URL:**
   - Go to Convex Dashboard → Settings → URL
   - Copy the deployment URL

3. **Set environment variables:**
   - Add `NEXT_PUBLIC_CONVEX_URL` in Dokploy

### 5. Post-Deployment

1. **Verify the deployment:**
   - Check the application logs in Dokploy
   - Test the application functionality

2. **Set up monitoring:**
   - Configure health checks (already included in Dockerfile)
   - Set up alerts if needed

## Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_CONVEX_URL` | Your Convex deployment URL | Yes |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Your Convex site URL | Yes |
| `NEXT_PUBLIC_APP_URL` | Your application URL | Yes |
| `CONVEX_DEPLOY_KEY` | Convex deploy key (for CI/CD) | No |

## Troubleshooting

### Build Failures

1. **Check build logs:**
   - Go to your application → Builds
   - Check the build logs for errors

2. **Common issues:**
   - Missing environment variables
   - Node.js version compatibility
   - Dependency installation failures

### Runtime Issues

1. **Check application logs:**
   - Go to your application → Logs
   - Check for runtime errors

2. **Common issues:**
   - Convex connection issues
   - Missing environment variables
   - Port conflicts

### Performance Optimization

1. **Enable caching:**
   - Dokploy supports build cache
   - Enable it in application settings

2. **Resource limits:**
   - Set appropriate CPU and memory limits
   - Monitor resource usage

## Updates and Maintenance

### Updating the Application

1. **Push changes to your repository**
2. **Trigger a new deployment in Dokploy**
3. **Verify the update**

### Database Backups

Since Convex handles the database, backups are managed by Convex. However, you should:

1. **Regularly export data using the backup feature**
2. **Test restore procedures**

## Security Considerations

1. **Environment Variables:**
   - Never commit sensitive values to Git
   - Use Dokploy's environment variable management

2. **Network Security:**
   - Configure firewall rules
   - Use HTTPS only

3. **Access Control:**
   - Limit Dokploy access to authorized users
   - Use strong passwords

## Support

For issues with:
- **Dokploy:** Check Dokploy documentation
- **Convex:** Check Convex documentation
- **Application:** Check application logs and Convex dashboard