# WhatsApp MCP Server (TypeScript/Baileys)
[![smithery badge](https://smithery.ai/badge/@jlucaso1/whatsapp-mcp-ts)](https://smithery.ai/server/@jlucaso1/whatsapp-mcp-ts)

This is a Model Context Protocol (MCP) server for WhatsApp, built with TypeScript and using the `@whiskeysockets/baileys` library.

It allows you to connect your personal WhatsApp account to an AI agent (like Anthropic Claude via its desktop app or Cursor) enabling it to:

* Search your personal WhatsApp messages.
* Search your contacts (individuals, not groups).
* List your recent chats.
* Retrieve message history for specific chats.
* Send messages to individuals or groups.

It connects directly to your **personal WhatsApp account** using the WhatsApp Web multi-device API. All your messages and authentication details are stored **locally** in a SQLite database (`./data/`) and authentication cache (`./auth_info/`). Data is only sent to the connected AI agent when it explicitly uses the provided MCP tools (which you control via the agent's interface).

*(Optional: Consider adding a screenshot or GIF similar to the reference example here)*

## Example

**User:**
Send a whatsapp message to "Meu amor" in whatsapp saying "Te amo"

---

**Assistant:**
Okay, I need to find the contact first.
*Using tool: `whatsapp.search_contacts`*
```json
{
  "query": "Meu amor"
}
```

---

**Tool Result:**
```json
[
  {
    "jid": "5599xxxxxx@s.whatsapp.net",
    "name": "Meu Amor"
  }
]
```

---

**Assistant:**
Found the contact. Now sending the message.
*Using tool: `whatsapp.send_message`*
```json
{
  "recipient": "5599xxxxxx@s.whatsapp.net",
  "message": "Te amo"
}
```

---

**Tool Result:**
```text
Message sent successfully to 5599xxxxxx@s.whatsapp.net (ID: XXXXXXXXXXX).
```

## Key Features (MCP Tools)

The server exposes the following tools to the connected AI agent:

* `search_contacts`: Search for contacts by name or phone number part (JID).
* `list_messages`: Retrieve message history for a specific chat, with pagination.
* `list_chats`: List your chats, sortable by activity or name, filterable, paginated, optionally includes last message details.
* `get_chat`: Get detailed information about a specific chat.
* `get_message_context`: Retrieve messages sent immediately before and after a specific message ID for context.
* `send_message`: Send a text message to a specified recipient JID (user or group).

## Installation

### Installing via Smithery

To install WhatsApp MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@jlucaso1/whatsapp-mcp-ts):

```bash
npx -y @smithery/cli install @jlucaso1/whatsapp-mcp-ts --client claude
```

### Prerequisites

* **Node.js:** Version 23.10.0 or higher (as specified in `package.json`). You can check your version with `node -v`. (Has initial typescript and sqlite builtin support)
* **npm** (or yarn/pnpm): Usually comes with Node.js.
* **AI Client:** Anthropic Claude Desktop app, Cursor, Cline or Roo Code (or another MCP-compatible client).

### Steps

1.  **Clone this repository:**
    ```bash
    git clone <your-repo-url> whatsapp-mcp-ts
    cd whatsapp-mcp-ts
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # or yarn install / pnpm install
    ```

3.  **Run the server for the first time:**
    Use `node` to run the main script directly.
    ```bash
    node src/main.ts
    ```
    * The first time you run it, it will likely generate a QR code link using `quickchart.io` and attempt to open it in your default browser.
    * Scan this QR code using your WhatsApp mobile app (Settings > Linked Devices > Link a Device).
    * Authentication credentials will be saved locally in the `auth_info/` directory (this is ignored by git).
    * Messages will start syncing and be stored in `./data/whatsapp.db`. This might take some time depending on your history size. Check the `wa-logs.txt` and console output for progress.
    * Keep this terminal window running. After syncing you can close.

## Configuration for AI Client

You need to tell your AI client how to start this MCP server.

1.  **Prepare the configuration JSON:**
    Copy the following JSON structure. You'll need to replace `{{PATH_TO_REPO}}` with the **absolute path** to the directory where you cloned this repository.

    ```json
    {
      "mcpServers": {
        "whatsapp": {
          "command": "node",
          "args": [
            "{{PATH_TO_REPO}}/src/main.ts"
          ],
          "timeout": 15, // Optional: Adjust startup timeout if needed
          "disabled": false
        }
      }
    }
    ```
    * **Get the absolute path:** Navigate to the `whatsapp-mcp-ts` directory in your terminal and run `pwd`. Use this output for `{{PATH_TO_REPO}}`.

2.  **Save the configuration file:**
    * For **Claude Desktop:** Save the JSON as `claude_desktop_config.json` in its configuration directory:
        * macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
        * Windows: `%APPDATA%\Claude\claude_desktop_config.json` (Likely path, verify if needed)
        * Linux: `~/.config/Claude/claude_desktop_config.json` (Likely path, verify if needed)
    * For **Cursor:** Save the JSON as `mcp.json` in its configuration directory:
        * `~/.cursor/mcp.json`

3.  **Restart Claude Desktop / Cursor:**
    Close and reopen your AI client. It should now detect the "whatsapp" MCP server and allow you to use its tools.

## Usage

Once the server is running (either manually via `node src/main.ts` or started by the AI client via the config file) and connected to your AI client, you can interact with your WhatsApp data through the agent's chat interface. Ask it to search contacts, list recent chats, read messages, or send messages.

## Architecture Overview

This application is a single Node.js process that:

1.  Uses `@whiskeysockets/baileys` to connect to the WhatsApp Web API, handling authentication and real-time events.
2.  Stores WhatsApp chats and messages locally in a SQLite database (`./data/whatsapp.db`) using `node:sqlite`.
3.  Runs an MCP server using `@modelcontextprotocol/sdk` that listens for requests from an AI client over standard input/output (stdio).
4.  Provides MCP tools that query the local SQLite database or use the Baileys socket to send messages.
5.  Uses `pino` for logging activity (`wa-logs.txt` for WhatsApp events, `mcp-logs.txt` for MCP server activity).

## Data Storage & Privacy

* **Authentication:** Your WhatsApp connection credentials are stored locally in the `./auth_info/` directory.
* **Messages & Chats:** Your message history and chat metadata are stored locally in the `./data/whatsapp.db` SQLite file.
* **Local Data:** Both `auth_info/` and `data/` are included in `.gitignore` to prevent accidental commits. **Treat these directories as sensitive.**
* **LLM Interaction:** Data is only sent to the connected Large Language Model (LLM) when the AI agent actively uses one of the provided MCP tools (e.g., `list_messages`, `send_message`). The server itself does not proactively send your data anywhere else.

## Technical Details

* **Language:** TypeScript
* **Runtime:** Node.js (>= v23.10.0)
* **WhatsApp API:** `@whiskeysockets/baileys`
* **MCP SDK:** `@modelcontextprotocol/sdk`
* **Database:** `node:sqlite` (Bundled SQLite)
* **Logging:** `pino`
* **Schema Validation:** `zod` (for MCP tool inputs)

## Troubleshooting

* **QR Code Issues:**
    * If the QR code link doesn't open automatically, check the console output for the `quickchart.io` URL and open it manually.
    * Ensure you scan the QR code promptly with your phone's WhatsApp app.
* **Authentication Failures / Logged Out:**
    * If the connection closes with a `DisconnectReason.loggedOut` error, you need to re-authenticate. Stop the server, delete the `./auth_info/` directory, and restart the server (`node src/main.ts`) to get a new QR code.
* **Message Sync Issues:**
    * Initial sync can take time. Check `wa-logs.txt` for activity.
    * If messages seem out of sync or missing, you might need a full reset. Stop the server, delete **both** `./auth_info/` and `./data/` directories, then restart the server to re-authenticate and resync history.
* **MCP Connection Problems (Claude/Cursor):**
    * Double-check the `command` and `args` (especially the `{{PATH_TO_REPO}}`) in your `claude_desktop_config.json` or `mcp.json`. Ensure the path is absolute and correct.
    * Verify Node.js are correctly installed and in your system's PATH.
    * Check the AI client's logs for errors related to starting the MCP server.
    * Check this server's logs (`mcp-logs.txt`) for MCP-related errors.
* **Errors Sending Messages:**
    * Ensure the recipient JID is correct (e.g., `number@s.whatsapp.net` for users, `groupid@g.us` for groups).
    * Check `wa-logs.txt` for specific errors from Baileys.
* **General Issues:** Check both `wa-logs.txt` and `mcp-logs.txt` for detailed error messages.

For further MCP integration issues, refer to the [official MCP documentation](https://modelcontextprotocol.io/quickstart/server#claude-for-desktop-integration-issues).

## Credits

- https://github.com/lharries/whatsapp-mcp Do the same as this codebase but uses go and python.

## License

This project is licensed under the ISC License (see `package.json`).
