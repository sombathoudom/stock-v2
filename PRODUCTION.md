# ===========================================
# DolyOutfits POS - Complete Production Guide
# ===========================================

## Environment Variables Summary

### 1. Dokploy Environment Variables
Set these in Dokploy → Your App → Environment Variables:

```bash
# Required
NEXT_PUBLIC_APP_URL=http://15.235.143.107:7000
NEXT_PUBLIC_CONVEX_URL=https://your-app.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://your-app.convex.site
APP_PORT=7000

# Optional (for better debugging)
NODE_ENV=production
```

### 2. Convex Environment Variables
Set these in Convex Dashboard → Settings → Environment Variables:

```bash
# Required for authentication
SITE_URL=http://15.235.143.107:7000

# Optional (if you add email verification)
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=your-email@gmail.com
# SMTP_PASS=your-app-password
```

## Complete Setup Checklist

### Step 1: Get Convex URLs
1. Go to [Convex Dashboard](https://dashboard.convex.dev)
2. Select your project
3. Go to Settings → URL
4. Copy:
   - `https://your-app.convex.cloud` (for NEXT_PUBLIC_CONVEX_URL)
   - `https://your-app.convex.site` (for NEXT_PUBLIC_CONVEX_SITE_URL)

### Step 2: Set Convex Environment Variables
In Convex Dashboard → Settings → Environment Variables:
```
SITE_URL = http://15.235.143.107:7000
```

### Step 3: Set Dokploy Environment Variables
In Dokploy → Your App → Environment Variables:
```
NEXT_PUBLIC_APP_URL = http://15.235.143.107:7000
NEXT_PUBLIC_CONVEX_URL = https://your-app.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL = https://your-app.convex.site
APP_PORT = 7000
```

### Step 4: Deploy
1. Push your code to GitHub
2. In Dokploy, click "Deploy"
3. Wait for build to complete
4. Test your application

## Environment Variables Reference

| Variable | Set In | Description | Example |
|----------|--------|-------------|---------|
| `NEXT_PUBLIC_APP_URL` | Dokploy | Your app's public URL | `http://15.235.143.107:7000` |
| `NEXT_PUBLIC_CONVEX_URL` | Dokploy | Convex deployment URL | `https://my-app.convex.cloud` |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Dokploy | Convex site URL | `https://my-app.convex.site` |
| `APP_PORT` | Dokploy | Container port | `7000` |
| `SITE_URL` | Convex | Auth origin validation | `http://15.235.143.107:7000` |
| `NODE_ENV` | Dokploy | Environment mode | `production` |

## Troubleshooting

### 403 Forbidden Error
- Check `SITE_URL` is set in Convex Dashboard
- Check `NEXT_PUBLIC_APP_URL` matches your actual URL
- Ensure no trailing slash in URLs

### Build Fails
- Check all `NEXT_PUBLIC_*` variables are set in Dokploy
- Verify Convex URLs are correct

### Authentication Issues
- Clear browser cookies
- Check Convex environment variables
- Verify `SITE_URL` matches `NEXT_PUBLIC_APP_URL`

## Production Checklist

- [ ] Convex project created
- [ ] Convex URLs copied
- [ ] `SITE_URL` set in Convex Dashboard
- [ ] Dokploy application created
- [ ] All environment variables set in Dokploy
- [ ] Domain/IP configured
- [ ] SSL certificate (if using HTTPS)
- [ ] First deployment successful
- [ ] Test user registration
- [ ] Test login
- [ ] Test basic functionality

## Security Notes

1. **Never commit `.env` files** - they contain secrets
2. **Use HTTPS in production** - configure SSL in Dokploy
3. **Regular backups** - Convex handles database backups
4. **Monitor logs** - check Dokploy and Convex dashboards

## Support

- **Dokploy Issues**: Check Dokploy documentation
- **Convex Issues**: Check Convex documentation
- **Application Issues**: Check application logs in Dokploy