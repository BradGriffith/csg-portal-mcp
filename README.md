# CSG Portal MCP Server

**⚠️ UNOFFICIAL PROJECT** - This is an unofficial, community-created MCP server for Columbus School for Girls Veracross portal integration. It is not affiliated with, endorsed by, or supported by Columbus School for Girls or Veracross.

**📋 REQUIREMENTS** - This server requires a valid Veracross portal user account (student, parent, or staff) with active access to the CSG portal at https://portals.veracross.com/csg

A Model Context Protocol (MCP) server that provides secure access to directory search, calendar events, and other school portal features through Claude Desktop and other MCP-compatible AI assistants.

## Features

- 🔐 **Secure Browser Authentication** - No credentials stored in Claude, login via your browser
- 📞 **Directory Search** - Find students, parents, and staff with contact information
- 📅 **Calendar Events** - Search upcoming school events and activities
- 👥 **Multi-User Support** - Isolated data storage per user
- ⚡ **Smart Caching** - 24-hour cache for improved performance
- 🏫 **CSG-Specific** - Tailored for Columbus School for Girls grade system (Forms I-XII)

## Installation

### For Claude Desktop Users

1. Install the MCP server globally:
```bash
npm install -g @bradgriffith/csg-portal-mcp
```

2. Add to your Claude Desktop MCP configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "csg-portal": {
      "command": "npx",
      "args": ["@bradgriffith/csg-portal-mcp@latest"]
    }
  }
}
```

3. Restart Claude Desktop

### Quick Start (No Installation)

You can also use it directly without installation:

```json
{
  "mcpServers": {
    "csg-portal": {
      "command": "npx",
      "args": ["@bradgriffith/csg-portal-mcp@latest"]
    }
  }
}
```

## Prerequisites

**🔑 Valid Veracross Account Required** - You must have an active Veracross account with access to the Columbus School for Girls portal. This includes:
- Current students with portal access
- Parents/guardians of current students
- Faculty and staff members
- Alumni (if they have retained portal access)

If you don't have access to the CSG Veracross portal, this server will not work for you.

## User Setup (Claude Desktop)

### First Time Setup

After installing the MCP server, you can start using it immediately! Just send prompts to Claude and include your email address.

1. **Authentication** (one-time setup):
   Simply ask Claude to authenticate you:
   ```
   "Please authenticate me with the CSG portal using my email: parent@example.com"
   ```
   - A web browser window will automatically open with a secure login form
   - Enter your regular CSG Veracross username and password
   - The page will show "Authentication successful!" when complete
   - The browser window will close automatically
   - Your credentials are never stored in Claude - only secure session tokens

2. **Set Default User** (optional but recommended):
   ```
   "Set me as the default user with email: parent@example.com"
   ```
   - This lets you make requests without including your email every time

### Example Prompts

Once authenticated, try these example prompts:

**Directory Search:**
```
"Find all families with the last name Johnson in the CSG directory"

"Search for parents in New Albany, Ohio"

"Find all students in Form VI"

"Look up contact information for families in the 43054 zip code"
```

**Calendar Events:**
```
"What school events are coming up in the next month?"

"Show me all upcoming Middle School events"

"Are there any events this week?"

"What's on the school calendar for the next 3 months?"
```

**User Management:**
```
"Check if I'm still authenticated with the CSG portal"

"Clear my stored credentials"
```

## Developer Setup

**Note**: End users don't need this section - it's only for developers who want to modify or contribute to the project.

### Required Environment Variables

Create a `.env` file or set environment variables:

```env
# MongoDB connection (required for production use)
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=csg_portal

# Encryption key for secure credential storage
ENCRYPTION_MASTER_KEY=your-secure-encryption-key-here

# Veracross portal URL (optional, defaults to CSG)
VERACROSS_BASE_URL=https://portals.veracross.com/csg
```

### MongoDB Setup

The server requires MongoDB for secure credential and cache storage:

1. **Local Development**: Install MongoDB locally
2. **Production**: Use MongoDB Atlas or similar cloud service

### Available Tools

#### `authenticate_browser`
Secure browser-based login to Veracross portal. No credentials are stored in Claude.

#### `directory_search`
Search the school directory for students, parents, and staff.
- **Parameters**: `firstName`, `lastName`, `city`, `postalCode`, `gradeLevel`
- **Grade Levels**: Use CSG format like "VI", "X", "3/4 Yr Olds", etc.

#### `upcoming_events`
Search for upcoming school calendar events.
- **Default**: Searches next 3 months
- **Auto-fallback**: Extends to 12 months if no events found
- **Parameters**: `searchMonths`, `refresh`

#### `set_default_user`
Set a default user email to avoid entering it repeatedly.

#### `check_authentication`
Verify if you have a valid stored authentication session.

## Security

- **No Credential Storage in Claude**: Authentication happens via secure browser flow
- **Encrypted Storage**: All credentials encrypted with AES-256-CBC
- **User Isolation**: Each user's data is completely isolated using email-based hashing
- **Environment Variables**: Sensitive configuration via environment variables only

## CSG Grade System

The server understands Columbus School for Girls' Form system:
- **PYC**: "3/4 Yr Olds", "4/5 Yr Olds"
- **Lower School**: Forms I, II, III, IV, V
- **Middle School**: Forms VI, VII, VIII  
- **Upper School**: Forms IX, X, XI, XII

## Development

### Local Development

```bash
# Clone and install
git clone https://github.com/bradgriffith/csg-portal-mcp.git
cd csg-portal-mcp
npm install

# Set up environment
cp .env.example .env
# Edit .env with your settings

# Build and run
npm run build
npm start
```

### Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### Common Issues

**"No user email provided"**
- Use `set_default_user` tool first, or provide `userEmail` parameter

**"Browser authentication required"**
- Use `authenticate_browser` tool to log in via your browser

**"Calendar search failed"**
- Check your authentication status with `check_authentication`
- Try the `refresh: true` parameter to bypass cache

**"Directory search failed"**
- Verify you're authenticated and have portal access
- Check that grade levels use correct CSG format

### Debug Mode

Set `NODE_ENV=development` for additional logging output.

## Disclaimer

This is an **unofficial project** created by a member of the CSG community. It is not affiliated with, endorsed by, or supported by:
- Columbus School for Girls
- Veracross, Inc.
- Anthropic (makers of Claude)

Use at your own discretion. The author is not responsible for any issues that may arise from using this software.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/bradgriffith/csg-portal-mcp/issues)
- **Email**: brad@bradgriffith.com

**Note**: For official CSG IT support, please contact the school directly. This unofficial project is not supported by CSG IT services.

---

Built by the CSG community, for the CSG community 🏫