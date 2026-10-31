"""Small stdio MCP server used by the integration tests; no file or shell access."""
from mcp.server.mcpserver import MCPServer

server = MCPServer('Steve test server')


@server.tool()
def add_numbers(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == '--http':
        server.run(transport='streamable-http', host='127.0.0.1', port=int(sys.argv[2]))
    else:
        server.run(transport='stdio')
