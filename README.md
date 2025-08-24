# CSG Portal MCP Server

MCP Server for Columbus School for Girls (CSG) Veracross portal integration.

## Features

- **Encrypted Credential Storage**: Securely stores login credentials locally
- **Session Management**: Maintains authenticated sessions with cookie handling
- **Directory Search**: Search the school directory with various filters
- **Extensible Architecture**: Ready for additional tools (calendar, schedule, lunch menu)

## Installation

```bash
npm install
npm run build
```

## Configuration

Set the Veracross base URL (optional, defaults to CSG portal):

```bash
export VERACROSS_BASE_URL="https://portals.veracross.com/csg"
```

## Available Tools

### `login`
Login to Veracross portal with username and password. Credentials are encrypted and stored locally.

Parameters:
- `username` (required): Veracross username
- `password` (required): Veracross password

### `directory_search`
Search the school directory for students, parents, and staff.

Parameters (all optional):
- `firstName`: First name to search for
- `lastName`: Last name to search for
- `city`: City to search for
- `postalCode`: Postal code to search for
- `gradeLevel`: Grade level to search for

### `logout`
Logout from Veracross portal and clear the current session.

### `clear_credentials`
Clear stored login credentials from local storage.

## Usage with Claude

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "csg-portal": {
      "command": "node",
      "args": ["/path/to/csg-portal-mcp/dist/index.js"]
    }
  }
}
```

## Future Tools

The architecture supports easy addition of:
- **Calendar Tools**: Access calendar events via JSON API
- **Schedule Tools**: Daily student schedule scraping
- **Lunch Menu Tools**: Lunch menu via JSON API (no auth required)

## Security

- Credentials are encrypted using AES-256-CBC
- Encryption key is stored separately from credentials
- File permissions are set to 600 (owner read/write only)
- Session cookies are handled securely