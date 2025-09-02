# Deploying CSG Portal MCP to Netlify

This guide explains how to deploy the CSG Portal MCP server to Netlify for use with Claude.ai's custom connector feature.

## Prerequisites

- A Netlify account (free tier works)
- A MongoDB database (MongoDB Atlas free tier recommended)
- Access to Columbus School for Girls Veracross portal

## Deployment Steps

### 1. Fork or Clone Repository

Fork this repository to your GitHub account or clone it locally.

### 2. Create MongoDB Database

1. Sign up for [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (free tier available)
2. Create a new cluster
3. Create a database called `csg_portal`
4. Get your connection string (looks like: `mongodb+srv://username:password@cluster.mongodb.net`)

### 3. Deploy to Netlify

#### Option A: Deploy with Netlify Button
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/bradgriffith/csg-portal-mcp)

#### Option B: Manual Deploy
1. Log in to [Netlify](https://app.netlify.com)
2. Click "Add new site" > "Import an existing project"
3. Connect your GitHub account and select the forked repository
4. Configure build settings:
   - Build command: `npm run build:netlify`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`

### 4. Configure Environment Variables

In Netlify dashboard, go to Site Settings > Environment Variables and add:

```bash
# Required
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net
MONGODB_DATABASE=csg_portal
ENCRYPTION_MASTER_KEY=your-secure-32-character-key-here

# Optional (defaults to CSG)
VERACROSS_BASE_URL=https://portals.veracross.com/csg
LS_LUNCH_SIGNUP_URL=https://www.signupgenius.com/go/10C084BADAA2BA2FFC43-57722061-lslunch#/
```

**Important:** Generate a secure `ENCRYPTION_MASTER_KEY`:
```bash
# Generate a secure key (run in terminal)
openssl rand -hex 32
```

### 5. Deploy Site

1. Click "Deploy site" in Netlify
2. Wait for the build to complete (usually 1-2 minutes)
3. Your site will be available at: `https://your-site-name.netlify.app`

### 6. Add to Claude.ai

1. Open [Claude.ai](https://claude.ai)
2. Go to Settings > Custom Connectors (or MCP Settings)
3. Click "Add Custom Connector"
4. Enter your Netlify URL: `https://your-site-name.netlify.app/.netlify/functions/mcp-api`
5. Save and enable the connector

## Using the Connector

Once connected to Claude.ai:

### First Time Setup
```
1. "Set me as the default user with email: your-email@example.com"
2. "Please log me in to the CSG portal"
3. Complete browser authentication
```

### Available Commands
- "Search for families with last name Smith"
- "What school events are coming up?"
- "Check lunch volunteer slots for this week"
- "Find all Form VI students"
- "Show me events in the next month"

## Security Considerations

- **Credentials**: Never stored in plain text, only encrypted session tokens
- **User Isolation**: Each user's data is isolated by email hash
- **MongoDB Security**: Use MongoDB Atlas with IP whitelist and strong passwords
- **HTTPS Only**: Netlify provides automatic SSL/TLS
- **Environment Variables**: Never commit sensitive keys to Git

## Troubleshooting

### "No user email provided"
- Set a default user first: "Set me as default user with email: your@email.com"

### "Authentication required"
- Log in first: "Please log me in to the CSG portal"

### MongoDB Connection Issues
- Check your `MONGODB_URI` is correct
- Ensure your IP is whitelisted in MongoDB Atlas
- Verify database name matches `MONGODB_DATABASE`

### Function Timeouts
- Netlify Functions have a 10-second timeout by default
- For production, consider upgrading to Netlify Pro for longer timeouts

## Updating

To update your deployment:

1. Pull latest changes from GitHub
2. Netlify will automatically rebuild and deploy
3. No action needed in Claude.ai

## Support

For issues or questions:
- GitHub Issues: [github.com/bradgriffith/csg-portal-mcp/issues](https://github.com/bradgriffith/csg-portal-mcp/issues)
- Email: brad@bradgriffith.com

**Note**: This is an unofficial project not supported by CSG IT.